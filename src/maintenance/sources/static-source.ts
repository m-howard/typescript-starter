/**
 * A version pinned in configuration.
 *
 * The escape hatch for things with no queryable upstream — an EKS addon whose versions
 * AWS publishes only in documentation, for instance. Confidence is `low` by
 * construction: a human typed it, and nothing checks it against reality, so the report
 * says so rather than presenting it as a lookup.
 */

import { ResolveRequest, ResolvedVersion, VersionSource, resolved } from './version-source';

export class StaticSource implements VersionSource {
    public readonly scheme = 'static' as const;

    public resolve(request: ResolveRequest): Promise<ResolvedVersion> {
        const value = request.ref.identifier;
        return Promise.resolve(resolved(value, value, 'static-config', 'low'));
    }
}
