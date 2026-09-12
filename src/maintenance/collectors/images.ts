/**
 * Base images and the tools baked into them.
 *
 * Three findings from one parse of each declared Dockerfile: a base image behind its
 * newest tag (`image-base-outdated`), a configured tool pin behind its upstream
 * (`image-tool-outdated`), and a distribution past or nearing end of support
 * (`image-distro-eol`).
 *
 * The distribution case is the one that cannot be answered by comparing versions:
 * `bullseye` is not semver and no registry knows it is older than `bookworm`. It is
 * routed through a committed calendar instead, which is also why this collector reports
 * on its own inputs — an image the Dockerfile builds on but the inventory does not
 * declare, or a codename the calendar has never heard of, is a gap in what the scan can
 * see and says so as `config-stale` rather than staying quiet (REQ-IMG-020).
 */

import { CollectorError, Evidence, Finding, LatestResolution, Lifecycle, Subject } from '../schema';
import { DistroCalendarEntry, ImageBase, ImageToolPin, MaintenanceConfig } from '../schema/config';
import { Collector, CollectorContext, CollectorOutput } from '../types';
import { BaseImageReference, parseDockerfile } from '../parsers/dockerfile';
import { ToolPinMatch, findToolPins } from '../parsers/tool-pins';
import { VersionPrecision, parseVersionForComparison, versionPrecision } from '../version';
import { buildFinding, notApplicableResolution, resolutionFromSource } from './build-finding';
import { collectorSettings, toCollectorError } from './collector';
import { ConfigError, toMaintenanceError } from '../errors';
import * as semver from 'semver';
import { daysUntil } from '../clock';
import { EOL_HORIZON_DAYS } from '../severity/rules';

type ImagesSettings = NonNullable<MaintenanceConfig['collectors']['images']>;
type DockerfileSettings = ImagesSettings['dockerfiles'][number];
type DistroCalendar = NonNullable<ImagesSettings['distroCalendar']>;

/** How a tool pin's `compare` setting narrows the version comparison. */
const COMPARE_PRECISION = { exact: 'patch', minor: 'minor', major: 'major' } as const;

export class ImagesCollector implements Collector {
    public readonly id = 'images' as const;

    public isEnabled(config: MaintenanceConfig): boolean {
        return config.collectors.images?.enabled === true;
    }

    public async collect(ctx: CollectorContext): Promise<CollectorOutput> {
        const settings = collectorSettings(ctx.config, 'images');
        const findings: Finding[] = [];
        const errors: CollectorError[] = [];

        for (const dockerfile of settings.dockerfiles) {
            try {
                findings.push(...(await this.inspect(dockerfile, settings, ctx)));
            } catch (error: unknown) {
                // One unreadable Dockerfile must not cost the findings from the others.
                errors.push(toCollectorError(toMaintenanceError(error, dockerfile.path)));
            }
        }

        const stale = this.checkCalendarFreshness(settings, ctx);
        if (stale !== null) {
            findings.push(stale);
        }
        return { findings, errors };
    }

    private async inspect(
        dockerfile: DockerfileSettings,
        settings: ImagesSettings,
        ctx: CollectorContext,
    ): Promise<Finding[]> {
        const text = await ctx.files.read({ path: dockerfile.path });
        const parsed = parseDockerfile(text);
        const findings: Finding[] = [];

        for (const [image, group] of groupBaseImages(parsed.baseImages)) {
            const declared = dockerfile.baseImages[image];
            if (declared === undefined) {
                findings.push(undeclaredImageFinding(image, group, dockerfile, ctx));
                continue;
            }
            findings.push(
                ...(await this.inspectBaseImage(image, group, declared, dockerfile, settings, ctx)),
            );
        }

        // Driven by the declared pins rather than by the matches, so a pin that matches
        // nothing simply yields nothing: the Dockerfile does not install that tool
        // (REQ-IMG-019).
        const pinMatches = findToolPins(text, dockerfile.toolPins);
        for (const pin of dockerfile.toolPins) {
            const occurrences = pinMatches.filter((match) => match.id === pin.id);
            if (occurrences.length === 0) {
                continue;
            }
            const finding = await this.inspectToolPin(pin, occurrences, dockerfile, ctx);
            if (finding !== null) {
                findings.push(finding);
            }
        }
        return findings;
    }

