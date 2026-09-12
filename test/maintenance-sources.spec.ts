import {
    GithubReleaseSource,
    GithubTagSource,
    NpmRegistrySource,
    OciTagSource,
    StaticSource,
    commandEvidence,
    VersionSourceRegistry,
    buildDefaultSourceRegistry,
    parseVersionRef,
} from '../src/maintenance/sources';
import { ConfigError, NetworkError } from '../src/maintenance/errors';
import { FakeHttpClient } from './support/maintenance-fakes';

const NPM_URL = 'https://registry.npmjs.org/typescript';
const RELEASE_URL = 'https://api.github.com/repos/actions/checkout/releases/latest';
const TAGS_URL = 'https://api.github.com/repos/kubernetes/kubernetes/tags?per_page=100';
const GHCR_TOKEN_URL =
    'https://ghcr.io/token?service=ghcr.io&scope=repository:actions/actions-runner:pull';
const GHCR_TAGS_URL = 'https://ghcr.io/v2/actions/actions-runner/tags/list';
const MCR_TAGS_URL = 'https://mcr.microsoft.com/v2/devcontainers/base/tags/list';

const ref = (raw: string) => {
    const parsed = parseVersionRef(raw);
    if (parsed === null) {
        throw new Error(`test fixture is not a valid ref: ${raw}`);
    }
    return parsed;
};

describe('parseVersionRef', () => {
    it.each([
        ['npm:typescript', 'npm', 'typescript'],
        ['github-release:actions/runner', 'github-release', 'actions/runner'],
        ['oci:ghcr.io/actions/actions-runner', 'oci', 'ghcr.io/actions/actions-runner'],
        ['static:v1.11.4-eksbuild.2', 'static', 'v1.11.4-eksbuild.2'],
    ])('should split %s', (raw: string, scheme: string, identifier: string) => {
        expect(parseVersionRef(raw)).toMatchObject({ scheme, identifier });
    });

    it('should split on the first colon only, so a port survives', () => {
        expect(parseVersionRef('oci:registry:5000/repo')?.identifier).toBe('registry:5000/repo');
    });

    it.each([
        ['no scheme', 'actions/runner'],
        ['an unknown scheme', 'cargo:serde'],
        ['an empty identifier', 'npm:'],
        ['a leading colon', ':typescript'],
    ])('should reject %s', (_label, raw: string) => {
        expect(parseVersionRef(raw)).toBeNull();
    });
});

describe('NpmRegistrySource', () => {
    it('should resolve dist-tags.latest with high confidence', async () => {
        const http = new FakeHttpClient({
            [NPM_URL]: { body: JSON.stringify({ 'dist-tags': { latest: '5.9.2' } }) },
        });

        const result = await new NpmRegistrySource(http).resolve({ ref: ref('npm:typescript') });

        expect(result).toMatchObject({
            status: 'resolved',
            version: '5.9.2',
            method: 'npm-registry',
            confidence: 'high',
        });
    });

    it('should record HTTP evidence for the lookup [REQ-EVI-004]', async () => {
        const http = new FakeHttpClient({
            [NPM_URL]: { body: JSON.stringify({ 'dist-tags': { latest: '5.9.2' } }) },
        });

        const result = await new NpmRegistrySource(http).resolve({ ref: ref('npm:typescript') });

        expect(result.evidence).toHaveLength(1);
        expect(result.evidence[0]).toMatchObject({ type: 'http', url: NPM_URL, status: 200 });
    });

    it('should encode a scoped package name for the registry path', async () => {
        const url = 'https://registry.npmjs.org/@faker-js%2ffaker';
        const http = new FakeHttpClient({
            [url]: { body: JSON.stringify({ 'dist-tags': { latest: '9.6.0' } }) },
        });

        const result = await new NpmRegistrySource(http).resolve({
            ref: ref('npm:@faker-js/faker'),
        });

        expect(result.version).toBe('9.6.0');
    });

    it.each([
        ['a non-200 response', { status: 404, ok: false, body: '' }, /404/],
        ['unparseable JSON', { body: 'not json' }, /not valid JSON/i],
        ['a missing dist-tag', { body: '{}' }, /no dist-tags\.latest/i],
    ])(
        'should report %s as unresolved with a reason [REQ-ERR-030]',
        async (_label, entry, match) => {
            const http = new FakeHttpClient({ [NPM_URL]: entry });

            const result = await new NpmRegistrySource(http).resolve({
                ref: ref('npm:typescript'),
            });

            expect(result.status).toBe('unresolved');
            expect(result.version).toBeNull();
            expect(result.reason).toMatch(match);
        },
    );

    describe('deprecation [REQ-NPM-017]', () => {
        const packument = JSON.stringify({
            'dist-tags': { latest: '5.9.2' },
            versions: { '5.0.0': { deprecated: 'use 5.9' }, '5.9.2': {} },
        });

        it('should report the observed version as deprecated', async () => {
            const http = new FakeHttpClient({ [NPM_URL]: { body: packument } });

            const result = await new NpmRegistrySource(http).resolve({
                ref: ref('npm:typescript'),
                observedVersion: '5.0.0',
            });

            expect(result).toMatchObject({ version: '5.9.2', deprecated: true });
        });

        it('should report a live observed version as not deprecated', async () => {
            const http = new FakeHttpClient({ [NPM_URL]: { body: packument } });

            const result = await new NpmRegistrySource(http).resolve({
                ref: ref('npm:typescript'),
                observedVersion: '5.9.2',
            });

            expect(result.deprecated).toBe(false);
        });

        it('should leave deprecation null when no observed version was given', async () => {
            const http = new FakeHttpClient({ [NPM_URL]: { body: packument } });

            const result = await new NpmRegistrySource(http).resolve({
                ref: ref('npm:typescript'),
            });

            expect(result.deprecated).toBeNull();
        });

        it('should leave deprecation null for a version the registry does not list', async () => {
            const http = new FakeHttpClient({ [NPM_URL]: { body: packument } });

            const result = await new NpmRegistrySource(http).resolve({
                ref: ref('npm:typescript'),
                observedVersion: '4.0.0',
            });

            // "Not listed" is not the same as "fine", and only one of those is true.
            expect(result.deprecated).toBeNull();
        });
    });
});

