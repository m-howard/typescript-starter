/**
 * Finding identity.
 *
 * Two hashes with distinct jobs, because the publish stage needs to answer two
 * different questions (`docs/maintenance/adr/0003-two-hash-finding-identity.md`):
 *
 * - `fingerprint` — "is there already an issue for this?" Stable while the subject
 *   exists, regardless of version movement.
 * - `stateHash` — "has anything changed since I last edited that issue?"
 *
 * With only the first, the stage rewrites every issue every run or never refreshes a
 * stale one. With only the second, a weekly scan files a fresh duplicate every time a
 * dependency releases.
 */

import { createHash } from 'crypto';
import { CollectorId } from '../schema/collector-run';
import { FINGERPRINT_VERSION, FindingKind, SemverBump, Severity } from '../schema';
import { SubjectKind } from '../schema/finding';

/**
 * Field separator for hash inputs.
 *
 * A NUL byte cannot occur in any of the joined values, so no combination of field
 * contents can be mistaken for a different combination.
 */
const FIELD_SEPARATOR = '\u0000';

/**
 * Stands in for an absent value.
 *
 * Mapping null to the empty string would make `latest: null` (we could not resolve it)
 * hash identically to `latest: ''`. Neither is a meaningful version, but an identity
 * function should not depend on that staying true. A control character cannot occur in
 * a version, package name or path, so the two states stay distinguishable.
 */
const ABSENT = '\u0001';

/** Hash width in hex characters — 128 bits, ample against collision at this scale. */
const HASH_LENGTH = 32;

/** Render an optional hash input, distinguishing absent from empty. */
function present(value: string | null): string {
    return value ?? ABSENT;
}

/**
 * The identity axes of a finding.
 *
 * Deliberately excludes every value that changes over time: versions, severity,
 * evidence positions, and free text (REQ-ID-001, REQ-ID-002).
 */
export interface FingerprintInput {
    collector: CollectorId;
    subjectKind: SubjectKind;
    /**
     * Globally-identifiable subjects use their global name (`typescript`); file-scoped
     * subjects are path-qualified but never line-qualified.
     */
    subjectId: string;
    kind: FindingKind;
    /**
     * Extra identity axis, e.g. a GHSA id. The one exception to version-independence:
     * a new advisory against the same package is genuinely new work (REQ-ID-003).
     */
    discriminator: string | null;
}

/** The mutable facts the publish stage watches for change (REQ-ID-004). */
export interface StateHashInput {
    declared: string | null;
    observed: string | null;
    latest: string | null;
    bump: SemverBump;
    severity: Severity;
    unresolved: boolean;
    advisoryFixedVersion: string | null;
}

/** Stable 128-bit identity for a finding. */
export function computeFingerprint(input: FingerprintInput): string {
    return digest([
        FINGERPRINT_VERSION,
        input.collector,
        input.subjectKind,
        input.subjectId,
        input.kind,
        present(input.discriminator),
    ]);
}

/**
 * Hash over the facts that may legitimately change while identity holds.
 *
 * Fields are listed explicitly rather than derived from `Object.keys`, so the hash
 * cannot silently change with property declaration order (REQ-ID-005).
 */
export function computeStateHash(input: StateHashInput): string {
    return digest([
        present(input.declared),
        present(input.observed),
        present(input.latest),
        input.bump,
        input.severity,
        String(input.unresolved),
        present(input.advisoryFixedVersion),
    ]);
}

/**
 * Human-readable twin of the fingerprint, built from the same inputs (REQ-ID-006).
 *
 * People grep the id; machines match the fingerprint. The finding kind is used
 * verbatim rather than abbreviated, so an id can be grepped by exact kind and there is
 * no abbreviation map to drift out of sync with `FindingKind`.
 */
export function buildFindingId(input: FingerprintInput): string {
    const segments = [input.collector, input.kind, input.subjectId];
    if (input.discriminator !== null && input.discriminator !== '') {
        segments.push(input.discriminator);
    }
    return segments
        .map(slugify)
        .filter((segment) => segment.length > 0)
        .join('/');
}

/**
 * Reduce a value to the character set the `Finding.id` pattern allows.
 *
 * Anything outside `[a-z0-9_.\-@]` becomes a hyphen, so a subject id containing a path
 * separator, a colon or a `#` still yields a valid id.
 */
function slugify(value: string): string {
    return value
        .toLowerCase()
        .replace(/[^a-z0-9_.\-@]+/g, '-')
        .replace(/-{2,}/g, '-')
        .replace(/^[-.]+|-+$/g, '');
}

function digest(parts: readonly string[]): string {
    return createHash('sha256')
        .update(parts.join(FIELD_SEPARATOR))
        .digest('hex')
        .slice(0, HASH_LENGTH);
}
