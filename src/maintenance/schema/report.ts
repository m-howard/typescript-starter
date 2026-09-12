/**
 * The artifact handed to the pass-2 assess stage.
 *
 * Note this root schema deliberately carries no `.meta({ id })`: a named root is
 * hoisted into `$defs` and the emitted document becomes a bare `$ref` with no top-level
 * `properties`. Leaving it unnamed yields the conventional shape consumers expect,
 * while named subschemas nested inside it still land in `$defs`.
 */

import { z } from 'zod';
import { IsoDateTimeSchema, Sha256Schema } from './common';
import { CollectorRunSchema, CollectorStatusSchema } from './collector-run';
import { FindingSchema } from './finding';

/**
 * Additive changes bump the minor and stay in `maintenance-report.v1.json`. Any
 * removal, rename or narrowing bumps the major AND emits a new v2 file alongside it.
 * See `docs/maintenance/schema-contract.md`.
 */
export const REPORT_SCHEMA_VERSION = '1.0.0';

/** Config schema version, distinct from the report's. */
export const CONFIG_SCHEMA_VERSION = 1;

const CountSchema = z.number().int().nonnegative();

export const ReportSummarySchema = z
    .strictObject({
        totalFindings: CountSchema,
        bySeverity: z.strictObject({
            critical: CountSchema,
            high: CountSchema,
            medium: CountSchema,
            low: CountSchema,
            info: CountSchema,
        }),
        byCollector: z.strictObject({
            npm: CountSchema,
            'github-actions': CountSchema,
            arc: CountSchema,
            eks: CountSchema,
            images: CountSchema,
        }),
        /** Read this before reading the findings: it bounds what the scan established. */
        unresolvedCount: CountSchema,
        /** Worst status across all non-skipped collector runs. */
        worstStatus: CollectorStatusSchema,
    })
    .meta({ id: 'ReportSummary' });
export type ReportSummary = z.infer<typeof ReportSummarySchema>;

export const MaintenanceReportSchema = z.strictObject({
    schemaVersion: z.literal(REPORT_SCHEMA_VERSION),
    stage: z.literal('collect'),
    /** The only field expected to differ between two runs over unchanged inputs. */
    generatedAt: IsoDateTimeSchema,
    repository: z.strictObject({
        name: z.string().min(1),
        owner: z.string().nullable(),
        commitSha: z.string().nullable(),
        ref: z.string().nullable(),
    }),
    runtime: z.strictObject({
        node: z.string().min(1),
        npm: z.string().nullable(),
        platform: z.string().min(1),
        offline: z.boolean(),
    }),
    /** Ties a report to the inventory that produced it. */
    config: z.strictObject({
        path: z.string().min(1),
        sha256: Sha256Schema,
        version: z.literal(CONFIG_SCHEMA_VERSION),
    }),
    collectorRuns: z.array(CollectorRunSchema),
    /** Sorted by severity descending, then collector, then id, for stable diffs. */
    findings: z.array(FindingSchema),
    summary: ReportSummarySchema,
});
export type MaintenanceReport = z.infer<typeof MaintenanceReportSchema>;
