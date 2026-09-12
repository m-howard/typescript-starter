/**
 * Action references in the declared workflows.
 *
 * Two findings, from the same parse: an action behind its latest release
 * (`action-outdated`), and an action referenced by something mutable
 * (`action-unpinned`).
 *
 * References are grouped by repository rather than emitted per occurrence. The same
 * action appears in several jobs and several workflows, and one fingerprint per
 * repository is what makes that one unit of human work instead of five duplicate issues
 * (ADR-0003). Every occurrence still shows up, as evidence.
 */

import { CollectorError, Evidence, Finding, LatestResolution, Subject } from '../schema';
import { MaintenanceConfig } from '../schema/config';
import { Collector, CollectorContext, CollectorOutput } from '../types';
import {
    ActionReference,
    isFirstPartyAction,
    parseWorkflow,
    readVersionComment,
} from '../parsers/workflow-yaml';
import {
    ParsedVersion,
    VersionPrecision,
    parseVersionForComparison,
    versionPrecision,
} from '../version';
import { buildFinding, notApplicableResolution, resolutionFromSource } from './build-finding';
import { collectorSettings, toCollectorError } from './collector';
import { toMaintenanceError } from '../errors';
import * as semver from 'semver';

type GithubActionsSettings = NonNullable<MaintenanceConfig['collectors']['githubActions']>;

/** One action reference, with the version it declares worked out. */
interface Occurrence {
    reference: ActionReference;
    workflow: string;
    /** The version the reference states, from the ref itself or a SHA's version comment. */
    observed: ParsedVersion | null;
    /** How precisely that version was stated. */
    precision: VersionPrecision | null;
    /** The text the version was read from: `v4`, or the `# v4.2.2` comment. */
    declared: string;
}

export class GithubActionsCollector implements Collector {
    public readonly id = 'github-actions' as const;

    public isEnabled(config: MaintenanceConfig): boolean {
        return config.collectors.githubActions?.enabled === true;
    }

    public async collect(ctx: CollectorContext): Promise<CollectorOutput> {
        const settings = collectorSettings(ctx.config, 'githubActions');
        const findings: Finding[] = [];
        const errors: CollectorError[] = [];
        const ignored = new Set(settings.ignore);
        const occurrences = new Map<string, Occurrence[]>();

        for (const workflow of settings.workflows) {
            try {
                const parsed = parseWorkflow(await ctx.files.read({ path: workflow }), workflow);
                for (const skipped of parsed.skipped) {
                    ctx.logger.debug(
                        `${workflow}:${skipped.line} skipped (${skipped.reason}): ${skipped.raw}`,
                    );
                }
                for (const reference of parsed.actions) {
                    if (ignored.has(reference.repository)) {
                        continue;
                    }
                    push(occurrences, reference.repository, toOccurrence(reference, workflow));
                }
            } catch (error: unknown) {
                // One unreadable workflow must not cost the findings from the others; the
                // run degrades to `partial` and names the file (REQ-GHA-016).
                errors.push(toCollectorError(toMaintenanceError(error, workflow)));
            }
        }

        for (const [repository, group] of sorted(occurrences)) {
            findings.push(...(await this.inspect(repository, group, settings, ctx)));
        }
        return { findings, errors };
    }