    private async inspectBaseImage(
        image: string,
        group: readonly BaseImageReference[],
        declared: ImageBase,
        dockerfile: DockerfileSettings,
        settings: ImagesSettings,
        ctx: CollectorContext,
    ): Promise<Finding[]> {
        const subject = imageSubject(image, dockerfile.path);
        const evidence = group.map((reference) => dockerfileEvidence(dockerfile.path, reference));
        const first = group[0];

        if (first.unresolved) {
            // A `FROM ${BASE}:${TAG}` whose arguments are set outside this file. Reported
            // rather than guessed at: a substituted-in image we invented would be worse
            // than an honest gap (REQ-IMG-013).
            return [
                buildFinding(
                    {
                        collector: this.id,
                        kind: 'image-base-outdated',
                        subject,
                        title: `${image} could not be resolved to a concrete reference`,
                        detail:
                            `\`${first.raw}\` in ${dockerfile.path} still contains an ` +
                            `unsubstituted build argument, so there is nothing to compare ` +
                            `against upstream.`,
                        declared: first.raw,
                        observed: null,
                        latest: {
                            status: 'unresolved',
                            version: null,
                            ref: declared.source,
                            method: 'not-attempted',
                            confidence: 'low',
                            retrievedAt: null,
                            reason: 'The reference contains an unresolved build argument.',
                        },
                        evidence,
                        tags: ['images'],
                    },
                    ctx,
                ),
            ];
        }

        if (declared.distroFromCodenameSuffix) {
            return distroFindings(this.id, image, first.tag, group, dockerfile, settings, ctx);
        }

        const latest = await this.resolveTag(declared, ctx);
        const observedTag = first.tag;
        const finding = buildFinding(
            {
                collector: this.id,
                kind: 'image-base-outdated',
                subject,
                title:
                    latest.version === null
                        ? `${image} could not be checked against its registry`
                        : `${image} is at ${observedTag ?? 'an untagged reference'}, latest is ` +
                          `${latest.version}`,
                detail:
                    `${image} is used in ${describeLines(dockerfile.path, group)}` +
                    `${observedTag === null ? ' with no tag' : ` at tag \`${observedTag}\``}. ` +
                    (latest.version === null
                        ? `The newest matching tag could not be established${
                              latest.reason === null ? '' : `: ${latest.reason}`
                          }.`
                        : `The newest tag matching \`${declared.tagPattern}\` is ` +
                          `${latest.version}.`),
                declared: observedTag,
                observed: observedTag === null ? null : parseVersionForComparison(observedTag),
                comparePrecision:
                    observedTag === null ? undefined : (versionPrecision(observedTag) ?? undefined),
                latest,
                evidence,
                remediationHint:
                    latest.version === null
                        ? null
                        : `Update the FROM tag to ${latest.version} in ${dockerfile.path}.`,
                tags: ['images'],
            },
            ctx,
        );
        return finding.versions.bump === 'none' ? [] : [finding];
    }

    /**
     * One finding per configured pin, however many times the tool is installed.
     *
     * A multi-stage build often installs the same binary twice. Those are one unit of
     * human work and, more to the point, one subject — emitting a finding per occurrence
     * would put two findings carrying the same fingerprint into a single report, which
     * the publish stage has no way to tell apart (ADR-0003).
     */
    private async inspectToolPin(
        pin: ImageToolPin,
        matches: readonly ToolPinMatch[],
        dockerfile: DockerfileSettings,
        ctx: CollectorContext,
    ): Promise<Finding | null> {
        const match = oldestPin(matches);
        const resolved = await ctx.sources.resolve(pin.source);
        const latest = resolutionFromSource(pin.source, resolved, ctx.clock);
        const observed = parseVersionForComparison(match.version);
        const finding = buildFinding(
            {
                collector: this.id,
                kind: 'image-tool-outdated',
                subject: toolSubject(pin, dockerfile.path),
                title: titleForTool(pin, match, latest),
                detail: describeTool(pin, matches, match, latest, dockerfile.path),
                declared: match.version,
                observed,
                comparePrecision: precisionFor(pin, match),
                latest,
                evidence: matches.map((occurrence) => ({
                    type: 'file' as const,
                    path: dockerfile.path,
                    line: occurrence.line,
                    column: null,
                    snippet: occurrence.snippet,
                    contentSha256: null,
                    repo: null,
                    ref: null,
                })),
                remediationHint:
                    latest.version === null
                        ? null
                        : `Update the ${pin.id} pin to ${latest.version} in ${dockerfile.path}.`,
                tags: ['images', 'tool-pin'],
            },
            ctx,
        );
        return finding.versions.bump === 'none' ? null : finding;
    }

    private async resolveTag(
        declared: ImageBase,
        ctx: CollectorContext,
    ): Promise<LatestResolution> {
        const pattern = compilePattern(declared.tagPattern, declared.source);
        const resolved = await ctx.sources.resolve(declared.source, { tagPattern: pattern });
        return resolutionFromSource(declared.source, resolved, ctx.clock);
    }

    /**
     * The calendar nagging about itself.
     *
     * A committed table is only as good as the last time somebody checked it, and a table
     * nobody rechecks is the weakest link in the design. Making its age a finding is what
     * keeps that visible instead of quietly wrong (ADR-0002, REQ-IMG-021).
     */
    private checkCalendarFreshness(
        settings: ImagesSettings,
        ctx: CollectorContext,
    ): Finding | null {
        const calendar = settings.distroCalendar;
        if (calendar === undefined) {
            return null;
        }
        const age = -daysUntil(ctx.clock, calendar.lastVerified);
        if (age <= calendar.staleAfterDays) {
            return null;
        }
        return buildFinding(
            {
                collector: this.id,
                kind: 'config-stale',
                subject: {
                    kind: 'maintenance-config',
                    id: `${ctx.configPath}#collectors.images.distroCalendar`,
                    displayName: 'images distribution calendar',
                    ecosystem: null,
                    scope: 'infra',
                },
                title: `The distribution calendar was last verified ${age} days ago`,
                detail:
                    `\`collectors.images.distroCalendar\` was last verified on ` +
                    `${calendar.lastVerified}, ${age} days ago, and is configured to go stale ` +
                    `after ${calendar.staleAfterDays}. End-of-support dates read from it may no ` +
                    `longer match what the distributions publish.`,
                declared: calendar.lastVerified,
                observed: null,
                latest: notApplicableResolution(
                    'static-config',
                    'Calendar freshness is a property of the committed file.',
                ),
                evidence: [configEvidence(ctx.configPath)],
                remediationHint:
                    `Re-check the calendar against each distribution's published schedule and ` +
                    `update \`lastVerified\` in ${ctx.configPath}.`,
                tags: ['config'],
            },
            ctx,
        );
    }
}

