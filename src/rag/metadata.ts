/**
 * Ingestion Metadata Sidecars - Builds the `.metadata.json` documents that carry per-chunk ACLs.
 *
 * Every markdown doc gets a sidecar emitted in the same CI step that syncs it to S3, so the
 * access tags are always in lockstep with the content. Bedrock stores these as *filterable
 * metadata* on each chunk, which is what {@link buildAclFilter} later filters against at query
 * time. Keeping the sidecar shape here (rather than hand-rolling JSON in CI) guarantees the
 * ingestion side and the retrieval side agree on keys.
 */

import { CLASSIFICATION_LEVEL_KEY, PUBLIC_GROUP, VISIBILITY_GROUPS_KEY } from './acl-filter';

/**
 * Named classification tiers mapped to the numeric level enforced by the ACL filter.
 * Lower is more open; higher is more restricted.
 */
export const CLASSIFICATION_LEVELS = {
    public: 0,
    internal: 1,
    confidential: 2,
    restricted: 3,
} as const;

/** A human-facing classification name. */
export type Classification = keyof typeof CLASSIFICATION_LEVELS;

/** Inputs describing a single document's access posture. */
export interface DocMetadataInput {
    /**
     * IdP groups permitted to read the doc, derived from repo permissions plus front-matter.
     * Empty means the doc is public (see {@link buildSidecar}).
     */
    visibilityGroups: readonly string[];
    /** Classification tier; defaults to `internal` when omitted. */
    classification?: Classification;
    /** Source path in the docs repo, retained for citations and audit. */
    sourcePath?: string;
}

/**
 * The Bedrock sidecar document shape. `metadataAttributes` is the exact envelope Bedrock reads;
 * every attribute here becomes filterable metadata on the doc's chunks.
 */
export interface DocSidecar {
    metadataAttributes: {
        [VISIBILITY_GROUPS_KEY]: string[];
        [CLASSIFICATION_LEVEL_KEY]: number;
        source_path?: string;
    };
}

/**
 * Build the `.metadata.json` sidecar for a document.
 *
 * A doc with no explicit visibility groups is treated as world-readable and tagged with the
 * {@link PUBLIC_GROUP} sentinel, so it matches any authenticated caller's filter. Groups are
 * de-duplicated and the public sentinel is always folded in for a `public` classification so
 * that classification and group tags never disagree.
 *
 * @param input - {@link DocMetadataInput}.
 */
export function buildSidecar(input: DocMetadataInput): DocSidecar {
    const classification: Classification = input.classification ?? 'internal';
    const level = CLASSIFICATION_LEVELS[classification];

    const groups = new Set(
        input.visibilityGroups.map((group) => group.trim()).filter((group) => group.length > 0),
    );
    if (groups.size === 0 || classification === 'public') {
        groups.add(PUBLIC_GROUP);
    }

    const sidecar: DocSidecar = {
        metadataAttributes: {
            [VISIBILITY_GROUPS_KEY]: [...groups],
            [CLASSIFICATION_LEVEL_KEY]: level,
        },
    };
    if (input.sourcePath) {
        sidecar.metadataAttributes.source_path = input.sourcePath;
    }
    return sidecar;
}