    /** Findings for one repository, across every place it is referenced. */
    private async inspect(
        repository: string,
        group: readonly Occurrence[],
        settings: GithubActionsSettings,
        ctx: CollectorContext,
    ): Promise<Finding[]> {
        const findings: Finding[] = [];
        const subject = subjectFor(repository);
        const firstParty = isFirstPartyAction(repository);

        const mutable = group.filter((occurrence) => isMutable(occurrence, settings));
        if (mutable.length > 0) {
            findings.push(
                buildFinding(
                    {
                        collector: this.id,
                        kind: 'action-unpinned',
                        subject,
                        title: `${repository} is referenced by a mutable ref`,
                        detail: describeUnpinned(repository, mutable, firstParty),
                        declared: mutable[0].reference.ref,
                        observed: null,
                        latest: notApplicableResolution(
                            'not-attempted',
                            'Pinning is a property of the reference, not of any upstream version.',
                        ),
                        evidence: mutable.map(fileEvidence),
                        remediationHint:
                            `Replace the ref with the commit SHA of the release and record the ` +
                            `version in a trailing comment, e.g. ` +
                            `\`uses: ${repository}@<sha> # v1.2.3\`.`,
                        references: [`https://github.com/${repository}/releases`],
                        tags: ['supply-chain', firstParty ? 'first-party' : 'third-party'],
                        isFirstPartyAction: firstParty,
                    },
                    ctx,
                ),
            );
        }

        const oldest = pickOldest(group);
        const latest = await this.resolveLatest(repository, ctx);
        const outdated = buildFinding(
            {
                collector: this.id,
                kind: 'action-outdated',
                subject,
                title: titleFor(repository, oldest, latest),
                detail: describeOutdated(repository, group, oldest, latest),
                declared: oldest.declared,
                observed: oldest.observed,
                comparePrecision: oldest.precision ?? undefined,
                latest,
                evidence: group.map(fileEvidence),
                remediationHint:
                    latest.version === null
                        ? null
                        : `Update ${repository} to ${latest.version} in ${describeFiles(group)}.`,
                references: [`https://github.com/${repository}/releases`],
                tags: ['github-actions'],
                isFirstPartyAction: firstParty,
            },
            ctx,
        );
        // Only report drift that exists. A finding whose kind names a condition that does
        // not hold trains readers to ignore the report, and it would keep the pass-2 stage
        // from ever auto-closing the issue it once opened.
        if (outdated.versions.bump !== 'none') {
            findings.push(outdated);
        }
        return findings;
    }

    /**
     * Ask for the latest release, falling back to tags.
     *
     * Most actions publish releases, but a tag-only action is common enough that treating
     * its absent release as "unresolved" would score a genuinely outdated action `info`
     * — the silent-failure mode the design exists to avoid. The fallback costs a request
     * only when the first answer was empty, and `method` records which one answered.
     */
    private async resolveLatest(
        repository: string,
        ctx: CollectorContext,
    ): Promise<LatestResolution> {
        const release = `github-release:${repository}`;
        const resolved = await ctx.sources.resolve(release);
        if (resolved.status === 'resolved') {
            return resolutionFromSource(release, resolved, ctx.clock);
        }
        const tag = `github-tag:${repository}`;
        const fallback = await ctx.sources.resolve(tag);
        return fallback.status === 'resolved'
            ? resolutionFromSource(tag, fallback, ctx.clock)
            : resolutionFromSource(release, resolved, ctx.clock);
    }
}

/** Work out which version a reference states, and how precisely. */
function toOccurrence(reference: ActionReference, workflow: string): Occurrence {
    // A SHA says nothing about the version, so the trailing `# v4.2.2` comment is the
    // only way to know what it points at without spending a request.
    const commentVersion =
        reference.pin === 'sha' ? readVersionComment(reference.snippet) : reference.ref;
    if (commentVersion === null) {
        return { reference, workflow, observed: null, precision: null, declared: reference.raw };
    }
    return {
        reference,
        workflow,
        observed: parseVersionForComparison(commentVersion),
        precision: versionPrecision(commentVersion),
        declared: commentVersion,
    };
}

/**
 * Whether a reference is mutable under the configured policy.
 *
 * A branch or a missing ref is never acceptable. A version tag is mutable too — GitHub
 * moves `v4` as the line advances — but treating that as a finding is a policy choice,
 * so it follows `requireShaPins`.
 */
function isMutable(occurrence: Occurrence, settings: GithubActionsSettings): boolean {
    const { pin } = occurrence.reference;
    if (pin === 'none' || pin === 'branch') {
        return true;
    }
    return pin === 'tag' && settings.requireShaPins;
}

