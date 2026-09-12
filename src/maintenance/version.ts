/**
 * Version parsing and comparison.
 *
 * Two functions with deliberately different jobs, because using one for both would
 * produce silently wrong answers:
 *
 * - {@link parseStrictVersion} for **selecting** a version from a list of tags. Strict,
 *   so junk is rejected rather than invented into a version.
 * - {@link coerceVersionCore} for **comparing** in domains known to be loose, such as
 *   an EKS `1.31` or an addon's `-eksbuild.N` suffix. Never for selection.
 *
 * `semver.coerce` reads `sha-abc123` as `123.0.0` and `20240115` as `20240115.0.0`,
 * either of which beats every real release and would be picked as "latest". It also
 * flattens `0.14.2-rc.1` to `0.14.2`, making a release candidate tie with the stable
 * release. A wrong latest is worse than no latest, so selection never coerces.
 */

import * as semver from 'semver';
import { SemverBump } from './schema';

/** A parsed version, keeping the raw text for evidence. */
export interface ParsedVersion {
    /** Exactly as it appeared upstream or in the file. */
    raw: string;
    /** Normalised semver, e.g. `4.0.0`. */
    version: string;
    /** True when the version carries a prerelease component. */
    prerelease: boolean;
}

/**
 * Parse a version for **selection**, rejecting anything that is not real semver.
 *
 * Accepts an optional leading `v` and keeps prerelease components intact so an RC
 * remains distinguishable from its release. Returns null for a commit-sha tag, a date
 * tag, a codename, or a moving tag like `latest`.
 */
export function parseStrictVersion(raw: string): ParsedVersion | null {
    const normalised = semver.valid(raw.trim());
    if (normalised === null) {
        return null;
    }
    return {
        raw,
        version: normalised,
        prerelease: semver.prerelease(normalised) !== null,
    };
}

/**
 * Parse a version for **comparison** in a domain known to be loose.
 *
 * Handles a two-part EKS version (`1.31` becomes `1.31.0`) and reduces an addon version
 * to its core (`v1.19.2-eksbuild.1` becomes `1.19.2`). Only ever apply this where the
 * caller knows the input is a version — never to an arbitrary registry tag.
 */
export function coerceVersionCore(raw: string): ParsedVersion | null {
    const coerced = semver.coerce(raw.trim());
    if (coerced === null) {
        return null;
    }
    return { raw, version: coerced.version, prerelease: false };
}

/**
 * Parse a version for comparison, accepting the loose forms real files contain.
 *
 * Strict first, coercion second. Use this only where the value is already known to be a
 * version — a captured tool pin, a calendar entry, a resolved latest — never over a raw
 * list of registry tags, where coercion would invent `123.0.0` out of `sha-abc123` and
 * hand it back as the newest release.
 */
export function parseVersionForComparison(raw: string): ParsedVersion | null {
    return parseStrictVersion(raw) ?? coerceVersionCore(raw);
}

/** How precisely a version was written. */
export type VersionPrecision = 'major' | 'minor' | 'patch';

/**
 * How many components a version reference actually states.
 *
 * A workflow pinning `actions/checkout@v4` has said "the 4 line", not "4.0.0". Treating
 * it as the latter reports it two patches behind the moment `v4.0.1` ships, when the tag
 * it names already points there. Returns null for anything that is not a numeric
 * version reference, such as a branch name or a commit SHA.
 */
export function versionPrecision(raw: string): VersionPrecision | null {
    const core = raw.trim().replace(/^v/i, '').split(/[-+]/)[0];
    const segments = core.split('.');
    if (segments.length > 3 || segments.some((segment) => !/^\d+$/.test(segment))) {
        return null;
    }
    // The guard above leaves one, two or three numeric segments, so the index is always
    // in range; a fallback here would be a branch that can never be taken.
    return (['major', 'minor', 'patch'] as const)[segments.length - 1];
}

/**
 * Reduce a version to the components a reference of the given precision states.
 *
 * Comparing `v4` against a truncated `4.0.0` rather than the real `4.2.2` is what makes
 * a moving major tag read as current until the major itself moves. `versions.latest`
 * still records the true latest — only the comparison is narrowed.
 */
export function truncateVersion(
    version: ParsedVersion,
    precision: VersionPrecision,
): ParsedVersion {
    if (precision === 'patch') {
        return version;
    }
    const major = semver.major(version.version);
    const minor = precision === 'minor' ? semver.minor(version.version) : 0;
    return { raw: version.raw, version: `${major}.${minor}.0`, prerelease: false };
}

export interface SelectLatestOptions {
    /** Include prerelease versions. Off by default: an RC is not the latest release. */
    includePrereleases?: boolean;
    /** Regex the raw tag must match before it is considered at all. */
    tagPattern?: RegExp;
}

/**
 * Pick the newest usable version from a list of tags.
 *
 * Two independent guards, because one registry returns nearly two thousand tags for a
 * single repository: the configured tag pattern filters first, then strict parsing
 * rejects anything that survived the pattern but is not a version.
 *
 * Returns null when nothing qualifies — which the caller reports as unresolved with a
 * reason, never as "no drift".
 */
export function selectLatestVersion(
    tags: readonly string[],
    options: SelectLatestOptions = {},
): ParsedVersion | null {
    const candidates = tags
        .filter((tag) => options.tagPattern === undefined || matches(options.tagPattern, tag))
        .map(parseStrictVersion)
        .filter((parsed): parsed is ParsedVersion => parsed !== null)
        .filter((parsed) => options.includePrereleases === true || !parsed.prerelease);

    if (candidates.length === 0) {
        return null;
    }
    return candidates.reduce((newest, candidate) =>
        semver.gt(candidate.version, newest.version) ? candidate : newest,
    );
}

/** How far apart two versions are, and in which direction. */
export interface VersionComparison {
    bump: SemverBump;
    /** Major versions between observed and latest, or null when not comparable. */
    majorsBehind: number | null;
    /** True when the observed version is pre-1.0. */
    zeroMajor: boolean;
}

/**
 * Classify the gap between an observed version and the latest one.
 *
 * `semver.diff` throws on unparseable input and returns null for equal versions, so
 * both are handled here rather than at each call site.
 */
export function compareVersions(
    observed: ParsedVersion | null,
    latest: ParsedVersion | null,
): VersionComparison {
    if (observed === null || latest === null) {
        return { bump: 'unknown', majorsBehind: null, zeroMajor: false };
    }
    const zeroMajor = semver.major(observed.version) === 0;
    if (semver.gte(observed.version, latest.version)) {
        return { bump: 'none', majorsBehind: 0, zeroMajor };
    }
    const difference = semver.diff(observed.version, latest.version);
    return {
        bump: toBump(difference),
        majorsBehind: Math.max(0, semver.major(latest.version) - semver.major(observed.version)),
        zeroMajor,
    };
}

/**
 * Map a semver difference onto the report's vocabulary.
 *
 * The `pre*` variants collapse to `prerelease`: for maintenance purposes "there is a
 * newer prerelease" is one fact, not three.
 */
function toBump(difference: semver.ReleaseType | null): SemverBump {
    switch (difference) {
        case 'major':
        case 'minor':
        case 'patch':
            return difference;
        case 'premajor':
        case 'preminor':
        case 'prepatch':
        case 'prerelease':
            return 'prerelease';
        /* istanbul ignore next -- diff returns null only for equal versions, handled above. */
        default:
            return 'none';
    }
}

/** Test a pattern against a value, resetting `lastIndex` so a global flag is harmless. */
function matches(pattern: RegExp, value: string): boolean {
    pattern.lastIndex = 0;
    return pattern.test(value);
}