/**
 * Findings for an image whose tag is a distribution codename.
 *
 * `bullseye` sorts nowhere near `bookworm` and no registry ranks them, so the calendar
 * answers the only question worth asking about such a tag: how long it is supported.
 */
function distroFindings(
    collector: 'images',
    image: string,
    tag: string | null,
    group: readonly BaseImageReference[],
    dockerfile: DockerfileSettings,
    settings: ImagesSettings,
    ctx: CollectorContext,
): Finding[] {
    const subject = imageSubject(image, dockerfile.path);
    const evidence = group.map((reference) => dockerfileEvidence(dockerfile.path, reference));
    const codename = tag === null ? null : (tag.split('-').pop() ?? null);
    const entry = lookupCodename(settings.distroCalendar, codename);

    if (entry === null) {
        return [
            buildFinding(
                {
                    collector,
                    kind: 'config-stale',
                    subject: {
                        kind: 'maintenance-config',
                        id:
                            `${ctx.configPath}#collectors.images.${dockerfile.path}` +
                            `.distroCalendar.${image}`,
                        displayName: `distribution calendar entry for ${codename ?? image}`,
                        ecosystem: null,
                        scope: 'infra',
                    },
                    title: `No distribution calendar entry for \`${codename ?? image}\``,
                    detail:
                        `${image} in ${describeLines(dockerfile.path, group)} is configured to be ` +
                        `read as a distribution codename, but ` +
                        `${codename === null ? 'it carries no tag' : `\`${codename}\` is not in \`collectors.images.distroCalendar.codenames\``}. ` +
                        `Its end-of-support date is therefore unknown to this scan.`,
                    declared: tag,
                    observed: null,
                    latest: notApplicableResolution(
                        'static-config',
                        'A codename has no version ordering; the calendar is the only source.',
                    ),
                    evidence,
                    remediationHint:
                        codename === null
                            ? null
                            : `Add \`${codename}\` to collectors.images.distroCalendar.codenames ` +
                              `in ${ctx.configPath}.`,
                    tags: ['config', 'images'],
                },
                ctx,
            ),
        ];
    }

    const lifecycle: Lifecycle = {
        endOfStandardSupport: entry.endOfStandardSupport,
        endOfExtendedSupport: null,
        daysUntilEndOfSupport: daysUntil(ctx.clock, entry.endOfStandardSupport),
        deprecated: false,
        deprecationMessage: null,
        calendarSource: `${ctx.configPath}#collectors.images.distroCalendar`,
        calendarLastVerified: settings.distroCalendar?.lastVerified ?? null,
    };
    const remaining = lifecycle.daysUntilEndOfSupport ?? 0;
    // Beyond the horizon the rule table reacts to there is nothing to act on, and a
    // finding named for a condition that does not hold is noise (REQ-SCH-009).
    if (remaining > EOL_HORIZON_DAYS) {
        return [];
    }
    return [
        buildFinding(
            {
                collector,
                kind: 'image-distro-eol',
                subject,
                title:
                    remaining <= 0
                        ? `${entry.distro} ${entry.release} (${codename}) is past end of standard support`
                        : `${entry.distro} ${entry.release} (${codename}) leaves standard support in ${remaining} days`,
                detail:
                    `${image} in ${describeLines(dockerfile.path, group)} is built on ` +
                    `${entry.distro} ${entry.release} (\`${codename}\`), whose standard support ` +
                    `${remaining <= 0 ? 'ended' : 'ends'} on ${entry.endOfStandardSupport}. ` +
                    `After that date the distribution publishes no further security updates, so ` +
                    `packages installed from it stop receiving fixes.`,
                declared: tag,
                observed: parseVersionForComparison(entry.release),
                latest: notApplicableResolution(
                    'support-calendar',
                    'The finding is about support dates, not about a newer version.',
                ),
                lifecycle,
                evidence,
                remediationHint: `Rebuild on a newer ${entry.distro} release in ${dockerfile.path}.`,
                tags: ['images', 'end-of-life'],
            },
            ctx,
        ),
    ];
}

