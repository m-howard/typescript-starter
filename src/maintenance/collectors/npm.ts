/**
 * Declared npm dependencies, their drift, and their advisories.
 *
 * Three inputs, merged, with `package.json` authoritative for the declared set.
 * `npm outdated` reports only what is *already* outdated and its contents depend on the
 * installed tree, so it cannot name the set of things being maintained — it is
 * enrichment over the manifest, never the source of truth
 * (`docs/maintenance/adr/0001-package-json-authoritative.md`, REQ-NPM-010).
 *
 * Both npm commands exit 1 when they have something to report, which is the *normal*
 * case, so exit 1 is a success here and only other codes are failures (REQ-NPM-011,
 * REQ-NPM-012). Either command failing costs its own contribution and nothing else: with
 * no npm binary at all the collector still reports drift from the manifest and the
 * registry, and says so by running `partial` (REQ-NPM-019).
 */

import { CollectorError, Evidence, Finding, LatestResolution, Subject } from '../schema';
import { MaintenanceConfig } from '../schema/config';
import { Collector, CollectorContext, CollectorOutput } from '../types';
import { DeclaredDependency, parsePackageJson } from '../parsers/package-json';
import {
    NpmAdvisory,
    NpmOutdatedEntry,
    NpmOutdatedReport,
    NpmVulnerability,
    advisoriesOf,
    advisoryId,
    parseNpmAudit,
    parseNpmOutdated,
    readFixAvailable,
    transitiveChainOf,
} from '../parsers/npm-output';
import { ParsedVersion, parseVersionForComparison } from '../version';
import { commandEvidence } from '../sources';
import { buildFinding, notApplicableResolution, resolutionFromSource } from './build-finding';
import { collectorSettings, toCollectorError } from './collector';
import { CommandResult } from '../exec/command-runner';
import { toMaintenanceError } from '../errors';
import { SubjectScope } from '../severity/facts';
import { LineIndex } from '../text/line-index';
import { truncate } from '../text/truncate';
import { FINDING_TITLE_MAX_LENGTH } from '../schema/finding';

type NpmSettings = NonNullable<MaintenanceConfig['collectors']['npm']>;

/**
 * Explicit, because the default is 1MB and a real audit document is far larger.
 *
 * On overflow `execFile` yields *truncated* stdout, which parses as broken JSON rather
 * than failing outright — so the limit is set generously and the runner treats an
 * overflow as a hard failure rather than a parse attempt (REQ-NPM-020).
 */
const MAX_BUFFER = 32 * 1024 * 1024;

/** Exit statuses that mean "ran fine"; both commands use 1 for "found something". */
const SUCCESS_CODES = new Set([0, 1]);

/** npm's advisory ladder, which is not the report's severity ladder. */
const ADVISORY_SEVERITIES = new Set(['critical', 'high', 'moderate', 'low', 'info']);

export class NpmCollector implements Collector {
    public readonly id = 'npm' as const;

    public isEnabled(config: MaintenanceConfig): boolean {
        return config.collectors.npm?.enabled === true;
    }

    public async collect(ctx: CollectorContext): Promise<CollectorOutput> {
        const settings = collectorSettings(ctx.config, 'npm');
        const errors: CollectorError[] = [];

        const manifestText = await ctx.files.read({ path: settings.manifest });
        const manifest = parsePackageJson(manifestText, settings.manifest);
        // Kept so evidence can quote the line as it is actually written, rather than a
        // reconstruction of it (REQ-EVI-006).
        const lines = new LineIndex(manifestText);
        const ignored = new Set(settings.ignore);
        const declared = manifest.dependencies.filter((entry) => !ignored.has(entry.name));

        const outdated = settings.runOutdated ? await this.runOutdated(ctx, errors) : null;
        const audit = settings.runAudit ? await this.runAudit(ctx, errors) : null;

        const findings: Finding[] = [];
        for (const dependency of declared) {
            findings.push(...(await this.inspect(dependency, outdated, settings, lines, ctx)));
        }
        findings.push(...this.inspectAudit(audit, declared, settings, lines, ctx));
        return { findings, errors };
    }

