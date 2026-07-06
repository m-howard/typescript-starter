/**
 * Tests for ingestion metadata sidecars - keeps the ingestion-side tags in lockstep with the
 * retrieval-side filter keys.
 */

import { buildSidecar, CLASSIFICATION_LEVELS } from '../src/rag/metadata';
import {
    CLASSIFICATION_LEVEL_KEY,
    PUBLIC_GROUP,
    VISIBILITY_GROUPS_KEY,
} from '../src/rag/acl-filter';

describe('buildSidecar', () => {
    it('emits filterable visibility groups and a numeric classification level', () => {
        const sidecar = buildSidecar({
            visibilityGroups: ['hr', 'legal'],
            classification: 'confidential',
        });
        expect(sidecar.metadataAttributes[VISIBILITY_GROUPS_KEY].sort()).toEqual(['hr', 'legal']);
        expect(sidecar.metadataAttributes[CLASSIFICATION_LEVEL_KEY]).toBe(
            CLASSIFICATION_LEVELS.confidential,
        );
    });

    it('defaults an untagged doc to internal', () => {
        const sidecar = buildSidecar({ visibilityGroups: ['eng'] });
        expect(sidecar.metadataAttributes[CLASSIFICATION_LEVEL_KEY]).toBe(
            CLASSIFICATION_LEVELS.internal,
        );
    });

    it('treats a doc with no groups as public', () => {
        const sidecar = buildSidecar({ visibilityGroups: [] });
        expect(sidecar.metadataAttributes[VISIBILITY_GROUPS_KEY]).toEqual([PUBLIC_GROUP]);
    });

    it('always includes the public sentinel for public classification', () => {
        const sidecar = buildSidecar({ visibilityGroups: ['eng'], classification: 'public' });
        expect(sidecar.metadataAttributes[VISIBILITY_GROUPS_KEY]).toContain(PUBLIC_GROUP);
        expect(sidecar.metadataAttributes[CLASSIFICATION_LEVEL_KEY]).toBe(0);
    });

    it('de-duplicates and trims groups and preserves source path', () => {
        const sidecar = buildSidecar({
            visibilityGroups: [' eng ', 'eng'],
            sourcePath: 'docs/guide.md',
        });
        expect(sidecar.metadataAttributes[VISIBILITY_GROUPS_KEY]).toEqual(['eng']);
        expect(sidecar.metadataAttributes.source_path).toBe('docs/guide.md');
    });
});
