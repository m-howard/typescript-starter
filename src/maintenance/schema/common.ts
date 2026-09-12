/**
 * Primitive vocabulary shared by every maintenance schema.
 *
 * Two constraints apply throughout `schema/`, both enforced at emission time by
 * `unrepresentable: 'throw'`: no `.default()` and no `.transform()` in the report
 * schema (defaults belong to the config schema), and no `z.date()` — dates travel as
 * ISO strings so the published JSON Schema can express them (REQ-SCH-006).
 */

import { z } from 'zod';

/** Deterministically computed impact level. Never authored by hand or by a model. */
export const SeveritySchema = z.enum(['critical', 'high', 'medium', 'low', 'info']).meta({
    id: 'Severity',
    description: 'Impact level produced by the deterministic severity rule table.',
});
export type Severity = z.infer<typeof SeveritySchema>;

/**
 * Ranking used to assert the rule table is ordered by non-increasing impact.
 *
 * That ordering is the correctness property of the table: without it a lower-tier rule
 * can shadow a higher-tier one (REQ-SEV-002).
 */
export const SEVERITY_RANK: Readonly<Record<Severity, number>> = Object.freeze({
    critical: 4,
    high: 3,
    medium: 2,
    low: 1,
    info: 0,
});

/** How much the collector trusts a resolved "latest" value. */
export const ConfidenceSchema = z.enum(['high', 'medium', 'low']).meta({
    id: 'Confidence',
    description: 'Trust in the resolved latest version, given how it was obtained.',
});
export type Confidence = z.infer<typeof ConfidenceSchema>;

/** Classification of the gap between the observed version and the latest one. */
export const SemverBumpSchema = z
    .enum(['major', 'minor', 'patch', 'prerelease', 'none', 'unknown'])
    .meta({ id: 'SemverBump' });
export type SemverBump = z.infer<typeof SemverBumpSchema>;

/** UTC ISO-8601 instant with milliseconds and no offset, e.g. `2026-09-12T06:00:00.000Z`. */
export const IsoDateTimeSchema = z.iso.datetime({ offset: false }).meta({ id: 'IsoDateTime' });

/** Calendar date with no time component, e.g. `2026-08-31`. */
export const IsoDateSchema = z.iso.date().meta({ id: 'IsoDate' });

/** Lowercase hex SHA-256 digest. */
export const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);

/** Truncated 128-bit hex digest, used for finding identity and state. */
export const ShortHashSchema = z.string().regex(/^[0-9a-f]{32}$/);

/** A fact read out of a file. */
export const FileEvidenceSchema = z.strictObject({
    type: z.literal('file'),
    path: z.string().min(1),
    line: z.number().int().positive().nullable(),
    column: z.number().int().positive().nullable(),
    snippet: z.string().max(400).nullable(),
    contentSha256: Sha256Schema.nullable(),
    /** Populated only once GitHubContentsProvider ships; null for LocalFsProvider. */
    repo: z.string().nullable(),
    ref: z.string().nullable(),
});

/** A fact produced by executing a command. */
export const CommandEvidenceSchema = z.strictObject({
    type: z.literal('command'),
    argv: z.array(z.string()).min(1),
    cwd: z.string().min(1),
    exitCode: z.number().int().nullable(),
    durationMs: z.number().int().nonnegative(),
    stdoutSha256: Sha256Schema.nullable(),
    stderrExcerpt: z.string().max(2000).nullable(),
});

/** A fact retrieved over HTTP from an upstream source. */
export const HttpEvidenceSchema = z.strictObject({
    type: z.literal('http'),
    url: z.url(),
    method: z.enum(['GET', 'HEAD']),
    status: z.number().int(),
    retrievedAt: IsoDateTimeSchema,
    etag: z.string().nullable(),
    fromCache: z.boolean(),
});

/**
 * Why a human, or the pass-2 agent, should believe a finding.
 *
 * Records observed facts only — nothing inferred or summarised (REQ-EVI-006). Every
 * finding carries at least one (REQ-EVI-001).
 */
export const EvidenceSchema = z
    .discriminatedUnion('type', [FileEvidenceSchema, CommandEvidenceSchema, HttpEvidenceSchema])
    .meta({ id: 'Evidence' });
export type Evidence = z.infer<typeof EvidenceSchema>;