    /**
     * Drift and deprecation for one declared dependency.
     *
     * The latest version comes from `npm outdated` when it named the package, and from
     * the registry otherwise. That fallback is the whole point of treating the manifest
     * as authoritative: a package absent from the outdated report is usually current,
     * but "usually" is not a fact, and a package the installed tree happens not to carry
     * would otherwise vanish from the scan entirely (REQ-NPM-014).
     */
    private async inspect(
        dependency: DeclaredDependency,
        outdated: OutdatedInputs | null,
        settings: NpmSettings,
        lines: LineIndex,
        ctx: CollectorContext,
    ): Promise<Finding[]> {
        const entry = outdated?.report[dependency.name];
        const observed = readObserved(dependency, entry);
        const subject = subjectFor(dependency, entry);
        const evidence: Evidence[] = [manifestEvidence(dependency, settings.manifest, lines)];

        let latest: LatestResolution;
        let deprecated: boolean | null = null;
        if (entry?.latest !== undefined && outdated !== null) {
            latest = {
                status: 'resolved',
                version: entry.latest,
                ref: 'npm outdated',
                method: 'npm-registry',
                confidence: 'high',
                retrievedAt: ctx.clock.nowIso(),
                reason: null,
            };
            evidence.push(outdated.evidence);
        } else {
            const ref = `npm:${dependency.name}`;
            const resolved = await ctx.sources.resolve(ref, {
                observedVersion: observed?.version,
            });
            latest = resolutionFromSource(ref, resolved, ctx.clock);
            deprecated = resolved.deprecated;
            evidence.push(...resolved.evidence);
        }

        const findings: Finding[] = [];
        const drift = buildFinding(
            {
                collector: this.id,
                kind: 'dependency-outdated',
                subject,
                title: driftTitle(dependency, observed, latest),
                detail: driftDetail(dependency, observed, latest, settings.manifest),
                declared: dependency.range,
                observed,
                latest,
                evidence,
                remediationHint:
                    latest.version === null
                        ? null
                        : `npm install ${installFlag(subject.scope)} ` +
                          `${dependency.name}@${latest.version}`,
                references: [`https://www.npmjs.com/package/${dependency.name}`],
                tags: ['npm', subject.scope],
            },
            ctx,
        );
        if (drift.versions.bump !== 'none') {
            findings.push(drift);
        }

        if (deprecated === true) {
            findings.push(this.deprecationFinding(dependency, observed, subject, evidence, ctx));
        }
        return findings;
    }

    /** A package upstream has marked deprecated, which is work regardless of drift. */
    private deprecationFinding(
        dependency: DeclaredDependency,
        observed: ParsedVersion | null,
        subject: Subject,
        evidence: readonly Evidence[],
        ctx: CollectorContext,
    ): Finding {
        return buildFinding(
            {
                collector: this.id,
                kind: 'dependency-deprecated',
                subject,
                title: `${dependency.name} ${observed?.version ?? dependency.range} is deprecated`,
                detail:
                    `The npm registry marks ${dependency.name} ` +
                    `${observed?.version ?? dependency.range} deprecated. A deprecated release ` +
                    `receives no further fixes, so this is maintenance work even if the ` +
                    `declared range is otherwise current.`,
                declared: dependency.range,
                observed,
                latest: notApplicableResolution(
                    'npm-registry',
                    'Deprecation is a property of the installed version, not of a newer one.',
                ),
                lifecycle: {
                    endOfStandardSupport: null,
                    endOfExtendedSupport: null,
                    daysUntilEndOfSupport: null,
                    deprecated: true,
                    deprecationMessage: null,
                    calendarSource: null,
                    calendarLastVerified: null,
                },
                evidence: [...evidence],
                references: [`https://www.npmjs.com/package/${dependency.name}`],
                tags: ['npm', 'deprecated'],
            },
            ctx,
        );
    }

