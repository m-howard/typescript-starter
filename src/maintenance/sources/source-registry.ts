/**
 * Scheme dispatch with per-run memoisation.
 *
 * The arc and images collectors both ask for `oci:ghcr.io/actions/actions-runner`, and
 * unauthenticated GitHub allows 60 requests an hour. Resolving each distinct reference
 * once per run is the difference between a complete scan and a throttled one
 * (REQ-NET-023).
 *
 * Memoisation happens here as well as in the HTTP client because a resolution can cost
 * several requests — a registry token exchange followed by a tag listing — and because
 * some sources run commands rather than making requests.
 */

import { ConfigError } from '../errors';
import {
    ResolveRequest,
    ResolvedVersion,
    SourceScheme,
    VersionRef,
    VersionSource,
    parseVersionRef,
    unresolved,
} from './version-source';

export class VersionSourceRegistry {
    private readonly sources = new Map<SourceScheme, VersionSource>();
    private readonly inFlight = new Map<string, Promise<ResolvedVersion>>();

    constructor(sources: readonly VersionSource[] = []) {
        for (const source of sources) {
            this.register(source);
        }
    }

    public register(source: VersionSource): this {
        this.sources.set(source.scheme, source);
        return this;
    }

    /** Schemes this registry can dispatch, for diagnostics. */
    public get schemes(): SourceScheme[] {
        return [...this.sources.keys()];
    }

    /**
     * Resolve a reference written as `<scheme>:<identifier>`.
     *
     * A malformed or unregistered reference is a configuration error and throws: the
     * inventory named something the tool cannot interpret, which is worth failing on
     * rather than silently reporting as unresolved.
     */
    public async resolve(
        rawRef: string,
        options: Omit<ResolveRequest, 'ref'> = {},
    ): Promise<ResolvedVersion> {
        const ref = parseVersionRef(rawRef);
        if (ref === null) {
            throw new ConfigError(
                `Not a valid source reference: ${rawRef}. Expected <scheme>:<identifier>.`,
                { target: rawRef },
            );
        }
        const source = this.sources.get(ref.scheme);
        if (source === undefined) {
            throw new ConfigError(
                `No source registered for scheme "${ref.scheme}" (from ${rawRef}). ` +
                    `Registered: ${this.schemes.join(', ') || 'none'}.`,
                { target: rawRef },
            );
        }

        const key = cacheKey(ref, options);
        const existing = this.inFlight.get(key);
        if (existing !== undefined) {
            return existing;
        }

        // Cache the promise rather than the result, so concurrent callers share one
        // request instead of racing to make the same one.
        const pending = this.dispatch(source, { ...options, ref });
        this.inFlight.set(key, pending);
        return pending;
    }

    /**
     * Run a source, converting a thrown failure into an unresolved result.
     *
     * A source that cannot reach upstream must not abort the collector: the finding is
     * still emitted, marked unresolved with the reason (REQ-ERR-030).
     */
    private async dispatch(
        source: VersionSource,
        request: ResolveRequest,
    ): Promise<ResolvedVersion> {
        try {
            return await source.resolve(request);
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            return unresolved('not-attempted', message);
        }
    }
}

/**
 * Cache key for a resolution.
 *
 * Includes the selection options: the same repository filtered by two different tag
 * patterns is two different questions.
 */
function cacheKey(ref: VersionRef, options: Omit<ResolveRequest, 'ref'>): string {
    return [
        ref.raw,
        options.tagPattern?.source ?? '',
        options.includePrereleases === true ? 'pre' : '',
        // Two collectors asking about different observed versions are asking different
        // questions, even though the latest version they get back is the same.
        options.observedVersion ?? '',
    ].join('|');
}
