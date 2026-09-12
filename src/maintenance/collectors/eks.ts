/**
 * The EKS control plane version and its managed addons.
 *
 * There is no unauthenticated public API for the versions EKS supports, so the latest
 * version and its support dates come from a table committed in the configuration. The
 * alternative considered and rejected was reading `kubernetes/kubernetes` releases as a
 * proxy: EKS trails upstream by months, so every scan would report the cluster several
 * minors behind versions EKS does not offer, and a finding that can never be actioned
 * teaches people to ignore the tool (`docs/maintenance/adr/0002-eks-support-calendar.md`,
 * REQ-EKS-016).
 *
 * The committed table's weakness is that it goes stale, so the collector reports on its
 * own calendar as well as on the cluster (REQ-EKS-012). The AWS CLI is available as
 * opt-in enrichment; when it fails the run falls back to the calendar and records the
 * downgrade in `method` and `confidence`, so a degraded answer never reads as an
 * authoritative one (REQ-EKS-041).
 */

import { CollectorError, Evidence, Finding, LatestResolution, Lifecycle } from '../schema';
import { EksSupportCalendarEntry, MaintenanceConfig } from '../schema/config';
import { Collector, CollectorContext, CollectorOutput } from '../types';
import { ValueAtPath, ValuesDocument } from '../parsers/values-yaml';
import { ParsedVersion, coerceVersionCore } from '../version';
import * as semver from 'semver';
import { buildFinding, calendarResolution, notApplicableResolution } from './build-finding';
import { collectorSettings, toCollectorError } from './collector';
import { ConfigError, toMaintenanceError } from '../errors';
import { commandEvidence } from '../sources';
import { daysUntil } from '../clock';
import { z } from 'zod';

type EksSettings = NonNullable<MaintenanceConfig['collectors']['eks']>;
type SupportCalendar = EksSettings['supportCalendar'];

/**
 * The slice of `aws eks describe-cluster-versions` this reads.
 *
 * Parsed rather than cast, like every other external JSON boundary: an AWS CLI upgrade
 * that reshapes the document must produce a recorded error and a calendar fallback, not
 * a silently wrong latest version.
 */
const DescribeClusterVersionsSchema = z.object({
    clusterVersions: z
        .array(
            z.object({
                clusterVersion: z.string(),
                clusterVersionStatus: z.string().optional(),
                endOfStandardSupportDate: z.string().optional(),
                endOfExtendedSupportDate: z.string().optional(),
            }),
        )
        .default([]),
});

export class EksCollector implements Collector {
    public readonly id = 'eks' as const;

    public isEnabled(config: MaintenanceConfig): boolean {
        return config.collectors.eks?.enabled === true;
    }

    public async collect(ctx: CollectorContext): Promise<CollectorOutput> {
        const settings = collectorSettings(ctx.config, 'eks');
        const findings: Finding[] = [];
        const errors: CollectorError[] = [];

        const inventory = new ValuesDocument(
            await ctx.files.read({ path: settings.inventoryFile }),
            settings.inventoryFile,
        );

        const stale = this.checkCalendarFreshness(settings, ctx);
        if (stale !== null) {
            findings.push(stale);
        }

        const declared = inventory.readString(settings.clusterVersionPath);
        if (declared === null) {
            errors.push(
                toCollectorError(
                    new ConfigError(
                        `${settings.inventoryFile} has no value at ${settings.clusterVersionPath}`,
                        { target: `${settings.inventoryFile}#${settings.clusterVersionPath}` },
                    ),
                ),
            );
        } else {
            findings.push(...(await this.inspectCluster(declared, settings, errors, ctx)));
        }

        findings.push(...(await this.inspectAddons(inventory, settings, ctx)));
        return { findings, errors };
    }