    /**
     * Advisories, one finding per package and advisory pair.
     *
     * With one exception that a real audit document forced: a package can be reported
     * vulnerable with **no advisory at all**, its `via[]` holding only the names of the
     * transitive packages that brought the problem in. Those are often the most
     * actionable entries — a direct dependency with a fix available, where the advisory
     * itself sits on something several levels down — so an advisory-less vulnerability
     * gets its own finding rather than being dropped for lacking an identifier
     * (REQ-NPM-015, REQ-NPM-016).
     */
    private inspectAudit(
        audit: AuditInputs | null,
        declared: readonly DeclaredDependency[],
        settings: NpmSettings,
        lines: LineIndex,
        ctx: CollectorContext,
    ): Finding[] {
        if (audit === null) {
            return [];
        }
        const ignored = new Set(settings.ignore);
        const findings: Finding[] = [];

        for (const [name, vulnerability] of Object.entries(audit.report.vulnerabilities)) {
            if (ignored.has(name)) {
                continue;
            }
            const dependency = declared.find((entry) => entry.name === name);
            const subject = vulnerableSubject(name, vulnerability, dependency);
            const evidence: Evidence[] = [audit.evidence];
            if (dependency !== undefined) {
                evidence.unshift(manifestEvidence(dependency, settings.manifest, lines));
            }

            const advisories = advisoriesOf(vulnerability);
            if (advisories.length === 0) {
                findings.push(
                    this.transitiveFinding(vulnerability, subject, dependency, evidence, ctx),
                );
                continue;
            }
            for (const advisory of advisories) {
                findings.push(
                    this.advisoryFinding(
                        vulnerability,
                        advisory,
                        subject,
                        dependency,
                        evidence,
                        ctx,
                    ),
                );
            }
        }
        return findings;
    }

    private advisoryFinding(
        vulnerability: NpmVulnerability,
        advisory: NpmAdvisory,
        subject: Subject,
        dependency: DeclaredDependency | undefined,
        evidence: readonly Evidence[],
        ctx: CollectorContext,
    ): Finding {
        const identifier = advisoryId(advisory) as string;
        const fix = readFixAvailable(vulnerability.fixAvailable);
        return buildFinding(
            {
                collector: this.id,
                kind: 'dependency-vulnerable',
                subject,
                // The advisory id is the one place identity depends on something other
                // than the subject: a new CVE against the same package is new work, not
                // an update to the old issue (REQ-ID-003).
                discriminator: identifier,
                // Built from an advisory title, whose length is whatever its author
                // chose, so it is bounded before the contract rejects the finding.
                title: truncate(
                    `${identifier}: ${advisory.title ?? 'advisory'} in ${subject.displayName}`,
                    FINDING_TITLE_MAX_LENGTH,
                ),
                detail: describeAdvisory(vulnerability, advisory, identifier, fix),
                declared: dependency?.range ?? null,
                observed: null,
                latest: notApplicableResolution(
                    'npm-registry',
                    'The actionable version is the advisory fix, not the newest release.',
                ),
                advisory: {
                    id: identifier,
                    source: 'npm-audit',
                    severity: advisorySeverity(advisory.severity ?? vulnerability.severity),
                    cvssScore: advisory.cvss?.score ?? null,
                    cvssVector: advisory.cvss?.vectorString ?? null,
                    cwe: advisory.cwe ?? [],
                    title: advisory.title ?? identifier,
                    url: advisory.url ?? null,
                    vulnerableRange: advisory.range ?? vulnerability.range ?? null,
                    isDirect: vulnerability.isDirect,
                    fixAvailable: fix.available,
                    fixedVersion: fix.version,
                    fixIsSemverMajor: fix.isSemverMajor,
                },
                evidence: [...evidence],
                remediationHint: remediationFor(vulnerability, fix),
                references: advisory.url === undefined ? [] : [advisory.url],
                tags: ['npm', 'security', vulnerability.isDirect ? 'direct' : 'transitive'],
            },
            ctx,
        );
    }

    /** A vulnerable package whose `via[]` names only a transitive chain. */
    private transitiveFinding(
        vulnerability: NpmVulnerability,
        subject: Subject,
        dependency: DeclaredDependency | undefined,
        evidence: readonly Evidence[],
        ctx: CollectorContext,
    ): Finding {
        const chain = transitiveChainOf(vulnerability);
        const fix = readFixAvailable(vulnerability.fixAvailable);
        return buildFinding(
            {
                collector: this.id,
                kind: 'dependency-vulnerable',
                subject,
                // Not an advisory id, so identity has to come from somewhere stable that
                // is not a version. There is exactly one such finding per package.
                discriminator: 'transitive-only',
                title: `${subject.displayName} is vulnerable through its dependencies`,
                detail:
                    `npm audit reports ${subject.displayName} as ` +
                    `${vulnerability.severity} severity with no advisory of its own; the ` +
                    `problem reaches it through ${chain.join(' → ') || 'its dependency tree'}. ` +
                    describeFix(fix),
                declared: dependency?.range ?? null,
                observed: null,
                latest: notApplicableResolution(
                    'npm-registry',
                    'The actionable version is the audit fix, not the newest release.',
                ),
                advisory: {
                    id: `npm-audit:${subject.displayName}`,
                    source: 'npm-audit',
                    // npm's own rollup, present whether or not an advisory object is.
                    // Without it an advisory-less vulnerability would fall through to
                    // info, which is the opposite of what it deserves.
                    severity: advisorySeverity(vulnerability.severity),
                    cvssScore: null,
                    cvssVector: null,
                    cwe: [],
                    title: `${subject.displayName} is vulnerable through its dependencies`,
                    url: null,
                    vulnerableRange: vulnerability.range ?? null,
                    isDirect: vulnerability.isDirect,
                    fixAvailable: fix.available,
                    fixedVersion: fix.version,
                    fixIsSemverMajor: fix.isSemverMajor,
                },
                evidence: [...evidence],
                remediationHint: remediationFor(vulnerability, fix),
                tags: ['npm', 'security', vulnerability.isDirect ? 'direct' : 'transitive'],
            },
            ctx,
        );
    }

