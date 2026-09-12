/**
 * Latest version of a GitHub-published thing.
 *
 * Two schemes because projects publish differently: some cut releases, some only tag.
 * `github-release` is preferred where it works — a release is a deliberate act, whereas
 * a tag can be anything — and `github-tag` covers the rest.
 */

import { HttpClient } from '../http/http-client';
import { selectLatestVersion } from '../version';
import {
    ResolveRequest,
    ResolvedVersion,
    VersionSource,
    resolved,
    unresolved,
} from './version-source';
import { httpEvidence } from './evidence';

const OWNER_REPO = /^[^/]+\/[^/]+$/;

interface ReleaseLike {
    tag_name?: unknown;
    draft?: unknown;
    prerelease?: unknown;
}

interface TagLike {
    name?: unknown;
}

/** The newest published release, ignoring drafts and prereleases. */
export class GithubReleaseSource implements VersionSource {
    public readonly scheme = 'github-release' as const;

    constructor(
        private readonly http: HttpClient,
        private readonly apiBaseUrl: string = 'https://api.github.com',
    ) {}

    public async resolve(request: ResolveRequest): Promise<ResolvedVersion> {
        const repo = request.ref.identifier;
        if (!OWNER_REPO.test(repo)) {
            return unresolved('github-release', `Expected owner/repo, got "${repo}"`);
        }
        const url = `${base(this.apiBaseUrl)}/repos/${repo}/releases/latest`;
        const response = await this.http.request({ url });
        const evidence = [httpEvidence(response)];

        if (!response.ok) {
            return unresolved(
                'github-release',
                `GitHub returned ${response.status} for the latest release of ${repo}`,
                evidence,
            );
        }

        let release: ReleaseLike;
        try {
            release = JSON.parse(response.body) as ReleaseLike;
        } catch {
            return unresolved('github-release', 'Release response was not valid JSON', evidence);
        }

        // `releases/latest` already excludes drafts and prereleases, but a repository
        // can be configured oddly, so the check is not assumed.
        if (release.draft === true || release.prerelease === true) {
            return unresolved(
                'github-release',
                `The latest release of ${repo} is a draft or prerelease`,
                evidence,
            );
        }
        const tag = release.tag_name;
        if (typeof tag !== 'string' || tag.length === 0) {
            return unresolved('github-release', `Latest release of ${repo} has no tag`, evidence);
        }

        const parsed = selectLatestVersion([tag], {
            includePrereleases: request.includePrereleases,
            tagPattern: request.tagPattern,
        });
        if (parsed === null) {
            return unresolved(
                'github-release',
                `Latest release tag "${tag}" is not a usable version`,
                evidence,
            );
        }
        return resolved(parsed.version, tag, 'github-release', 'high', evidence);
    }
}

/** The newest semver tag, for projects that tag without cutting releases. */
export class GithubTagSource implements VersionSource {
    public readonly scheme = 'github-tag' as const;

    constructor(
        private readonly http: HttpClient,
        private readonly apiBaseUrl: string = 'https://api.github.com',
    ) {}

    public async resolve(request: ResolveRequest): Promise<ResolvedVersion> {
        const repo = request.ref.identifier;
        if (!OWNER_REPO.test(repo)) {
            return unresolved('github-tag', `Expected owner/repo, got "${repo}"`);
        }
        const url = `${base(this.apiBaseUrl)}/repos/${repo}/tags?per_page=100`;
        const response = await this.http.request({ url });
        const evidence = [httpEvidence(response)];

        if (!response.ok) {
            return unresolved(
                'github-tag',
                `GitHub returned ${response.status} for the tags of ${repo}`,
                evidence,
            );
        }

        let tags: TagLike[];
        try {
            const parsed: unknown = JSON.parse(response.body);
            tags = Array.isArray(parsed) ? (parsed as TagLike[]) : [];
        } catch {
            return unresolved('github-tag', 'Tag response was not valid JSON', evidence);
        }

        const names = tags
            .map((tag) => tag.name)
            .filter((name): name is string => typeof name === 'string');
        const latest = selectLatestVersion(names, {
            includePrereleases: request.includePrereleases,
            tagPattern: request.tagPattern,
        });
        if (latest === null) {
            return unresolved(
                'github-tag',
                describeNoMatch(names.length, request.tagPattern),
                evidence,
            );
        }
        // Only the first page is read. A repository whose newest tag is not in its 100
        // most recent is pathological, and paginating would spend a rate-limit budget
        // that resolvable references need.
        return resolved(latest.version, latest.raw, 'github-tag', 'high', evidence);
    }
}

function base(url: string): string {
    return url.replace(/\/$/, '');
}

/** Say whether nothing was returned or nothing matched — different problems. */
export function describeNoMatch(candidateCount: number, pattern?: RegExp): string {
    if (candidateCount === 0) {
        return 'Upstream returned no tags';
    }
    return pattern === undefined
        ? `None of the ${candidateCount} tags returned is a usable version`
        : `None of the ${candidateCount} tags returned matches ${String(pattern)} and parses as a version`;
}
