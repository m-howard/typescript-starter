/**
 * Retrieval ACL Filter - Enforces document-level authorization at RAG retrieval time.
 *
 * Authentication (SSO/WAF at the front door) proves *who* the caller is; it does nothing to
 * stop the vector store from returning a chunk the caller is not allowed to see. This module
 * turns the caller's resolved IdP group memberships into a Bedrock metadata filter so that
 * `Retrieve`/`RetrieveAndGenerate` only ever surface chunks whose `visibility_groups` intersect
 * the caller's groups. Restricted content never reaches the model.
 *
 * Design rule: **fail closed**. A caller with no resolvable groups matches nothing. This is the
 * fix for the authorization gap where "any authenticated employee" could read restricted docs.
 */

/** Metadata key carrying the set of IdP groups permitted to see a chunk. */
export const VISIBILITY_GROUPS_KEY = 'visibility_groups';

/** Metadata key carrying a chunk's numeric classification level (0 = public, higher = tighter). */
export const CLASSIFICATION_LEVEL_KEY = 'classification_level';

/** Sentinel group applied to docs that every authenticated user may read. */
export const PUBLIC_GROUP = 'public';

/**
 * A Bedrock Knowledge Base retrieval filter expression.
 *
 * Mirrors the shape Bedrock's `RetrieveAndGenerate` accepts under
 * `retrievalConfiguration.vectorSearchConfiguration.filter`. Only the operators used by this
 * module are modelled; the union stays intentionally narrow so misuse is a compile error.
 */
export type RetrievalFilter =
    | { listContains: { key: string; value: string } }
    | { equals: { key: string; value: string | number } }
    | { lessThanOrEquals: { key: string; value: number } }
    | { andAll: RetrievalFilter[] }
    | { orAll: RetrievalFilter[] };

/** Options controlling how the ACL filter is composed. */
export interface AclFilterOptions {
    /**
     * Include the {@link PUBLIC_GROUP} sentinel so world-readable docs are always visible to an
     * authenticated caller. Defaults to `true`.
     */
    includePublic?: boolean;
    /**
     * The highest classification level the caller is cleared for. When provided, chunks are
     * additionally constrained to `classification_level <= maxClassificationLevel`, giving a
     * second, orthogonal ACL dimension on top of group membership.
     */
    maxClassificationLevel?: number;
}

/**
 * Raised when an ACL filter cannot be built safely. Surfacing this (rather than returning an
 * empty/permissive filter) keeps the retrieval path fail-closed.
 */
export class AclResolutionError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'AclResolutionError';
    }
}

/**
 * Normalise a raw list of IdP groups into a clean, de-duplicated, non-empty set.
 *
 * Trims whitespace and drops empty entries. Group comparison is case-sensitive to match the
 * exact strings emitted by the IdP and stamped onto the metadata sidecars.
 *
 * @param rawGroups - Group claims resolved from the caller's SSO token.
 * @param includePublic - Whether to fold in the {@link PUBLIC_GROUP} sentinel.
 */
export function normalizeGroups(rawGroups: readonly string[], includePublic = true): string[] {
    const cleaned = rawGroups.map((group) => group.trim()).filter((group) => group.length > 0);
    const effective = new Set(cleaned);
    if (includePublic) {
        effective.add(PUBLIC_GROUP);
    }
    return [...effective];
}

/**
 * Build the retrieval metadata filter for a caller from their resolved IdP groups.
 *
 * The resulting filter admits a chunk only when its `visibility_groups` list contains at least
 * one of the caller's effective groups (an intersection test expressed as an OR of
 * `listContains` clauses) and, when configured, its `classification_level` is within the
 * caller's clearance.
 *
 * @param rawGroups - Group claims resolved from the caller's validated SSO token.
 * @param options - {@link AclFilterOptions}.
 * @throws {AclResolutionError} when the caller has no usable non-public group and public docs
 *         are excluded — i.e. there is nothing they are allowed to see. Fail closed.
 */
export function buildAclFilter(
    rawGroups: readonly string[],
    options: AclFilterOptions = {},
): RetrievalFilter {
    const includePublic = options.includePublic ?? true;
    const effectiveGroups = normalizeGroups(rawGroups, includePublic);

    // Fail closed: without any group there is no basis to authorize retrieval.
    const hasNonPublicGroup = effectiveGroups.some((group) => group !== PUBLIC_GROUP);
    if (!hasNonPublicGroup && !includePublic) {
        throw new AclResolutionError(
            'Caller has no resolvable IdP groups; refusing to build a permissive filter.',
        );
    }

    const groupClauses: RetrievalFilter[] = effectiveGroups.map((group) => ({
        listContains: { key: VISIBILITY_GROUPS_KEY, value: group },
    }));

    // A single clause must not be wrapped in orAll (Bedrock requires >= 2 operands for orAll).
    const groupFilter: RetrievalFilter =
        groupClauses.length === 1 ? groupClauses[0] : { orAll: groupClauses };

    if (options.maxClassificationLevel === undefined) {
        return groupFilter;
    }

    return {
        andAll: [
            groupFilter,
            {
                lessThanOrEquals: {
                    key: CLASSIFICATION_LEVEL_KEY,
                    value: options.maxClassificationLevel,
                },
            },
        ],
    };
}
