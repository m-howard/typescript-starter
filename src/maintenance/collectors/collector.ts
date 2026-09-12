/**
 * Running a collector and deriving its status.
 *
 * Status is derived in exactly one place. Left to each collector it drifts immediately:
 * one reports `ok` having failed half its lookups, another reports `failed` having
 * produced perfectly good findings, and the report's worst-status rollup stops meaning
 * anything (REQ-ERR-033 … REQ-ERR-035).
 *
 * A collector that throws is the case worth being careful about. Returning nothing would
 * make the surface it covers read as healthy, which is the failure mode that makes a
 * maintenance scanner untrustworthy — so the throw becomes one synthetic finding as well
 * as a `failed` status (REQ-ERR-031).
 */

import { kebabToCamel } from '../../utils/helpers';
import { Collector, CollectorContext, CollectorOutput } from '../types';

import { CollectorError, CollectorRun, CollectorStatus, Finding } from '../schema';
import { MaintenanceConfig } from '../schema/config';
import { InternalError, MaintenanceError, toMaintenanceError } from '../errors';
import { buildFinding } from './build-finding';

export interface RunCollectorResult {
    run: CollectorRun;
    findings: Finding[];
}

export interface RunCollectorOptions {
    /**
     * Skip the collector regardless of configuration, recording this as the reason.
     *
     * Set when the command line narrowed the run to a subset of collectors. Kept
     * separate from `isEnabled` so a report distinguishes "you did not ask for this"
     * from "this repository does not configure it".
     */
    skipReason?: string;
}

/** Run one collector, converting whatever happens into a status and a set of findings. */
export async function runCollector(
    collector: Collector,
    ctx: CollectorContext,
    options: RunCollectorOptions = {},
): Promise<RunCollectorResult> {
    const startedAt = ctx.clock.nowIso();
    const startedMs = ctx.clock.monotonicMs();

    const skippedReason = options.skipReason ?? disabledReason(collector, ctx.config);
    if (skippedReason !== null) {
        ctx.logger.debug(`Skipping the ${collector.id} collector: ${skippedReason}`);
        return {
            findings: [],
            run: buildRun(collector, 'skipped', startedAt, 0, [], [], skippedReason, ctx),
        };
    }

    let output: CollectorOutput;
    try {
        output = await collector.collect(ctx);
    } catch (error: unknown) {
        const failure = toMaintenanceError(error, collector.id);
        ctx.logger.error(`The ${collector.id} collector failed`, failure);
        const synthetic = buildFailureFinding(collector, failure, ctx);
        return {
            findings: [synthetic],
            run: buildRun(
                collector,
                'failed',
                startedAt,
                startedMs,
                [synthetic],
                [toCollectorError(failure)],
                null,
                ctx,
            ),
        };
    }

    return {
        findings: output.findings,
        run: buildRun(
            collector,
            deriveStatus(output),
            startedAt,
            startedMs,
            output.findings,
            output.errors,
            null,
            ctx,
        ),
    };
}

/**
 * Status for a collector that returned normally.
 *
 * Errors alongside findings is `partial`: the collector did useful work but its picture
 * is incomplete. Errors with nothing to show is `failed` — there is no evidence the
 * surface was examined at all.
 */
export function deriveStatus(output: CollectorOutput): CollectorStatus {
    if (output.errors.length === 0) {
        return 'ok';
    }
    return output.findings.length > 0 ? 'partial' : 'failed';
}

/** Translate a runtime error into the report's structured form. */
export function toCollectorError(error: MaintenanceError): CollectorError {
    return {
        code: error.code,
        message: error.message,
        target: error.target,
        retryable: error.retryable,
    };
}

/**
 * The configuration block for a collector that `runCollector` has already admitted.
 *
 * Absence is an invariant violation rather than a condition to handle: `runCollector`
 * skips an unconfigured collector before `collect` is ever called. Narrowing it here
 * keeps that reasoning in one place instead of an optional-chain in every collector.
 */
export function collectorSettings<K extends keyof MaintenanceConfig['collectors']>(
    config: MaintenanceConfig,
    key: K,
): NonNullable<MaintenanceConfig['collectors'][K]> {
    const settings = config.collectors[key];
    if (settings === undefined) {
        throw new InternalError(
            `The ${key} collector ran without a collectors.${key} configuration block.`,
            { target: String(key) },
        );
    }
    return settings as NonNullable<MaintenanceConfig['collectors'][K]>;
}

/**
 * Why a collector is being skipped, or null when it should run.
 *
 * The configuration key is found by converting the collector id rather than by a lookup
 * table, so adding a collector cannot leave a stale mapping behind.
 */
function disabledReason(collector: Collector, config: MaintenanceConfig): string | null {
    const key = kebabToCamel(collector.id);
    if (!(key in config.collectors)) {
        return `collectors.${key} is not present in the configuration.`;
    }
    return collector.isEnabled(config) ? null : `collectors.${key}.enabled is false.`;
}

/**
 * The single finding standing in for a collector that could not run.
 *
 * Scored `info` by the pre-emptive unresolved guard, and deliberately so: we do not know
 * what we failed to see, so claiming impact would be inventing it. The `failed` run
 * status is what a reader acts on; this finding exists so the gap is visible in the
 * findings list too.
 */
function buildFailureFinding(
    collector: Collector,
    error: MaintenanceError,
    ctx: CollectorContext,
): Finding {
    return buildFinding(
        {
            collector: collector.id,
            kind: 'upstream-unresolved',
            subject: {
                kind: 'collector',
                id: collector.id,
                displayName: `${collector.id} collector`,
                ecosystem: null,
                scope: 'infra',
            },
            title: `The ${collector.id} collector failed to run`,
            detail:
                `The ${collector.id} collector threw before returning any result, so this ` +
                `run says nothing about the surface it covers. ${error.message}` +
                (error.target === null ? '' : ` (target: ${error.target})`),
            declared: null,
            observed: null,
            latest: {
                status: 'unresolved',
                version: null,
                ref: null,
                method: 'not-attempted',
                confidence: 'low',
                retrievedAt: null,
                reason: `${error.code}: ${error.message}`,
            },
            evidence: [
                {
                    type: 'file',
                    path: ctx.configPath,
                    line: null,
                    column: null,
                    snippet: null,
                    contentSha256: null,
                    repo: null,
                    ref: null,
                },
            ],
            remediationHint: error.retryable
                ? 'Re-run the scan; the underlying failure is transient.'
                : null,
            tags: ['collector-failure', error.code],
        },
        ctx,
    );
}

function buildRun(
    collector: Collector,
    status: CollectorStatus,
    startedAt: string,
    startedMs: number,
    findings: readonly Finding[],
    errors: readonly CollectorError[],
    skippedReason: string | null,
    ctx: CollectorContext,
): CollectorRun {
    return {
        collector: collector.id,
        status,
        startedAt,
        // Rounded rather than truncated, and floored at zero: the monotonic source is
        // non-decreasing, so a negative value would be a bug rather than a clock jump.
        durationMs: Math.max(0, Math.round(ctx.clock.monotonicMs() - startedMs)),
        findingCount: findings.length,
        unresolvedCount: findings.filter((finding) => finding.unresolved).length,
        errors: [...errors],
        skippedReason,
    };
}