    /**
     * Drift and support dates for the control plane.
     *
     * Both come from the same lookup, but they are two findings: "there is a newer
     * version" and "this one stops being supported on a date" are separately actionable,
     * and the second escalates on its own schedule while the first does not.
     */
    private async inspectCluster(
        declared: ValueAtPath,
        settings: EksSettings,
        errors: CollectorError[],
        ctx: CollectorContext,
    ): Promise<Finding[]> {
        const calendar = settings.supportCalendar;
        const source = `${ctx.configPath}#collectors.eks.supportCalendar`;
        const evidence: Evidence[] = [valueEvidence(settings.inventoryFile, declared)];

        const upstream = await this.resolveLatest(settings, evidence, errors, ctx);
        const entry = findEntry(calendar, declared.value);
        // The declared version is compared on its coerced core, because an EKS version
        // is written with two components and `1.31` is not valid semver (REQ-EKS-015).
        const observed = coerceVersionCore(declared.value);

        const findings: Finding[] = [
            buildFinding(
                {
                    collector: this.id,
                    kind: 'cluster-version-outdated',
                    subject: clusterSubject(settings.inventoryFile),
                    title:
                        upstream.version === null
                            ? `The EKS cluster version could not be checked`
                            : `The EKS cluster is on ${declared.value}, latest is ${upstream.version}`,
                    detail: describeCluster(declared, upstream, settings, entry),
                    declared: declared.value,
                    observed,
                    latest: upstream,
                    evidence,
                    remediationHint:
                        upstream.version === null
                            ? null
                            : `Upgrade the control plane to ${upstream.version}, then the node ` +
                              `groups, then update ${settings.clusterVersionPath} in ` +
                              `${settings.inventoryFile}.`,
                    references: [calendar.source],
                    tags: ['eks', 'control-plane'],
                },
                ctx,
            ),
        ];

        if (entry === null) {
            // A version the table has never heard of is a gap in the table, not a
            // healthy cluster, so it is an error as well as an unresolved finding
            // (REQ-EKS-014).
            errors.push(
                toCollectorError(
                    new ConfigError(`The support calendar has no entry for EKS ${declared.value}`, {
                        target: source,
                    }),
                ),
            );
            return findings;
        }

        findings.push(
            ...this.supportFinding(declared, entry, calendar, source, settings, evidence, ctx),
        );
        return findings.filter(
            (finding) =>
                finding.versions.bump !== 'none' || finding.kind !== 'cluster-version-outdated',
        );
    }

    /** The support-date finding, emitted only while there is something to act on. */
    private supportFinding(
        declared: ValueAtPath,
        entry: EksSupportCalendarEntry,
        calendar: SupportCalendar,
        source: string,
        settings: EksSettings,
        evidence: readonly Evidence[],
        ctx: CollectorContext,
    ): Finding[] {
        const remaining = daysUntil(ctx.clock, entry.endOfStandardSupport);
        const lifecycle: Lifecycle = {
            endOfStandardSupport: entry.endOfStandardSupport,
            endOfExtendedSupport: entry.endOfExtendedSupport,
            daysUntilEndOfSupport: remaining,
            deprecated: entry.status === 'deprecated',
            deprecationMessage:
                entry.status === 'deprecated'
                    ? `AWS lists EKS ${entry.version} as deprecated.`
                    : null,
            calendarSource: source,
            calendarLastVerified: calendar.lastVerified,
        };
        const finding = buildFinding(
            {
                collector: this.id,
                kind: 'cluster-version-eol',
                subject: clusterSubject(settings.inventoryFile),
                title:
                    remaining <= 0
                        ? `EKS ${entry.version} is past end of standard support`
                        : `EKS ${entry.version} leaves standard support in ${remaining} days`,
                detail:
                    `Standard support for EKS ${entry.version} ` +
                    `${remaining <= 0 ? 'ended' : 'ends'} on ${entry.endOfStandardSupport}` +
                    `${
                        entry.endOfExtendedSupport === null
                            ? ''
                            : `, with extended support until ${entry.endOfExtendedSupport}`
                    }. ` +
                    `After that AWS upgrades the control plane automatically and bills ` +
                    `extended-support rates in the meantime, so the date is a budget question ` +
                    `as well as a compatibility one. Read from ${source}, last verified ` +
                    `${calendar.lastVerified}.`,
                declared: declared.value,
                observed: coerceVersionCore(declared.value),
                latest: notApplicableResolution(
                    'support-calendar',
                    'The finding is about support dates, not about a newer version.',
                ),
                lifecycle,
                evidence: [...evidence],
                remediationHint: `Plan the upgrade off EKS ${entry.version} before ${entry.endOfStandardSupport}.`,
                references: [calendar.source],
                tags: ['eks', 'end-of-life'],
            },
            ctx,
        );
        // Only the rules that react to a date make this actionable; outside their horizon
        // the support date is a fact with nothing attached to it (REQ-SCH-009).
        return finding.severity.ruleId.startsWith('SEV-EOL-') ? [finding] : [];
    }