    private async runOutdated(
        ctx: CollectorContext,
        errors: CollectorError[],
    ): Promise<OutdatedInputs | null> {
        const result = await this.run(
            ['npm', 'outdated', '--json', '--long'],
            ctx,
            errors,
            'npm outdated',
        );
        if (result === null) {
            return null;
        }
        try {
            return { report: parseNpmOutdated(result.stdout), evidence: commandEvidence(result) };
        } catch (error: unknown) {
            errors.push(toCollectorError(toMaintenanceError(error, 'npm outdated')));
            return null;
        }
    }

    private async runAudit(
        ctx: CollectorContext,
        errors: CollectorError[],
    ): Promise<AuditInputs | null> {
        const result = await this.run(['npm', 'audit', '--json'], ctx, errors, 'npm audit');
        if (result === null) {
            return null;
        }
        try {
            return { report: parseNpmAudit(result.stdout), evidence: commandEvidence(result) };
        } catch (error: unknown) {
            errors.push(toCollectorError(toMaintenanceError(error, 'npm audit')));
            return null;
        }
    }

    /**
     * Run one npm command, recording rather than raising anything that goes wrong.
     *
     * Returning null keeps the collector going on its remaining inputs: no npm binary
     * still leaves the manifest and the registry, and a missing lockfile costs the
     * advisories but not the drift (REQ-NPM-013, REQ-NPM-019).
     */
    private async run(
        argv: readonly string[],
        ctx: CollectorContext,
        errors: CollectorError[],
        label: string,
    ): Promise<CommandResult | null> {
        let result: CommandResult;
        try {
            result = await ctx.commands.run({
                argv,
                cwd: ctx.repoRoot,
                timeoutMs: ctx.config.defaults.commandTimeoutMs,
                maxBuffer: MAX_BUFFER,
            });
        } catch (error: unknown) {
            errors.push(toCollectorError(toMaintenanceError(error, label)));
            return null;
        }
        if (!SUCCESS_CODES.has(result.exitCode)) {
            errors.push({
                code: 'command-failed',
                message:
                    `${label} exited ${result.exitCode}` +
                    `${result.stderr.length === 0 ? '' : `: ${result.stderr.trim().slice(0, 200)}`}`,
                target: label,
                retryable: false,
            });
            return null;
        }
        return result;
    }
}

interface OutdatedInputs {
    report: NpmOutdatedReport;
    evidence: Evidence;
}

interface AuditInputs {
    report: ReturnType<typeof parseNpmAudit>;
    evidence: Evidence;
}

/**
 * The version actually in use.
 *
 * `npm outdated` knows what is installed; the manifest only knows the range it asked
 * for. Where neither gives a concrete version — a package declared but not installed —
 * the range is read as loosely as it can be, so `^5.7.3` still compares as 5.7.3 rather
 * than reporting `unknown`.
 */
function readObserved(
    dependency: DeclaredDependency,
    entry: NpmOutdatedEntry | undefined,
): ParsedVersion | null {
    return parseVersionForComparison(entry?.current ?? dependency.range);
}

/**
 * Scope, preferring what npm reported over what the manifest block implied.
 *
 * `--long` labels each entry `dependencies` or `devDependencies`, which is authoritative
 * for an installed tree where a package may appear in both (REQ-NPM-018).
 */
