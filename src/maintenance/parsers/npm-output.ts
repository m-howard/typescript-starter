/**
 * Parsing `npm outdated --json --long` and `npm audit --json`.
 *
 * Both are external JSON boundaries, so both are Zod-parsed rather than cast. The audit
 * document in particular has two shape irregularities that a plain interface would
 * either crash on or silently mishandle:
 *
 * - `via[]` mixes **strings and objects**. A string names a package in a transitive
 *   chain; only an object is an advisory. Minting an advisory from a string produces a
 *   finding with a garbage identifier (REQ-NPM-016).
 * - `fixAvailable` is **`boolean | object`**.
 */

import { z } from 'zod';
import { ParseError, toError } from '../errors';
import { firstZodIssue } from '../schema/issues';

/* ------------------------------------------------------------------ outdated ----- */

/**
 * One entry of `npm outdated --json --long`.
 *
 * `current` is absent when the package is declared but not installed, so it is
 * optional rather than assumed.
 */
export const NpmOutdatedEntrySchema = z.object({
    current: z.string().optional(),
    wanted: z.string().optional(),
    latest: z.string().optional(),
    dependent: z.string().optional(),
    location: z.string().optional(),
    /** Present only with `--long`. */
    type: z.string().optional(),
    homepage: z.string().optional(),
});
export type NpmOutdatedEntry = z.infer<typeof NpmOutdatedEntrySchema>;

/** Not strict: npm adds fields between releases and that must not fail a scan. */
export const NpmOutdatedReportSchema = z.record(z.string(), NpmOutdatedEntrySchema);
export type NpmOutdatedReport = z.infer<typeof NpmOutdatedReportSchema>;

/** Parse `npm outdated --json`. An empty document means nothing is outdated. */
export function parseNpmOutdated(stdout: string): NpmOutdatedReport {
    const document = parseJson(stdout, 'npm outdated');
    const result = NpmOutdatedReportSchema.safeParse(document);
    if (!result.success) {
        throw new ParseError(
            `npm outdated output did not match the expected shape: ${firstZodIssue(result.error)}`,
            { target: 'npm outdated' },
        );
    }
    return result.data;
}

/* --------------------------------------------------------------------- audit ----- */

/** An advisory. Only object entries of `via[]` are advisories. */
export const NpmAdvisorySchema = z.object({
    source: z.number().optional(),
    name: z.string().optional(),
    dependency: z.string().optional(),
    title: z.string().optional(),
    url: z.string().optional(),
    severity: z.string().optional(),
    cwe: z.array(z.string()).optional(),
    cvss: z
        .object({ score: z.number().optional(), vectorString: z.string().nullable().optional() })
        .optional(),
    range: z.string().optional(),
});
export type NpmAdvisory = z.infer<typeof NpmAdvisorySchema>;

/** A string entry names a package in a transitive chain, not an advisory. */
export const NpmViaSchema = z.union([z.string(), NpmAdvisorySchema]);

export const NpmFixAvailableSchema = z.union([
    z.boolean(),
    z.object({
        name: z.string().optional(),
        version: z.string().optional(),
        isSemVerMajor: z.boolean().optional(),
    }),
]);
export type NpmFixAvailable = z.infer<typeof NpmFixAvailableSchema>;

export const NpmVulnerabilitySchema = z.object({
    name: z.string(),
    severity: z.string(),
    isDirect: z.boolean(),
    via: z.array(NpmViaSchema).default([]),
    effects: z.array(z.string()).default([]),
    range: z.string().optional(),
    nodes: z.array(z.string()).default([]),
    fixAvailable: NpmFixAvailableSchema.default(false),
});
export type NpmVulnerability = z.infer<typeof NpmVulnerabilitySchema>;

export const NpmAuditReportSchema = z.object({
    vulnerabilities: z.record(z.string(), NpmVulnerabilitySchema).default({}),
    metadata: z.unknown().optional(),
});
export type NpmAuditReport = z.infer<typeof NpmAuditReportSchema>;

/** Parse `npm audit --json`. */
export function parseNpmAudit(stdout: string): NpmAuditReport {
    const document = parseJson(stdout, 'npm audit');
    const result = NpmAuditReportSchema.safeParse(document);
    if (!result.success) {
        throw new ParseError(
            `npm audit output did not match the expected shape: ${firstZodIssue(result.error)}`,
            { target: 'npm audit' },
        );
    }
    return result.data;
}

/**
 * The distinct advisories affecting a package.
 *
 * Filters `via[]` down to object entries, discarding the transitive-chain strings. An
 * advisory with no identifiable id is discarded too: a finding keyed on `undefined`
 * would collide with every other one.
 *
 * Deduplicated by identifier, because npm lists an advisory once per affected path
 * rather than once per advisory — `minimatch` in this repository's own audit reports
 * GHSA-3ppc-4f35-3m26 three times. Emitting a finding per entry would put three findings
 * carrying the same fingerprint into one report, which the publish stage cannot tell
 * apart (REQ-NPM-015).
 */
export function advisoriesOf(vulnerability: NpmVulnerability): NpmAdvisory[] {
    const byId = new Map<string, NpmAdvisory>();
    for (const entry of vulnerability.via) {
        if (typeof entry === 'string') {
            continue;
        }
        const id = advisoryId(entry);
        if (id !== null && !byId.has(id)) {
            byId.set(id, entry);
        }
    }
    return [...byId.values()];
}

/**
 * A stable identifier for an advisory.
 *
 * Prefers the GHSA identifier from the advisory URL, which is what a human recognises
 * and what the GitHub advisory database is keyed on; falls back to npm's numeric
 * source id.
 */
export function advisoryId(advisory: NpmAdvisory): string | null {
    const ghsa = advisory.url?.match(/GHSA-[0-9a-z-]+/i)?.[0];
    if (ghsa !== undefined) {
        return ghsa;
    }
    return advisory.source === undefined ? null : `npm-${advisory.source}`;
}

/** The package names named in `via[]` as transitive chain links. */
export function transitiveChainOf(vulnerability: NpmVulnerability): string[] {
    return vulnerability.via.filter((entry): entry is string => typeof entry === 'string');
}

/** Normalise `fixAvailable` into the two facts a finding records. */
export function readFixAvailable(fix: NpmFixAvailable): {
    available: boolean;
    version: string | null;
    isSemverMajor: boolean | null;
} {
    if (typeof fix === 'boolean') {
        return { available: fix, version: null, isSemverMajor: null };
    }
    return {
        available: true,
        version: fix.version ?? null,
        isSemverMajor: fix.isSemVerMajor ?? null,
    };
}

/* --------------------------------------------------------------------- shared ---- */

function parseJson(stdout: string, label: string): unknown {
    const trimmed = stdout.trim();
    if (trimmed.length === 0) {
        // A clean run can print nothing at all rather than an empty object.
        return {};
    }
    try {
        return JSON.parse(trimmed);
    } catch (error: unknown) {
        throw new ParseError(`${label} output was not valid JSON: ${toError(error).message}`, {
            target: label,
        });
    }
}