describe('GithubReleaseSource', () => {
    it('should resolve the latest release tag', async () => {
        const http = new FakeHttpClient({
            [RELEASE_URL]: { body: JSON.stringify({ tag_name: 'v5.0.0' }) },
        });

        const result = await new GithubReleaseSource(http).resolve({
            ref: ref('github-release:actions/checkout'),
        });

        expect(result).toMatchObject({
            status: 'resolved',
            version: '5.0.0',
            raw: 'v5.0.0',
            method: 'github-release',
        });
    });

    it.each([
        ['a draft', { tag_name: 'v5.0.0', draft: true }],
        ['a prerelease', { tag_name: 'v5.0.0', prerelease: true }],
    ])('should not accept %s as the latest release', async (_label, release) => {
        const http = new FakeHttpClient({ [RELEASE_URL]: { body: JSON.stringify(release) } });

        const result = await new GithubReleaseSource(http).resolve({
            ref: ref('github-release:actions/checkout'),
        });

        expect(result.status).toBe('unresolved');
    });

    it.each([
        ['a rate-limited response', { status: 403, ok: false, body: '' }, /403/],
        ['unparseable JSON', { body: 'not json' }, /not valid JSON/i],
        ['a release with no tag', { body: '{}' }, /no tag/i],
        [
            'a tag that is not a version',
            { body: JSON.stringify({ tag_name: 'nightly' }) },
            /not a usable version/i,
        ],
    ])('should report %s as unresolved', async (_label, entry, match) => {
        const http = new FakeHttpClient({ [RELEASE_URL]: entry });

        const result = await new GithubReleaseSource(http).resolve({
            ref: ref('github-release:actions/checkout'),
        });

        expect(result.status).toBe('unresolved');
        expect(result.reason).toMatch(match);
    });

    it('should reject an identifier that is not owner/repo', async () => {
        const result = await new GithubReleaseSource(new FakeHttpClient()).resolve({
            ref: ref('github-release:checkout'),
        });

        expect(result.reason).toMatch(/owner\/repo/);
    });
});