/** An image the Dockerfile builds on that the inventory never declared. */
function undeclaredImageFinding(
    image: string,
    group: readonly BaseImageReference[],
    dockerfile: DockerfileSettings,
    ctx: CollectorContext,
): Finding {
    return buildFinding(
        {
            collector: 'images',
            kind: 'config-stale',
            subject: {
                kind: 'maintenance-config',
                id: `${ctx.configPath}#collectors.images.${dockerfile.path}.baseImages.${image}`,
                displayName: `baseImages entry for ${image}`,
                ecosystem: null,
                scope: 'infra',
            },
            title: `${image} is not declared in the maintenance inventory`,
            detail:
                `${dockerfile.path} builds on ${image} at ` +
                `${describeLines(dockerfile.path, group)}, but there is no entry for it under ` +
                `\`collectors.images.dockerfiles[].baseImages\`. The scan cannot check it for ` +
                `drift, so this image is invisible to every future run until it is declared.`,
            declared: group[0].tag,
            observed: null,
            latest: notApplicableResolution(
                'static-config',
                'No source is configured for this image.',
            ),
            evidence: [
                ...group.map((reference) => dockerfileEvidence(dockerfile.path, reference)),
                configEvidence(ctx.configPath),
            ],
            remediationHint:
                `Add \`${image}\` with a source and tagPattern under the ${dockerfile.path} ` +
                `entry in ${ctx.configPath}.`,
            tags: ['config', 'images'],
        },
        ctx,
    );
}

