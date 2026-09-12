/**
 * Latest version of an npm package, from the registry.
 *
 * Also reports deprecation, which the npm collector turns into its own finding kind —
 * a deprecated package is maintenance work even when it is on its latest version.
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
        return resolved(latest, latest, 'npm-registry', 'high', evidence);
    }

    /**
     * Whether the registry marks a version deprecated.
     *
     * Separate from resolution because it answers a different question and the npm
     * collector needs both from one fetch — the HTTP client memoises the response.
     */
    public async isDeprecated(packageName: string, version: string): Promise<boolean | null> {
        const response = await this.http.request({ url: this.packumentUrl(packageName) });
        if (!response.ok) {
            return null;
        }
        try {
            const document = JSON.parse(response.body) as PackumentLike;
            return document.versions?.[version]?.deprecated !== undefined;
        } catch {
            return null;
        }
    }

    /** Scoped names contain a slash, which must be encoded for the registry path. */
    private packumentUrl(packageName: string): string {
        return `${this.registryUrl.replace(/\/$/, '')}/${packageName.replace('/', '%2f')}`;
    }
}
