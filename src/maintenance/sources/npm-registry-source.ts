/**
 * Latest version of an npm package, from the registry.
 *
 * Also reports whether the observed version is deprecated, which the npm collector
 * turns into its own finding kind — a deprecated package is maintenance work even when
 * it is on its latest version. It comes from the same packument as the latest version,
 * so asking costs no extra request.
 */

import { HttpClient } from '../http/http-client';
import {
    ResolveRequest,
    ResolvedVersion,
    VersionSource,
    resolved,
    unresolved,
} from './version-source';
import { httpEvidence } from './evidence';

/** Just the fields we rely on; the registry document is very large. */
interface PackumentLike {
    'dist-tags'?: { latest?: unknown };
    versions?: Record<string, { deprecated?: unknown } | undefined>;
}

export class NpmRegistrySource implements VersionSource {
    public readonly scheme = 'npm' as const;

    constructor(
        private readonly http: HttpClient,
        private readonly registryUrl: string = 'https://registry.npmjs.org',
    ) {}

    public async resolve(request: ResolveRequest): Promise<ResolvedVersion> {
        const url = this.packumentUrl(request.ref.identifier);
        const response = await this.http.request({ url });
        const evidence = [httpEvidence(response)];

        if (!response.ok) {
            return unresolved(
                'npm-registry',
                `Registry returned ${response.status} for ${request.ref.identifier}`,
                evidence,
            );
        }

        let document: PackumentLike;
        try {
            document = JSON.parse(response.body) as PackumentLike;
        } catch {
            return unresolved('npm-registry', `Registry response was not valid JSON`, evidence);
        }

        const latest = document['dist-tags']?.latest;
        if (typeof latest !== 'string' || latest.length === 0) {
            return unresolved(
                'npm-registry',
                `Registry response has no dist-tags.latest for ${request.ref.identifier}`,
                evidence,
            );
        }
        return {
            ...resolved(latest, latest, 'npm-registry', 'high', evidence),
            deprecated: readDeprecated(document, request.observedVersion),
        };
    }

    /** Scoped names contain a slash, which must be encoded for the registry path. */
    private packumentUrl(packageName: string): string {
        return `${this.registryUrl.replace(/\/$/, '')}/${packageName.replace('/', '%2f')}`;
    }
}

/**
 * Whether the packument marks the observed version deprecated.
 *
 * Null rather than false when the version is absent from the document: "the registry
 * does not list this version" is not the same as "this version is fine", and only the
 * first is honest about what was learned.
 */
function readDeprecated(document: PackumentLike, observedVersion?: string): boolean | null {
    if (observedVersion === undefined) {
        return null;
    }
    const entry = document.versions?.[observedVersion];
    return entry === undefined ? null : entry.deprecated !== undefined;
}