describe('GithubTagSource', () => {
    const tags = JSON.stringify([{ name: 'v1.34.0' }, { name: 'v1.33.1' }, { name: 'nightly' }]);

    it('should resolve the newest usable tag', async () => {
        const http = new FakeHttpClient({ [TAGS_URL]: { body: tags } });

        const result = await new GithubTagSource(http).resolve({
            ref: ref('github-tag:kubernetes/kubernetes'),
        });

        expect(result).toMatchObject({ status: 'resolved', version: '1.34.0', raw: 'v1.34.0' });
    });

    it('should distinguish "no tags" from "nothing matched"', async () => {
        const empty = new FakeHttpClient({ [TAGS_URL]: { body: '[]' } });
        const unusable = new FakeHttpClient({ [TAGS_URL]: { body: tags } });

        const noTags = await new GithubTagSource(empty).resolve({
            ref: ref('github-tag:kubernetes/kubernetes'),
        });
        const noMatch = await new GithubTagSource(unusable).resolve({
            ref: ref('github-tag:kubernetes/kubernetes'),
            tagPattern: /^v9/,
        });

        expect(noTags.reason).toMatch(/no tags/i);
        expect(noMatch.reason).toMatch(/matches/i);
    });

    it('should report a non-array response as unresolved rather than crashing', async () => {
        const http = new FakeHttpClient({ [TAGS_URL]: { body: '{"message":"Not Found"}' } });

        const result = await new GithubTagSource(http).resolve({
            ref: ref('github-tag:kubernetes/kubernetes'),
        });

        expect(result.status).toBe('unresolved');
    });

    it.each([
        ['an error status', { status: 404, ok: false, body: '' }],
        ['unparseable JSON', { body: 'not json' }],
    ])('should report %s as unresolved', async (_label, entry) => {
        const http = new FakeHttpClient({ [TAGS_URL]: entry });

        const result = await new GithubTagSource(http).resolve({
            ref: ref('github-tag:kubernetes/kubernetes'),
        });

        expect(result.status).toBe('unresolved');
    });

    it('should reject an identifier that is not owner/repo', async () => {
        const result = await new GithubTagSource(new FakeHttpClient()).resolve({
            ref: ref('github-tag:kubernetes'),
        });

        expect(result.reason).toMatch(/owner\/repo/);
    });
});