function subjectFor(dependency: DeclaredDependency, entry: NpmOutdatedEntry | undefined): Subject {
    const scope: SubjectScope = entry?.type === 'devDependencies' ? 'dev' : dependency.scope;
    return {
        kind: 'npm-package',
        id: dependency.name,
        displayName: dependency.name,
        ecosystem: 'npm',
        scope,
    };
}

/**
 * The subject of a vulnerability.
 *
 * A vulnerable package need not be declared: most advisories land on something several
 * levels down the tree. Scope for those is `unknown` rather than guessed, so the
 * development-scope demotion cannot quietly downgrade a transitive production problem.
 */
function vulnerableSubject(
    name: string,
    vulnerability: NpmVulnerability,
    dependency: DeclaredDependency | undefined,
): Subject {
    return {
        kind: 'npm-package',
        id: name,
        displayName: name,
        ecosystem: 'npm',
        scope: dependency?.scope ?? (vulnerability.isDirect ? 'runtime' : 'unknown'),
    };
}

function manifestEvidence(
    dependency: DeclaredDependency,
    path: string,
    lines: LineIndex,
): Evidence {
    return {
        type: 'file',
        path,
        line: dependency.line,
        column: null,
        snippet: dependency.line === null ? null : lines.snippetAt(dependency.line),
        contentSha256: null,
        repo: null,
        ref: null,
    };
}

/** `--save-dev` for a development dependency, so the hint is runnable as written. */
function installFlag(scope: SubjectScope): string {
    return scope === 'dev' ? '--save-dev' : '--save';
}

/** Narrow npm's severity string to the ladder the schema declares. */
function advisorySeverity(value: string): 'critical' | 'high' | 'moderate' | 'low' | 'info' {
    return ADVISORY_SEVERITIES.has(value)
        ? (value as 'critical' | 'high' | 'moderate' | 'low' | 'info')
        : 'info';
}

function driftTitle(
    dependency: DeclaredDependency,
    observed: ParsedVersion | null,
    latest: LatestResolution,
): string {
    if (latest.version === null) {
        return `${dependency.name} could not be checked against the registry`;
    }
    return (
        `${dependency.name} is at ${observed?.version ?? dependency.range}, ` +
        `latest is ${latest.version}`
    );
}

function driftDetail(
    dependency: DeclaredDependency,
    observed: ParsedVersion | null,
    latest: LatestResolution,
    manifest: string,
): string {
    const where = `${manifest} declares ${dependency.name} as \`${dependency.range}\``;
    if (latest.version === null) {
        return (
            `${where}. The latest version could not be established` +
            `${latest.reason === null ? '' : `: ${latest.reason}`}.`
        );
    }
    const installed = observed === null ? '' : ` The version in use is ${observed.version}.`;
    return `${where}; the registry reports ${latest.version} as the latest.${installed}`;
}

function describeAdvisory(
    vulnerability: NpmVulnerability,
    advisory: NpmAdvisory,
    identifier: string,
    fix: ReturnType<typeof readFixAvailable>,
): string {
    const range = advisory.range ?? vulnerability.range;
    return (
        `${identifier} affects ${vulnerability.name}` +
        `${range === undefined ? '' : ` ${range}`} and is rated ` +
        `${advisory.severity ?? vulnerability.severity} by npm audit. ` +
        `${vulnerability.isDirect ? 'It is a direct dependency of this project.' : 'It reaches this project through the dependency tree.'} ` +
        describeFix(fix)
    );
}

function describeFix(fix: ReturnType<typeof readFixAvailable>): string {
    if (!fix.available) {
        return 'npm audit reports no fix available.';
    }
    if (fix.version === null) {
        return 'npm audit reports a fix is available.';
    }
    return (
        `A fix is available in ${fix.version}` +
        `${fix.isSemverMajor === true ? ', which is a major version change' : ''}.`
    );
}

/** Mechanical only: the command npm itself would run. No judgement about whether to. */
function remediationFor(
    vulnerability: NpmVulnerability,
    fix: ReturnType<typeof readFixAvailable>,
): string | null {
    if (!fix.available) {
        return null;
    }
    return fix.isSemverMajor === true
        ? 'npm audit fix --force (this applies a breaking change)'
        : `npm audit fix${vulnerability.isDirect ? '' : ' # resolves a transitive dependency'}`;
}