    /**
     * Addon drift.
     *
     * Addon versions carry an `-eksbuild.N` suffix that is part of the version AWS
     * publishes but not part of semver ordering, so comparison happens on the coerced
     * core while the declared string is recorded in full (REQ-EKS-015).
     */
    private async inspectAddons(
        inventory: ValuesDocument,
        settings: EksSettings,
        ctx: CollectorContext,
    ): Promise<Finding[]> {
        const declared = inventory.readMap(settings.addonsPath);
        if (declared === null) {
            return [];
        }
        const findings: Finding[] = [];
        for (const addon of declared) {
            const name = addon.path.slice(settings.addonsPath.length + 1);
            const ref = settings.addonLatest[name];
            const latest =
                ref === undefined
                    ? notApplicableResolution(
                          'static-config',
                          `No upstream is configured for the ${name} addon.`,
                      )
                    : calendarResolution((await ctx.sources.resolve(ref)).version, ref, ctx.clock);
            const finding = buildFinding(
                {
                    collector: this.id,
                    kind: 'addon-outdated',
                    subject: {
                        kind: 'eks-addon',
                        id: name,
                        displayName: name,
                        ecosystem: 'eks',
                        scope: 'infra',
                    },
                    title:
                        latest.version === null
                            ? `The ${name} addon could not be checked against upstream`
                            : `The ${name} addon is at ${addon.value}, latest is ${latest.version}`,
                    detail:
                        `${settings.inventoryFile}:${addon.line} declares ${name} as ` +
                        `\`${addon.value}\`. ` +
                        (latest.version === null
                            ? `No newer version could be established` +
                              `${latest.reason === null ? '' : `: ${latest.reason}`}.`
                            : `${ref ?? 'upstream'} reports ${latest.version}. Versions are ` +
                              `compared on their semantic core; the -eksbuild suffix orders ` +
                              `separately and is recorded as declared.`),
                    declared: addon.value,
                    // The core only: -eksbuild.N is a build of the version it follows,
                    // not a prerelease of it, and semver orders it the other way round.
                    observed: coerceVersionCore(addon.value),
                    compareOnCore: true,
                    latest,
                    evidence: [valueEvidence(settings.inventoryFile, addon)],
                    remediationHint:
                        latest.version === null
                            ? null
                            : `Update the ${name} addon to ${latest.version}, then update ` +
                              `${addon.path} in ${settings.inventoryFile}.`,
                    tags: ['eks', 'addon'],
                },
                ctx,
            );
            if (finding.versions.bump !== 'none' && latest.status !== 'not-applicable') {
                findings.push(finding);
            }
        }
        return findings;
    }

    /**
     * The newest supported version, from the calendar or from the AWS CLI.
     *
     * The CLI is tried first only when configured, and a failure is recorded and then
     * ignored in favour of the calendar. The point of the fallback is that the answer
     * still arrives; the point of recording the downgrade is that nobody mistakes a
     * committed table for a live API (REQ-EKS-040, REQ-EKS-041).
     */
    private async resolveLatest(
        settings: EksSettings,
        evidence: Evidence[],
        errors: CollectorError[],
        ctx: CollectorContext,
    ): Promise<LatestResolution> {
        const source = `${ctx.configPath}#collectors.eks.supportCalendar`;
        const fromCalendar = calendarResolution(
            newestSupported(settings.supportCalendar),
            source,
            ctx.clock,
        );
        if (settings.latestStrategy === 'support-calendar') {
            return fromCalendar;
        }

        try {
            const result = await ctx.commands.run({
                argv: settings.awsCli.argv,
                cwd: ctx.repoRoot,
                timeoutMs: ctx.config.defaults.commandTimeoutMs,
            });
            evidence.push(commandEvidence(result));
            if (result.exitCode !== 0) {
                throw new ConfigError(
                    `${settings.awsCli.argv[0]} exited ${result.exitCode}: ` +
                        `${result.stderr.trim().slice(0, 200)}`,
                    { target: settings.awsCli.argv.join(' ') },
                );
            }
            const parsed = DescribeClusterVersionsSchema.parse(JSON.parse(result.stdout));
            const newest = newestFromAws(parsed.clusterVersions);
            if (newest === null) {
                throw new ConfigError('The AWS CLI listed no supported cluster versions', {
                    target: settings.awsCli.argv.join(' '),
                });
            }
            return {
                status: 'resolved',
                version: newest,
                ref: settings.awsCli.argv.join(' '),
                method: 'aws-cli',
                confidence: 'high',
                retrievedAt: ctx.clock.nowIso(),
                reason: null,
            };
        } catch (error: unknown) {
            errors.push(
                toCollectorError(toMaintenanceError(error, settings.awsCli.argv.join(' '))),
            );
            return fromCalendar;
        }
    }