describe('OciTagSource', () => {
    function ghcr(tagBody: string): FakeHttpClient {
        return new FakeHttpClient({
            [GHCR_TOKEN_URL]: { body: JSON.stringify({ token: 'anon' }) },
            [GHCR_TAGS_URL]: { body: tagBody },
        });
    }

    it('should exchange a token and resolve the newest tag', async () => {
        const http = ghcr(JSON.stringify({ tags: ['2.320.0', '2.321.0', 'latest'] }));

        const result = await new OciTagSource(http).resolve({
            ref: ref('oci:ghcr.io/actions/actions-runner'),
        });

        expect(result).toMatchObject({
            status: 'resolved',
            version: '2.321.0',
            method: 'oci-registry',
        });
    });

    it('should send the token as a bearer credential on the tag listing', async () => {
        const http = ghcr(JSON.stringify({ tags: ['2.321.0'] }));

        await new OciTagSource(http).resolve({ ref: ref('oci:ghcr.io/actions/actions-runner') });

        const listing = http.requests.find((request) => request.url === GHCR_TAGS_URL);
        expect(listing?.headers?.authorization).toBe('Bearer anon');
    });

    it('should record evidence for both the token exchange and the listing', async () => {
        const http = ghcr(JSON.stringify({ tags: ['2.321.0'] }));

        const result = await new OciTagSource(http).resolve({
            ref: ref('oci:ghcr.io/actions/actions-runner'),
        });

        expect(result.evidence).toHaveLength(2);
    });

    it('should skip the token exchange for a registry that needs none', async () => {
        const http = new FakeHttpClient({
            [MCR_TAGS_URL]: { body: JSON.stringify({ tags: ['3.0.0-bookworm', 'latest'] }) },
        });

        const result = await new OciTagSource(http).resolve({
            ref: ref('oci:mcr.microsoft.com/devcontainers/base'),
            tagPattern: /^\d+\.\d+\.\d+-(bullseye|bookworm)$/,
            includePrereleases: true,
        });

        expect(result.status).toBe('resolved');
        expect(http.requests).toHaveLength(1);
    });

    it('should report an unmatched tag pattern as unresolved, never as no drift', async () => {
        // A pattern matching nothing is a configuration bug and must surface as one.
        const http = ghcr(JSON.stringify({ tags: ['2.321.0', '2.320.0'] }));

        const result = await new OciTagSource(http).resolve({
            ref: ref('oci:ghcr.io/actions/actions-runner'),
            tagPattern: /^9\./,
        });

        expect(result.status).toBe('unresolved');
        expect(result.reason).toMatch(/matches/i);
    });

    it.each([
        [
            'a failed token exchange',
            { [GHCR_TOKEN_URL]: { status: 429, ok: false, body: '' } },
            /token exchange/i,
        ],
        ['a token response with no token', { [GHCR_TOKEN_URL]: { body: '{}' } }, /no token/i],
    ])('should report %s as unresolved', async (_label, responses, match) => {
        const http = new FakeHttpClient(responses);

        const result = await new OciTagSource(http).resolve({
            ref: ref('oci:ghcr.io/actions/actions-runner'),
        });

        expect(result.status).toBe('unresolved');
        expect(result.reason).toMatch(match);
    });

    it.each([
        ['an error listing', { status: 500, ok: false, body: '' }, /500/],
        ['unparseable JSON', { body: 'not json' }, /not valid JSON/i],
        ['a listing with no tags', { body: '{}' }, /no tags/i],
    ])('should report %s as unresolved', async (_label, entry, match) => {
        const http = ghcr('');
        http.on(GHCR_TAGS_URL, entry);

        const result = await new OciTagSource(http).resolve({
            ref: ref('oci:ghcr.io/actions/actions-runner'),
        });

        expect(result.status).toBe('unresolved');
        expect(result.reason).toMatch(match);
    });

    it('should reject a reference with no repository part', async () => {
        const result = await new OciTagSource(new FakeHttpClient()).resolve({
            ref: ref('oci:ghcr.io'),
        });

        expect(result.reason).toMatch(/registry.*repository/i);
    });

    it('should report an unconfigured registry rather than guessing its API', async () => {
        const result = await new OciTagSource(new FakeHttpClient()).resolve({
            ref: ref('oci:quay.io/some/image'),
        });

        expect(result.reason).toMatch(/no registry configured/i);
    });

    it('should accept the access_token field some registries use instead of token', async () => {
        const http = new FakeHttpClient({
            'https://auth.docker.io/token?service=registry.docker.io&scope=repository:library/node:pull':
                { body: JSON.stringify({ access_token: 'anon' }) },
            'https://registry-1.docker.io/v2/library/node/tags/list': {
                body: JSON.stringify({ tags: ['22.0.0', '24.1.0'] }),
            },
        });

        const result = await new OciTagSource(http).resolve({
            ref: ref('oci:docker.io/library/node'),
        });

        expect(result.version).toBe('24.1.0');
    });

    it('should report an unparseable token response as unresolved', async () => {
        const http = new FakeHttpClient({
            [GHCR_TOKEN_URL]: { body: 'not json' },
        });

        const result = await new OciTagSource(http).resolve({
            ref: ref('oci:ghcr.io/actions/actions-runner'),
        });

        expect(result.status).toBe('unresolved');
        expect(result.reason).toMatch(/no token/i);
    });

    it('should tolerate an oci:// prefix in the identifier', async () => {
        const http = ghcr(JSON.stringify({ tags: ['2.321.0'] }));

        const result = await new OciTagSource(http).resolve({
            ref: ref('oci://ghcr.io/actions/actions-runner'),
        });

        expect(result.status).toBe('resolved');
    });

    describe('as the helm alias', () => {
        it('should record helm-oci provenance while reusing the same implementation', async () => {
            const http = new FakeHttpClient({
                'https://ghcr.io/token?service=ghcr.io&scope=repository:actions/actions-runner-controller-charts/gha-runner-scale-set:pull':
                    { body: JSON.stringify({ token: 'anon' }) },
                'https://ghcr.io/v2/actions/actions-runner-controller-charts/gha-runner-scale-set/tags/list':
                    { body: JSON.stringify({ tags: ['0.14.1', '0.14.2'] }) },
            });

            const result = await new OciTagSource(http, undefined, 'helm').resolve({
                ref: ref(
                    'helm:ghcr.io/actions/actions-runner-controller-charts/gha-runner-scale-set',
                ),
            });

            expect(result).toMatchObject({ version: '0.14.2', method: 'helm-oci' });
        });
    });
});