/** Group repeated references to the same image, so a multi-stage build yields one finding. */
function groupBaseImages(
    references: readonly BaseImageReference[],
): Array<[string, BaseImageReference[]]> {
    const groups = new Map<string, BaseImageReference[]>();
    for (const reference of references) {
        // A digest pin is a deliberate choice, not drift, and has no tag to compare.
        if (reference.digest !== null) {
            continue;
        }
        const existing = groups.get(reference.image);
        if (existing === undefined) {
            groups.set(reference.image, [reference]);
        } else {
            existing.push(reference);
        }
    }
    return [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

function lookupCodename(
    calendar: DistroCalendar | undefined,
    codename: string | null,
): DistroCalendarEntry | null {
    if (calendar === undefined || codename === null) {
        return null;
    }
    return calendar.codenames[codename] ?? null;
}

function compilePattern(pattern: string, target: string): RegExp {
    try {
        return new RegExp(pattern);
    } catch {
        throw new ConfigError(`Invalid tagPattern for ${target}: ${pattern}`, { target });
    }
}

function imageSubject(image: string, path: string): Subject {
    return {
        kind: 'container-image',
        // Path-qualified but never line-qualified: two Dockerfiles may pin the same image
        // to different tags, and reformatting one must not orphan its issue.
        id: `${path}#${image}`,
        displayName: image,
        ecosystem: 'oci',
        scope: 'build',
    };
}

function toolSubject(pin: ImageToolPin, path: string): Subject {
    return {
        kind: 'image-tool',
        id: `${path}#${pin.id}`,
        displayName: pin.id,
        ecosystem: 'image-tool',
        scope: 'build',
    };
}

/** Narrow a tool comparison to what the pin's `compare` setting asks for. */
function precisionFor(pin: ImageToolPin, match: ToolPinMatch): VersionPrecision | undefined {
    const configured = COMPARE_PRECISION[pin.compare];
    if (configured !== 'patch') {
        return configured;
    }
    // An exact pin still only states what it states: `--version 3` is not `3.0.0`.
    return versionPrecision(match.version) ?? undefined;
}

function titleForTool(pin: ImageToolPin, match: ToolPinMatch, latest: LatestResolution): string {
    if (latest.version === null) {
        return `${pin.id} could not be checked against upstream`;
    }
    return `${pin.id} is pinned to ${match.version}, latest is ${latest.version}`;
}

function describeTool(
    pin: ImageToolPin,
    matches: readonly ToolPinMatch[],
    oldest: ToolPinMatch,
    latest: LatestResolution,
    path: string,
): string {
    const where =
        `${matches.map((match) => `${path}:${match.line}`).join(', ')} ` +
        `${matches.length === 1 ? 'pins' : 'pin'} ${pin.id} to \`${oldest.version}\``;
    const divergence = describeDivergentPins(matches, oldest);
    if (latest.version === null) {
        return (
            `${where}${divergence}. The latest version could not be established` +
            `${latest.reason === null ? '' : `: ${latest.reason}`}.`
        );
    }
    return (
        `${where}${divergence}; ${latest.ref ?? 'upstream'} reports ${latest.version} as the ` +
        `latest.`
    );
}

/**
 * Name the other pinned versions when a tool is installed at more than one.
 *
 * The reported version is excluded by value rather than by position: the occurrence
 * being reported is the oldest, which is not necessarily the first one in the file.
 */
function describeDivergentPins(matches: readonly ToolPinMatch[], reported: ToolPinMatch): string {
    const others = [...new Set(matches.map((match) => match.version))].filter(
        (version) => version !== reported.version,
    );
    return others.length === 0 ? '' : ` (also pinned to ${others.join(', ')})`;
}

/**
 * The occurrence most in need of attention.
 *
 * Occurrences whose captured text is not a version sort last: they cannot be compared,
 * so a comparable one is always the more useful thing to report against.
 */
function oldestPin(matches: readonly ToolPinMatch[]): ToolPinMatch {
    return matches.reduce((oldest, candidate) => {
        const candidateVersion = parseVersionForComparison(candidate.version);
        const oldestVersion = parseVersionForComparison(oldest.version);
        if (candidateVersion === null) {
            return oldest;
        }
        if (oldestVersion === null) {
            return candidate;
        }
        return semver.lt(candidateVersion.version, oldestVersion.version) ? candidate : oldest;
    });
}

function dockerfileEvidence(path: string, reference: BaseImageReference): Evidence {
    return {
        type: 'file',
        path,
        line: reference.line,
        column: null,
        snippet: reference.snippet,
        contentSha256: null,
        repo: null,
        ref: null,
    };
}

function configEvidence(path: string): Evidence {
    return {
        type: 'file',
        path,
        line: null,
        column: null,
        snippet: null,
        contentSha256: null,
        repo: null,
        ref: null,
    };
}

function describeLines(path: string, group: readonly BaseImageReference[]): string {
    return group.map((reference) => `${path}:${reference.line}`).join(', ');
}