/**
 * The reference most in need of attention.
 *
 * References with no discoverable version sort last: they cannot be compared, so a
 * comparable one is always the more useful thing to report against.
 */
function pickOldest(group: readonly Occurrence[]): Occurrence {
    return group.reduce((oldest, candidate) => {
        if (candidate.observed === null) {
            return oldest;
        }
        if (oldest.observed === null) {
            return candidate;
        }
        return semver.lt(candidate.observed.version, oldest.observed.version) ? candidate : oldest;
    });
}

function subjectFor(repository: string): Subject {
    return {
        kind: 'github-action',
        id: repository,
        displayName: repository,
        ecosystem: 'github-actions',
        // Build scope, not dev: an action runs in CI with repository credentials, so the
        // development-scope demotion must not apply to it.
        scope: 'build',
    };
}

function fileEvidence(occurrence: Occurrence): Evidence {
    return {
        type: 'file',
        path: occurrence.workflow,
        line: occurrence.reference.line,
        column: occurrence.reference.column,
        snippet: occurrence.reference.snippet,
        contentSha256: null,
        repo: null,
        ref: null,
    };
}

function titleFor(repository: string, oldest: Occurrence, latest: LatestResolution): string {
    if (latest.version === null) {
        return `${repository} could not be checked against upstream`;
    }
    const observed = oldest.observed?.version ?? oldest.declared;
    return `${repository} is at ${observed}, latest is ${latest.version}`;
}

function describeUnpinned(
    repository: string,
    mutable: readonly Occurrence[],
    firstParty: boolean,
): string {
    const refs = distinct(mutable.map((occurrence) => occurrence.reference.ref ?? '(no ref)'));
    return (
        `${repository} is referenced by ${refs.join(', ')} in ${describeFiles(mutable)}. ` +
        `A tag or branch can be moved to different code without the reference changing. ` +
        (firstParty
            ? 'GitHub controls this namespace, which limits the exposure.'
            : 'The owner is outside GitHub, so whoever controls it controls what runs here.')
    );
}

function describeOutdated(
    repository: string,
    group: readonly Occurrence[],
    oldest: Occurrence,
    latest: LatestResolution,
): string {
    if (latest.version === null) {
        return (
            `The latest version of ${repository} could not be established` +
            `${latest.reason === null ? '' : `: ${latest.reason}`}. ` +
            `It is referenced in ${describeFiles(group)}.`
        );
    }
    if (oldest.observed === null) {
        return (
            `${repository} is pinned by commit SHA with no version comment in ` +
            `${describeFiles(group)}, so how far behind it is cannot be determined. ` +
            `The latest release is ${latest.version}.`
        );
    }
    const declared = distinct(group.map((occurrence) => occurrence.declared));
    const divergence = declared.length > 1 ? ` References disagree: ${declared.join(', ')}.` : '';
    const moving =
        oldest.precision === 'patch'
            ? ''
            : ` \`${oldest.declared}\` is a moving ref covering the whole ` +
              `${oldest.precision === 'major' ? 'major' : 'minor'} line, so it is compared at ` +
              `that precision rather than against ${latest.version} exactly.`;
    return (
        `${repository} declares ${oldest.declared} in ${describeFiles(group)}; the latest ` +
        `release is ${latest.version}.${divergence}${moving}`
    );
}

function describeFiles(group: readonly Occurrence[]): string {
    return distinct(
        group.map((occurrence) => `${occurrence.workflow}:${occurrence.reference.line}`),
    ).join(', ');
}

function distinct(values: readonly string[]): string[] {
    return [...new Set(values)];
}

function push<T>(map: Map<string, T[]>, key: string, value: T): void {
    const existing = map.get(key);
    if (existing === undefined) {
        map.set(key, [value]);
        return;
    }
    existing.push(value);
}

/** Iterate groups in a stable order, so two runs over the same input agree. */
function sorted<T>(map: ReadonlyMap<string, T>): Array<[string, T]> {
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}