describe('evidence helpers', () => {
    it('should record a command invocation, digesting stdout rather than embedding it', () => {
        // A report is reviewed by humans; a megabyte of npm audit output in it is not
        // evidence, it is noise. The digest proves what was parsed.
        const record = commandEvidence({
            argv: ['npm', 'outdated', '--json'],
            cwd: '/repo',
            exitCode: 1,
            stdout: '{"typescript":{}}',
            stderr: '',
            durationMs: 820,
        });

        expect(record).toMatchObject({
            type: 'command',
            argv: ['npm', 'outdated', '--json'],
            cwd: '/repo',
            exitCode: 1,
            durationMs: 820,
            stderrExcerpt: null,
        });
        expect(record).toHaveProperty('stdoutSha256', expect.stringMatching(/^[0-9a-f]{64}$/));
    });

    it('should truncate a long stderr rather than carrying all of it', () => {
        const record = commandEvidence({
            argv: ['npm', 'audit'],
            cwd: '/repo',
            exitCode: 1,
            stdout: '',
            stderr: 'x'.repeat(5000),
            durationMs: 10,
        });

        expect(record).toHaveProperty('stderrExcerpt');
        if (record.type === 'command' && record.stderrExcerpt !== null) {
            expect(record.stderrExcerpt).toHaveLength(2000);
        }
    });

    it('should digest identical stdout identically', () => {
        const of = (stdout: string) =>
            commandEvidence({
                argv: ['x'],
                cwd: '/',
                exitCode: 0,
                stdout,
                stderr: '',
                durationMs: 1,
            });

        expect(of('same')).toEqual(of('same'));
        expect(of('a')).not.toEqual(of('b'));
    });
});

describe('StaticSource', () => {
    it('should return the configured value at low confidence', async () => {
        const result = await new StaticSource().resolve({ ref: ref('static:v1.11.4-eksbuild.2') });

        expect(result).toMatchObject({
            status: 'resolved',
            version: 'v1.11.4-eksbuild.2',
            method: 'static-config',
            confidence: 'low',
        });
    });
});

describe('VersionSourceRegistry', () => {
    function registryWith(http: FakeHttpClient): VersionSourceRegistry {
        return buildDefaultSourceRegistry({ http });
    }

    it('should dispatch to the source matching the scheme', async () => {
        const http = new FakeHttpClient({
            [NPM_URL]: { body: JSON.stringify({ 'dist-tags': { latest: '5.9.2' } }) },
        });

        await expect(registryWith(http).resolve('npm:typescript')).resolves.toMatchObject({
            version: '5.9.2',
        });
    });

    it('should register every scheme the config schema accepts', () => {
        expect(registryWith(new FakeHttpClient()).schemes.sort()).toEqual(
            ['github-release', 'github-tag', 'helm', 'npm', 'oci', 'static'].sort(),
        );
    });

    it('should resolve a repeated reference once [REQ-NET-023]', async () => {
        const http = new FakeHttpClient({
            [NPM_URL]: { body: JSON.stringify({ 'dist-tags': { latest: '5.9.2' } }) },
        });
        const registry = registryWith(http);

        await registry.resolve('npm:typescript');
        await registry.resolve('npm:typescript');

        expect(http.requests).toHaveLength(1);
    });

    it('should share one request between concurrent callers', async () => {
        const http = new FakeHttpClient({
            [NPM_URL]: { body: JSON.stringify({ 'dist-tags': { latest: '5.9.2' } }) },
        });
        const registry = registryWith(http);

        await Promise.all([registry.resolve('npm:typescript'), registry.resolve('npm:typescript')]);

        expect(http.requests).toHaveLength(1);
    });

    it('should treat different tag patterns as different questions', async () => {
        const http = new FakeHttpClient({
            [GHCR_TOKEN_URL]: { body: JSON.stringify({ token: 'anon' }) },
            [GHCR_TAGS_URL]: { body: JSON.stringify({ tags: ['2.321.0', '1.0.0'] }) },
        });
        const registry = registryWith(http);

        const wide = await registry.resolve('oci:ghcr.io/actions/actions-runner', {
            tagPattern: /^\d/,
        });
        const narrow = await registry.resolve('oci:ghcr.io/actions/actions-runner', {
            tagPattern: /^1\./,
        });

        expect(wide.version).toBe('2.321.0');
        expect(narrow.version).toBe('1.0.0');
    });

    it('should raise a config error for a malformed reference', async () => {
        await expect(
            registryWith(new FakeHttpClient()).resolve('typescript'),
        ).rejects.toBeInstanceOf(ConfigError);
    });

    it('should raise a config error for an unregistered scheme', async () => {
        const registry = new VersionSourceRegistry([new StaticSource()]);

        await expect(registry.resolve('npm:typescript')).rejects.toThrow(/no source registered/i);
    });

    it('should convert a thrown source failure into an unresolved result [REQ-ERR-030]', async () => {
        // A source that cannot reach upstream must not abort the collector.
        const http = new FakeHttpClient({ [NPM_URL]: new NetworkError('connection reset') });

        const result = await registryWith(http).resolve('npm:typescript');

        expect(result.status).toBe('unresolved');
        expect(result.reason).toMatch(/connection reset/);
        expect(result.method).toBe('not-attempted');
    });
});
