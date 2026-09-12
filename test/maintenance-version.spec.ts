import {
    coerceVersionCore,
    compareVersions,
    parseStrictVersion,
    selectLatestVersion,
} from '../src/maintenance/version';

describe('parseStrictVersion', () => {
    it.each([
        ['0.14.2', '0.14.2'],
        ['v0.12.0', '0.12.0'],
        ['2.321.0', '2.321.0'],
        ['0.14.2-rc.1', '0.14.2-rc.1'],
        ['  1.2.3  ', '1.2.3'],
    ])('should accept %s', (raw: string, expected: string) => {
        expect(parseStrictVersion(raw)?.version).toBe(expected);
    });

    it.each([
        ['a commit-sha tag', 'sha-abc123'],
        ['a date tag', '20240115'],
        ['a moving tag', 'latest'],
        ['a branch name', 'main'],
        ['a distribution codename', 'bullseye'],
        ['a two-part version', '1.31'],
        ['an empty string', ''],
    ])('should reject %s', (_label, raw: string) => {
        expect(parseStrictVersion(raw)).toBeNull();
    });

    it('should keep a prerelease distinguishable from its release', () => {
        expect(parseStrictVersion('0.14.2-rc.1')?.prerelease).toBe(true);
        expect(parseStrictVersion('0.14.2')?.prerelease).toBe(false);
    });

    it('should preserve the raw text for evidence', () => {
        expect(parseStrictVersion('v1.2.3')?.raw).toBe('v1.2.3');
    });
});

describe('coerceVersionCore', () => {
    it.each([
        ['a two-part EKS version', '1.31', '1.31.0'],
        ['a version with a trailing zero', '1.30', '1.30.0'],
        ['an addon build suffix', 'v1.19.2-eksbuild.1', '1.19.2'],
        ['a leading v', 'v4', '4.0.0'],
    ])('should coerce %s', (_label, raw: string, expected: string) => {
        expect(coerceVersionCore(raw)?.version).toBe(expected);
    });

    it('should return null for a codename', () => {
        expect(coerceVersionCore('bullseye')).toBeNull();
    });
});

describe('selectLatestVersion', () => {
    it('should pick the newest release', () => {
        expect(selectLatestVersion(['0.9.0', '0.14.2', '0.10.1'])?.version).toBe('0.14.2');
    });

    it('should not let a commit-sha tag win, which coercion would allow', () => {
        // semver.coerce reads sha-abc123 as 123.0.0, which beats every real release.
        expect(selectLatestVersion(['0.14.2', 'sha-abc123'])?.version).toBe('0.14.2');
    });

    it('should not let a date tag win', () => {
        // 20240115 coerces to 20240115.0.0.
        expect(selectLatestVersion(['2.321.0', '20240115'])?.version).toBe('2.321.0');
    });

    it('should exclude prereleases by default', () => {
        expect(selectLatestVersion(['0.14.2', '0.15.0-rc.1'])?.version).toBe('0.14.2');
    });

    it('should include prereleases when asked', () => {
        const latest = selectLatestVersion(['0.14.2', '0.15.0-rc.1'], {
            includePrereleases: true,
        });

        expect(latest?.version).toBe('0.15.0-rc.1');
    });

    it('should apply the tag pattern before parsing', () => {
        const tags = ['3.0.0-bullseye', '1.2.3', '2.0.0-bookworm'];
        const latest = selectLatestVersion(tags, {
            tagPattern: /^\d+\.\d+\.\d+-(bullseye|bookworm)$/,
            includePrereleases: true,
        });

        expect(latest?.raw).toBe('3.0.0-bullseye');
    });

    it('should return null when the pattern matches nothing, so the caller can say why', () => {
        const latest = selectLatestVersion(['1.2.3'], { tagPattern: /^v\d+$/ });

        expect(latest).toBeNull();
    });

    it('should return null for an empty tag list', () => {
        expect(selectLatestVersion([])).toBeNull();
    });

    it('should return null when every tag is unusable', () => {
        expect(selectLatestVersion(['latest', 'main', 'edge'])).toBeNull();
    });

    it('should not be derailed by a global tag pattern reused across tags', () => {
        const pattern = /^\d+\.\d+\.\d+$/g;

        expect(
            selectLatestVersion(['1.0.0', '2.0.0', '3.0.0'], { tagPattern: pattern })?.version,
        ).toBe('3.0.0');
    });
});

describe('compareVersions', () => {
    const parse = (raw: string) => parseStrictVersion(raw) ?? coerceVersionCore(raw);

    it.each([
        ['a major bump', '4.0.0', '5.0.0', 'major', 1],
        ['a minor bump', '5.7.3', '5.9.2', 'minor', 0],
        ['a patch bump', '5.7.3', '5.7.4', 'patch', 0],
        ['equal versions', '5.7.3', '5.7.3', 'none', 0],
        ['multiple majors', '2.0.0', '5.0.0', 'major', 3],
    ])('should classify %s', (_label, a: string, b: string, bump: string, majors: number) => {
        const result = compareVersions(parse(a), parse(b));

        expect(result.bump).toBe(bump);
        expect(result.majorsBehind).toBe(majors);
    });

    it('should collapse prerelease differences to one classification', () => {
        expect(compareVersions(parse('1.0.0'), parse('1.0.1-rc.1')).bump).toBe('prerelease');
    });

    it('should report unknown when either side is unparseable', () => {
        expect(compareVersions(null, parse('1.0.0')).bump).toBe('unknown');
        expect(compareVersions(parse('1.0.0'), null).bump).toBe('unknown');
        expect(compareVersions(null, null).majorsBehind).toBeNull();
    });

    it('should treat an observed version ahead of latest as current, not behind', () => {
        // A prerelease installed locally, or a registry lagging. Never a negative count.
        const result = compareVersions(parse('6.0.0'), parse('5.0.0'));

        expect(result.bump).toBe('none');
        expect(result.majorsBehind).toBe(0);
    });

    it('should flag a pre-1.0 observed version', () => {
        expect(compareVersions(parse('0.10.1'), parse('0.14.2')).zeroMajor).toBe(true);
        expect(compareVersions(parse('1.10.1'), parse('1.14.2')).zeroMajor).toBe(false);
    });

    it('should classify an ARC-style 0.x gap as minor while flagging it pre-1.0', () => {
        // bump stays factual; the severity table decides what a 0.x minor means.
        const result = compareVersions(parse('0.10.1'), parse('0.14.2'));

        expect(result.bump).toBe('minor');
        expect(result.zeroMajor).toBe(true);
        expect(result.majorsBehind).toBe(0);
    });

    it('should compare EKS two-part versions through coercion', () => {
        const result = compareVersions(coerceVersionCore('1.30'), coerceVersionCore('1.33'));

        expect(result.bump).toBe('minor');
    });

    it('should compare addon versions on their core, ignoring the build suffix', () => {
        const result = compareVersions(
            coerceVersionCore('v1.19.2-eksbuild.1'),
            coerceVersionCore('v1.19.2-eksbuild.3'),
        );

        expect(result.bump).toBe('none');
    });
});
