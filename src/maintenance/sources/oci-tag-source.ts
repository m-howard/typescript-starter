/**
 * Latest tag of an OCI artifact.
 *
 * Covers container images and Helm charts alike: a Helm OCI chart *is* an OCI artifact
 * and its chart versions *are* tags, so `helm:` is an alias registered against this
 * same implementation rather than a second one.
 *
 * Registries differ only in how they authenticate. All three probed here serve tag
 * listings anonymously: ghcr.io and Docker Hub via a token exchange,
 * mcr.microsoft.com with no authentication at all.
 */

import { HttpClient } from '../http/http-client';
import { selectLatestVersion } from '../version';
import {
    ResolveRequest,
    ResolvedVersion,
    SourceScheme,
    VersionSource,
    resolved,
    unresolved,
} from './version-source';
import { describeNoMatch } from './github-source';
import { httpEvidence } from './evidence';

/** How to reach a registry's v2 API and, if needed, get a pull token. */
export interface RegistryConfig {
    /** Base URL of the v2 API. */
    registryUrl: string;
    /** Token endpoint with a `{repository}` placeholder. Omit when none is needed. */
    tokenUrl?: string;
}

/** Defaults for the registries this project actually reads. */
export const DEFAULT_REGISTRIES: Readonly<Record<string, RegistryConfig>> = Object.freeze({
    'ghcr.io': {
        registryUrl: 'https://ghcr.io',
        tokenUrl: 'https://ghcr.io/token?service=ghcr.io&scope=repository:{repository}:pull',
    },
    'docker.io': {
        registryUrl: 'https://registry-1.docker.io',
        tokenUrl:
            'https://auth.docker.io/token?service=registry.docker.io&scope=repository:{repository}:pull',
    },
    'mcr.microsoft.com': { registryUrl: 'https://mcr.microsoft.com' },
});

interface TokenLike {
    token?: unknown;
    access_token?: unknown;
}

interface TagListLike {
    tags?: unknown;
}

export class OciTagSource implements VersionSource {
    constructor(
        private readonly http: HttpClient,
        private readonly registries: Readonly<Record<string, RegistryConfig>> = DEFAULT_REGISTRIES,
        public readonly scheme: SourceScheme = 'oci',
    ) {}

    public async resolve(request: ResolveRequest): Promise<ResolvedVersion> {
        const target = splitReference(request.ref.identifier);
        if (target === null) {
            return unresolved(
                this.method(),
                `Expected <registry>/<repository>, got "${request.ref.identifier}"`,
            );
        }
        const registry = this.registries[target.registry];
        if (registry === undefined) {
            return unresolved(
                this.method(),
                `No registry configured for ${target.registry}. ` +
                    `Configured: ${Object.keys(this.registries).join(', ')}.`,
            );
        }

        const evidence = [];
        let headers: Record<string, string> = {};
        if (registry.tokenUrl !== undefined) {
            const tokenUrl = registry.tokenUrl.replace('{repository}', target.repository);
            const tokenResponse = await this.http.request({ url: tokenUrl });
            evidence.push(httpEvidence(tokenResponse));
            if (!tokenResponse.ok) {
                return unresolved(
                    this.method(),
                    `Token exchange for ${target.repository} returned ${tokenResponse.status}`,
                    evidence,
                );
            }
            const token = readToken(tokenResponse.body);
            if (token === null) {
                return unresolved(
                    this.method(),
                    `Token exchange for ${target.repository} returned no token`,
                    evidence,
                );
            }
            headers = { authorization: `Bearer ${token}` };
        }

        const listUrl = `${registry.registryUrl.replace(/\/$/, '')}/v2/${target.repository}/tags/list`;
        const response = await this.http.request({ url: listUrl, headers });
        evidence.push(httpEvidence(response));
        if (!response.ok) {
            return unresolved(
                this.method(),
                `Registry returned ${response.status} for the tags of ${target.repository}`,
                evidence,
            );
        }

        let tags: string[];
        try {
            const document = JSON.parse(response.body) as TagListLike;
            tags = Array.isArray(document.tags)
                ? document.tags.filter((tag): tag is string => typeof tag === 'string')
                : [];
        } catch {
            return unresolved(this.method(), 'Tag listing was not valid JSON', evidence);
        }

        const latest = selectLatestVersion(tags, {
            includePrereleases: request.includePrereleases,
            tagPattern: request.tagPattern,
        });
        if (latest === null) {
            // A pattern matching nothing is a configuration bug, and it must surface as
            // unresolved rather than as "no drift".
            return unresolved(
                this.method(),
                describeNoMatch(tags.length, request.tagPattern),
                evidence,
            );
        }
        return resolved(latest.version, latest.raw, this.method(), 'high', evidence);
    }

    private method(): 'oci-registry' | 'helm-oci' {
        return this.scheme === 'helm' ? 'helm-oci' : 'oci-registry';
    }
}

/**
 * Split `ghcr.io/actions/actions-runner` into its registry and repository.
 *
 * A leading `//` is tolerated: `oci://ghcr.io/...` is a natural thing to write, and the
 * scheme has already been consumed by the time the identifier arrives here.
 */
function splitReference(identifier: string): { registry: string; repository: string } | null {
    const trimmed = identifier.replace(/^\/\//, '');
    const separator = trimmed.indexOf('/');
    if (separator <= 0 || separator === trimmed.length - 1) {
        return null;
    }
    return {
        registry: trimmed.slice(0, separator),
        repository: trimmed.slice(separator + 1),
    };
}

/** Registries disagree on the field name, so accept either. */
function readToken(body: string): string | null {
    try {
        const document = JSON.parse(body) as TokenLike;
        const token = document.token ?? document.access_token;
        return typeof token === 'string' && token.length > 0 ? token : null;
    } catch {
        return null;
    }
}
