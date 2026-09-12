/**
 * Resolving the latest version of a maintainable thing.
 *
 * Collectors discover what version is *declared*; sources resolve what version is
 * *available*. Keeping the two apart is what lets each be tested on its own, and what
 * lets one collector's subject be resolved by whichever upstream actually publishes it.
 *
 * Every resolution carries its method and confidence, so a reader can tell a live
 * registry lookup from a committed table (REQ-EVI-005).
 */

import { Confidence, Evidence, ProvenanceMethodSchema } from '../schema';
import { z } from 'zod';

export type ProvenanceMethod = z.infer<typeof ProvenanceMethodSchema>;

/** The scheme half of a source reference, e.g. the `npm` in `npm:typescript`. */
export const SOURCE_SCHEMES = [
    'npm',
    'github-release',
    'github-tag',
    'oci',
    'helm',
    'static',
] as const;
export type SourceScheme = (typeof SOURCE_SCHEMES)[number];

/** A parsed `<scheme>:<identifier>` reference. */
export interface VersionRef {
    scheme: SourceScheme;
    /** Everything after the first colon, e.g. `actions/checkout`. */
    identifier: string;
    /** The reference as written, for evidence and error messages. */
    raw: string;
}

/**
 * Parse a source reference.
 *
 * Splits on the first colon only, because an OCI identifier can itself contain one
 * (`oci:registry:5000/repo`).
 */
export function parseVersionRef(raw: string): VersionRef | null {
    const separator = raw.indexOf(':');
    if (separator <= 0) {
        return null;
    }
    const scheme = raw.slice(0, separator);
    const identifier = raw.slice(separator + 1);
    if (!isScheme(scheme) || identifier.length === 0) {
        return null;
    }
    return { scheme, identifier, raw };
}

function isScheme(value: string): value is SourceScheme {
    return (SOURCE_SCHEMES as readonly string[]).includes(value);
}

/** What a collector asks a source for. */
export interface ResolveRequest {
    ref: VersionRef;
    /** Restricts which tags are considered, before strict parsing. */
    tagPattern?: RegExp;
    /** Include prereleases in selection. Off by default. */
    includePrereleases?: boolean;
    /**
     * The version the collector observed, when it wants to know more about that one
     * specifically — today, whether upstream has deprecated it.
     *
     * Asked here rather than through a second method so the answer comes from the same
     * fetch, and so a collector holding only the registry can still get it.
     */
    observedVersion?: string;
}

/**
 * The outcome of a resolution.
 *
 * `unresolved` is a first-class result rather than an exception, so a collector can
 * carry it straight onto a finding without inventing a version (REQ-ERR-030).
 */
export interface ResolvedVersion {
    status: 'resolved' | 'unresolved';
    /** Normalised version when resolved, null otherwise. */
    version: string | null;
    /** Exactly what upstream returned, for evidence. */
    raw: string | null;
    method: ProvenanceMethod;
    confidence: Confidence;
    /** Why, when unresolved. Always populated in that case. */
    reason: string | null;
    /**
     * Whether upstream marks the observed version deprecated.
     *
     * Null when not asked or not knowable. A deprecated dependency is maintenance work
     * even when it is on its latest version, so this is a fact in its own right rather
     * than a version comparison (REQ-NPM-017).
     */
    deprecated: boolean | null;
    /** Whatever was observed while resolving: the URL fetched, the command run. */
    evidence: Evidence[];
}

export interface VersionSource {
    readonly scheme: SourceScheme;
    resolve(request: ResolveRequest): Promise<ResolvedVersion>;
}

/** Build an unresolved result, so the reason is never accidentally omitted. */
export function unresolved(
    method: ProvenanceMethod,
    reason: string,
    evidence: Evidence[] = [],
): ResolvedVersion {
    return {
        status: 'unresolved',
        version: null,
        raw: null,
        method,
        confidence: 'low',
        reason,
        deprecated: null,
        evidence,
    };
}

/** Build a resolved result. */
export function resolved(
    version: string,
    raw: string,
    method: ProvenanceMethod,
    confidence: Confidence,
    evidence: Evidence[] = [],
): ResolvedVersion {
    return {
        status: 'resolved',
        version,
        raw,
        method,
        confidence,
        reason: null,
        deprecated: null,
        evidence,
    };
}
