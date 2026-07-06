/**
 * Tests for the retrieval ACL filter - the authorization enforcement point.
 *
 * These lock in the fail-closed behaviour and the intersection semantics that keep restricted
 * content out of a caller's retrieval results.
 */

import {
    AclResolutionError,
    buildAclFilter,
    normalizeGroups,
    PUBLIC_GROUP,
    RetrievalFilter,
    VISIBILITY_GROUPS_KEY,
    CLASSIFICATION_LEVEL_KEY,
} from '../src/rag/acl-filter';

/** Collect every `listContains` value inside a (possibly nested) filter. */
function collectGroups(filter: RetrievalFilter): string[] {
    if ('listContains' in filter) {
        return [filter.listContains.value];
    }
    if ('orAll' in filter) {
        return filter.orAll.flatMap(collectGroups);
    }
    if ('andAll' in filter) {
        return filter.andAll.flatMap(collectGroups);
    }
    return [];
}

describe('normalizeGroups', () => {
    it('trims, drops empties, and de-duplicates', () => {
        expect(normalizeGroups([' hr ', 'hr', '', '  '], false)).toEqual(['hr']);
    });

    it('folds in the public sentinel by default', () => {
        expect(normalizeGroups(['eng'])).toContain(PUBLIC_GROUP);
    });

    it('omits the public sentinel when asked', () => {
        expect(normalizeGroups(['eng'], false)).not.toContain(PUBLIC_GROUP);
    });
});

describe('buildAclFilter', () => {
    it('produces an OR of listContains clauses over the callers groups + public', () => {
        const filter = buildAclFilter(['eng', 'hr']);
        const groups = collectGroups(filter).sort();
        expect(groups).toEqual(['eng', 'hr', PUBLIC_GROUP].sort());
    });

    it('targets the visibility_groups metadata key', () => {
        const filter = buildAclFilter(['eng']);
        expect(JSON.stringify(filter)).toContain(VISIBILITY_GROUPS_KEY);
    });

    it('returns a bare clause (no orAll) for a single effective group', () => {
        const filter = buildAclFilter([], { includePublic: true });
        expect(filter).toEqual({
            listContains: { key: VISIBILITY_GROUPS_KEY, value: PUBLIC_GROUP },
        });
    });

    it('fails closed when there are no groups and public is excluded', () => {
        expect(() => buildAclFilter([], { includePublic: false })).toThrow(AclResolutionError);
        expect(() => buildAclFilter(['  ', ''], { includePublic: false })).toThrow(
            AclResolutionError,
        );
    });

    it('adds a classification ceiling when provided', () => {
        const filter = buildAclFilter(['eng'], { maxClassificationLevel: 2 });
        expect('andAll' in filter).toBe(true);
        if ('andAll' in filter) {
            const ceiling = filter.andAll.find((f) => 'lessThanOrEquals' in f);
            expect(ceiling).toEqual({
                lessThanOrEquals: { key: CLASSIFICATION_LEVEL_KEY, value: 2 },
            });
        }
    });

    it('never leaks a restricted group the caller does not hold', () => {
        const filter = buildAclFilter(['eng']);
        expect(collectGroups(filter)).not.toContain('security-restricted');
    });
});
