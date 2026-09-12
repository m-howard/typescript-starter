/**
 * Version sources.
 *
 * `helm` is registered against the OCI implementation rather than a separate one: a
 * Helm OCI chart is an OCI artifact and its chart versions are its tags. The scheme
 * exists for readability in the config, and to record `helm-oci` provenance.
 */

import { HttpClient } from '../http/http-client';
import { GithubReleaseSource, GithubTagSource } from './github-source';
import { NpmRegistrySource } from './npm-registry-source';
import { DEFAULT_REGISTRIES, OciTagSource, RegistryConfig } from './oci-tag-source';
import { StaticSource } from './static-source';
import { VersionSourceRegistry } from './source-registry';

export * from './version-source';
export * from './source-registry';
export * from './npm-registry-source';
export * from './github-source';
export * from './oci-tag-source';
export * from './static-source';
export * from './evidence';

export interface BuildRegistryOptions {
    http: HttpClient;
    npmRegistryUrl?: string;
    githubApiBaseUrl?: string;
    ociRegistries?: Readonly<Record<string, RegistryConfig>>;
}

/** Assemble a registry with every scheme the config schema accepts. */
export function buildDefaultSourceRegistry(options: BuildRegistryOptions): VersionSourceRegistry {
    const { http, npmRegistryUrl, githubApiBaseUrl, ociRegistries = DEFAULT_REGISTRIES } = options;
    return new VersionSourceRegistry([
        new NpmRegistrySource(http, npmRegistryUrl),
        new GithubReleaseSource(http, githubApiBaseUrl),
        new GithubTagSource(http, githubApiBaseUrl),
        new OciTagSource(http, ociRegistries, 'oci'),
        new OciTagSource(http, ociRegistries, 'helm'),
        new StaticSource(),
    ]);
}
