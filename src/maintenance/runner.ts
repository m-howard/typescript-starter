/**
 * Running every collector and assembling the report.
 *
 * The report is the whole product of this stage, and its value rests on two properties
 * the collectors cannot enforce individually:
 *
 * - **Every configured collector appears**, including the ones that were skipped or
 *   failed. A surface missing from the report reads as a surface with nothing wrong
 *   (REQ-RPT-001).
 * - **Two runs over unchanged inputs differ only in timestamps.** Findings are sorted,
 *   summary counts are derived from the findings rather than accumulated alongside them,
 *   and every duration comes from the injected clock (REQ-RPT-002 … REQ-RPT-005).
 */

import {
    CollectorId,
    CollectorRun,
    CollectorStatus,
    Finding,
    MaintenanceReport,
    MaintenanceReportSchema,
    REPORT_SCHEMA_VERSION,
    SEVERITY_RANK,
    Severity,
    ReportSummary,
} from './schema';
import { CONFIG_SCHEMA_VERSION } from './schema/report';
import { COLLECTOR_IDS } from './schema/collector-run';
import { Collector, CollectorContext } from './types';
import { runCollector } from './collectors/collector';
import { InternalError } from './errors';
import { formatZodIssues } from './schema/issues';
import { LoadedConfig } from './config/load-config';

/** Everything the report records about where and how the scan ran. */
export interface RunEnvironment {
    repository: MaintenanceReport['repository'];
    runtime: MaintenanceReport['runtime'];
}

export interface RunOptions {
    collectors: readonly Collector[];
    context: CollectorContext;
    config: LoadedConfig;
    environment: RunEnvironment;
    /**
     * Collector ids the caller asked for. Anything else is recorded as skipped with a
     * reason rather than omitted, so a narrowed run still accounts for every surface
     * (REQ-CLI-006).
     */
    selected?: readonly CollectorId[];
}

/** Run the collectors and assemble a validated report. */
export async function runCollectors(options: RunOptions): Promise<MaintenanceReport> {
    const { context, config, environment } = options;
    const generatedAt = context.clock.nowIso();
    const runs: CollectorRun[] = [];
    const findings: Finding[] = [];

    for (const collector of options.collectors) {
        const result = await runCollector(collector, context, {
            skipReason: skipReasonFor(collector.id, options.selected),
        });
        runs.push(result.run);
        findings.push(...result.findings);
    }

    assertDistinctFingerprints(findings);
    const sorted = sortFindings(findings);

    const report: MaintenanceReport = {
        schemaVersion: REPORT_SCHEMA_VERSION,
        stage: 'collect',
        generatedAt,
        repository: environment.repository,
        runtime: environment.runtime,
        config: { path: config.path, sha256: config.sha256, version: CONFIG_SCHEMA_VERSION },
        collectorRuns: runs,
        findings: sorted,
        summary: summarise(sorted, runs),
    };

    // Validated before it is written, so a malformed report never reaches the pass-2
    // stage or a consumer validating against the published JSON Schema (REQ-RPT-007).
    const result = MaintenanceReportSchema.safeParse(report);
    if (!result.success) {
        throw new InternalError(
            `Assembled an invalid maintenance report: ${formatZodIssues(result.error).join('; ')}`,
            { target: config.path, cause: result.error },
        );
    }
    return result.data;
}

/**
 * Order findings for a stable diff.
 *
 * Severity first because that is the reading order; then collector and id, which are
 * both stable across runs. Sorting on anything version-dependent would reshuffle the
 * file on every upstream release and make artifact-to-artifact diffing useless
 * (REQ-RPT-002).
 */
export function sortFindings(findings: readonly Finding[]): Finding[] {
    return [...findings].sort((a, b) => {
        const bySeverity = SEVERITY_RANK[b.severity.severity] - SEVERITY_RANK[a.severity.severity];
        if (bySeverity !== 0) {
            return bySeverity;
        }
        const byCollector = a.collector.localeCompare(b.collector);
        return byCollector === 0 ? a.id.localeCompare(b.id) : byCollector;
    });
}

/**
 * Counts derived from the findings, never accumulated alongside them.
 *
 * A counter incremented as findings are produced drifts from the array the moment one
 * is filtered out somewhere, and a summary that disagrees with its own detail is worse
 * than no summary (REQ-RPT-003).
 */
export function summarise(
    findings: readonly Finding[],
    runs: readonly CollectorRun[],
): ReportSummary {
    const bySeverity = emptySeverityCounts();
    const byCollector = emptyCollectorCounts();
    let unresolvedCount = 0;

    for (const finding of findings) {
        bySeverity[finding.severity.severity] += 1;
        byCollector[finding.collector] += 1;
        if (finding.unresolved) {
            unresolvedCount += 1;
        }
    }

    return {
        totalFindings: findings.length,
        bySeverity,
        byCollector,
        unresolvedCount,
        worstStatus: worstStatus(runs),
    };
}

/**
 * The worst status any collector reached.
 *
 * `skipped` is the floor rather than a degradation: a repository that configures two
 * collectors and skips three has not had a bad run, it has had the run it asked for.
 */
export function worstStatus(runs: readonly CollectorRun[]): CollectorStatus {
    const order: CollectorStatus[] = ['failed', 'partial', 'ok', 'skipped'];
    for (const status of order) {
        if (runs.some((run) => run.status === status)) {
            return status;
        }
    }
    /* istanbul ignore next -- there is always at least one collector to run. */
    return 'skipped';
}

/**
 * Refuse a report containing two findings with the same fingerprint.
 *
 * The publish stage matches an open issue by fingerprint, so a duplicate means it
 * either opens one issue for two problems or rewrites the same issue twice per run.
 * This is checked in the product rather than only in specs because it caught two real
 * defects while the collectors were being written — several occurrences of one subject,
 * and `npm audit` listing an advisory once per affected path — and neither surfaced as
 * a crash (ADR-0003).
 */
export function assertDistinctFingerprints(findings: readonly Finding[]): void {
    const seen = new Map<string, string>();
    for (const finding of findings) {
        const previous = seen.get(finding.fingerprint);
        if (previous !== undefined) {
            throw new InternalError(
                `Two findings share the fingerprint ${finding.fingerprint}: ` +
                    `${previous} and ${finding.id}. The publish stage cannot tell them apart.`,
                { target: finding.id },
            );
        }
        seen.set(finding.fingerprint, finding.id);
    }
}

/** Why a collector is being skipped by the caller's selection, or undefined to run it. */
function skipReasonFor(
    id: CollectorId,
    selected: readonly CollectorId[] | undefined,
): string | undefined {
    if (selected === undefined || selected.includes(id)) {
        return undefined;
    }
    return `Not selected: this run was limited to ${selected.join(', ')}.`;
}

function emptySeverityCounts(): Record<Severity, number> {
    return { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
}

/**
 * Every collector id at zero.
 *
 * Built from the schema's own list so a new collector cannot be added without appearing
 * in the summary, where a missing key would be a schema failure rather than a silent
 * omission.
 */
function emptyCollectorCounts(): Record<CollectorId, number> {
    const counts = {} as Record<CollectorId, number>;
    for (const id of COLLECTOR_IDS) {
        counts[id] = 0;
    }
    return counts;
}