    /** The calendar nagging about its own age (REQ-EKS-012). */
    private checkCalendarFreshness(settings: EksSettings, ctx: CollectorContext): Finding | null {
        const calendar = settings.supportCalendar;
        const age = -daysUntil(ctx.clock, calendar.lastVerified);
        if (age <= calendar.staleAfterDays) {
            return null;
        }
        const source = `${ctx.configPath}#collectors.eks.supportCalendar`;
        return buildFinding(
            {
                collector: this.id,
                kind: 'config-stale',
                subject: {
                    kind: 'maintenance-config',
                    id: source,
                    displayName: 'EKS support calendar',
                    ecosystem: null,
                    scope: 'infra',
                },
                title: `The EKS support calendar was last verified ${age} days ago`,
                detail:
                    `\`collectors.eks.supportCalendar\` was last verified on ` +
                    `${calendar.lastVerified}, ${age} days ago, and is configured to go stale ` +
                    `after ${calendar.staleAfterDays}. Every EKS finding in this run rests on ` +
                    `it, so an out-of-date table means out-of-date findings rather than ` +
                    `missing ones.`,
                declared: calendar.lastVerified,
                observed: null,
                latest: notApplicableResolution(
                    'support-calendar',
                    'Calendar freshness is a property of the committed table.',
                ),
                evidence: [configEvidence(ctx.configPath)],
                remediationHint:
                    `Re-check the table against ${calendar.source} and update ` +
                    `\`lastVerified\` in ${ctx.configPath}.`,
                references: [calendar.source],
                tags: ['eks', 'config'],
            },
            ctx,
        );
    }
}

function findEntry(calendar: SupportCalendar, version: string): EksSupportCalendarEntry | null {
    return calendar.versions.find((entry) => entry.version === version) ?? null;
}

/**
 * The newest version still in standard support.
 *
 * Deliberately not simply the highest version in the table: a version on extended
 * support or listed as deprecated is not something to upgrade *to*.
 */
function newestSupported(calendar: SupportCalendar): string | null {
    return newestVersion(
        calendar.versions
            .filter((entry) => entry.status === 'standard-support')
            .map((entry) => entry.version),
    );
}

/** The newest version the AWS CLI reports as being in standard support. */
function newestFromAws(
    versions: ReadonlyArray<{ clusterVersion: string; clusterVersionStatus?: string }>,
): string | null {
    return newestVersion(
        versions
            .filter(
                (entry) =>
                    entry.clusterVersionStatus === undefined ||
                    entry.clusterVersionStatus === 'standard-support',
            )
            .map((entry) => entry.clusterVersion),
    );
}

/**
 * The highest of a set of EKS versions.
 *
 * Coerced rather than strictly parsed, because an EKS version is written with two
 * components and `1.31` is not valid semver. Anything that will not coerce at all is
 * dropped rather than ranked: a value that cannot be read as a version cannot be the
 * newest one, and treating it as comparable would let input order decide the answer.
 */
function newestVersion(candidates: readonly string[]): string | null {
    const parsed = candidates
        .map((raw) => ({ raw, parsed: coerceVersionCore(raw) }))
        .filter((entry): entry is { raw: string; parsed: ParsedVersion } => entry.parsed !== null);
    if (parsed.length === 0) {
        return null;
    }
    return parsed.reduce((newest, entry) =>
        semver.gt(entry.parsed.version, newest.parsed.version) ? entry : newest,
    ).raw;
}

function clusterSubject(inventoryFile: string) {
    return {
        kind: 'eks-cluster' as const,
        id: `${inventoryFile}#cluster`,
        displayName: 'EKS cluster',
        ecosystem: 'eks',
        scope: 'infra' as const,
    };
}

function describeCluster(
    declared: ValueAtPath,
    latest: LatestResolution,
    settings: EksSettings,
    entry: EksSupportCalendarEntry | null,
): string {
    const where =
        `${settings.inventoryFile}:${declared.line} declares the cluster as running ` +
        `${declared.value}`;
    if (latest.version === null) {
        return (
            `${where}. The newest supported version could not be established` +
            `${latest.reason === null ? '' : `: ${latest.reason}`}.`
        );
    }
    const unknown =
        entry === null
            ? ` The support calendar has no entry for ${declared.value}, so its support dates are unknown to this scan.`
            : '';
    return (
        `${where}; ${latest.version} is the newest version in standard support according to ` +
        `${latest.ref} (${latest.method}, ${latest.confidence} confidence).${unknown}`
    );
}

function valueEvidence(path: string, value: ValueAtPath): Evidence {
    return {
        type: 'file',
        path,
        line: value.line,
        column: null,
        snippet: value.snippet,
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
