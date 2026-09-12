/**
 * Per-collector execution record.
 *
 * A collector that could not do its job says so here rather than silently returning
 * fewer findings. A missing finding reads as "healthy", which is the failure mode that
 * makes a maintenance scanner untrustworthy (REQ-ERR-033 … REQ-ERR-035).
 */

import { z } from 'zod';
import { IsoDateTimeSchema } from './common';
import { MAINTENANCE_ERROR_CODES } from '../errors';

export const CollectorIdSchema = z
    .enum(['npm', 'github-actions', 'arc', 'eks', 'images'])
    .meta({ id: 'CollectorId' });
export type CollectorId = z.infer<typeof CollectorIdSchema>;

/** Every collector id, for iteration and for building per-collector summaries. */
export const COLLECTOR_IDS = CollectorIdSchema.options;

/**
 * - `ok` — ran; every upstream resolution succeeded.
 * - `partial` — ran and emitted findings, but at least one resolution failed.
 * - `failed` — could not produce trustworthy output at all.
 * - `skipped` — disabled in config, or not selected on the command line.
 */
export const CollectorStatusSchema = z
    .enum(['ok', 'partial', 'failed', 'skipped'])
    .meta({ id: 'CollectorStatus' });
export type CollectorStatus = z.infer<typeof CollectorStatusSchema>;

/**
 * Shares its members with the runtime error hierarchy, so a caught
 * {@link ../errors.MaintenanceError} maps onto a report error without translation.
 */
export const CollectorErrorCodeSchema = z
    .enum(MAINTENANCE_ERROR_CODES)
    .meta({ id: 'CollectorErrorCode' });
export type CollectorErrorCode = z.infer<typeof CollectorErrorCodeSchema>;

export const CollectorErrorSchema = z
    .strictObject({
        code: CollectorErrorCodeSchema,
        message: z.string().min(1),
        /** What we were trying to reach: a source ref, a file path, an argv[0]. */
        target: z.string().nullable(),
        retryable: z.boolean(),
    })
    .meta({ id: 'CollectorError' });
export type CollectorError = z.infer<typeof CollectorErrorSchema>;

export const CollectorRunSchema = z
    .strictObject({
        collector: CollectorIdSchema,
        status: CollectorStatusSchema,
        startedAt: IsoDateTimeSchema,
        durationMs: z.number().int().nonnegative(),
        findingCount: z.number().int().nonnegative(),
        unresolvedCount: z.number().int().nonnegative(),
        errors: z.array(CollectorErrorSchema),
        skippedReason: z.string().nullable(),
    })
    .meta({ id: 'CollectorRun' });
export type CollectorRun = z.infer<typeof CollectorRunSchema>;
