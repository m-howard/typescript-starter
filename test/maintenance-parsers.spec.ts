import { promises as fs } from 'fs';
import * as path from 'path';
import {
    advisoriesOf,
    advisoryId,
    findToolPins,
    isFirstPartyAction,
    parseActionReference,
    parseDockerfile,
    parseNpmAudit,
    parseNpmOutdated,
    parsePackageJson,
    parseWorkflow,
    readFixAvailable,
    readVersionComment,
    splitImageReference,
    substitute,
    transitiveChainOf,
    ValuesDocument,
} from '../src/maintenance/parsers';
import { ConfigError, ParseError } from '../src/maintenance/errors';

const REPO_ROOT = path.join(__dirname, '..');
const FIXTURES = path.join(__dirname, 'fixtures', 'maintenance');

const read = (file: string) => fs.readFile(file, 'utf8');

describe('parsePackageJson', () => {
    let manifest: string;

    beforeAll(async () => {
        manifest = await read(path.join(REPO_ROOT, 'package.json'));
    });

    it('should read both dependency blocks [REQ-NPM-010]', () => {
        const parsed = parsePackageJson(manifest);
        const scopes = new Set(parsed.dependencies.map((dependency) => dependency.scope));

        expect(scopes).toEqual(new Set(['runtime', 'dev']));
        expect(parsed.dependencies.length).toBeGreaterThan(30);
    });

    it('should record the scope from the block a key was found in [REQ-NPM-018]', () => {
        const parsed = parsePackageJson(manifest);
        const find = (name: string) => parsed.dependencies.find((d) => d.name === name);

        expect(find('lodash')?.scope).toBe('runtime');
        expect(find('typescript')?.scope).toBe('dev');
    });

    it('should locate a key inside its block, not a same-named config section', async () => {
        // "jest" is both a devDependency and a top-level config block in this manifest,
        // so a text search for the quoted key matches two lines. Only one is the
        // declaration, and evidence pointing at the wrong one looks authoritative.
        const parsed = parsePackageJson(manifest);
        const jest = parsed.dependencies.find((d) => d.name === 'jest');
        const lines = manifest.split('\n');

        expect(jest?.line).not.toBeNull();
        expect(lines[(jest?.line ?? 1) - 1].trim()).toMatch(/^"jest":\s*"/);
    });

    it.each([['jest'], ['prisma'], ['typescript'], ['eslint'], ['prettier']])(
        'should point at the actual declaration line for %s',
        (name: string) => {
            const parsed = parsePackageJson(manifest);
            const dependency = parsed.dependencies.find((d) => d.name === name);
            const lines = manifest.split('\n');

            expect(lines[(dependency?.line ?? 1) - 1].trim()).toBe(
                `"${name}": "${dependency?.range}",`,
            );
        },
    );

    it('should not confuse a name that is a prefix of another', () => {
        const parsed = parsePackageJson(manifest);
        const eslint = parsed.dependencies.find((d) => d.name === 'eslint');
        const plugin = parsed.dependencies.find((d) => d.name === 'eslint-plugin-prettier');

        expect(eslint?.line).not.toBe(plugin?.line);
    });

    it('should read the manifest identity', () => {
        expect(parsePackageJson(manifest).name).toBe('typescript-starter');
    });

    it('should handle a manifest with no dependency blocks', () => {
        expect(parsePackageJson('{"name":"empty"}').dependencies).toEqual([]);
    });

    it('should ignore a dependency block that is not a name-to-range mapping', () => {
        expect(parsePackageJson('{"dependencies":["not","an","object"]}').dependencies).toEqual([]);
    });

    it('should ignore a non-string range rather than inventing one', () => {
        const parsed = parsePackageJson('{"dependencies":{"a":"^1.0.0","b":{"nested":true}}}');

        expect(parsed.dependencies.map((d) => d.name)).toEqual(['a']);
    });

    it('should report a null line rather than guessing when the key cannot be located', () => {
        // Reachable when a manifest is minified onto one line.
        const parsed = parsePackageJson('{"dependencies":{"a":"^1.0.0"}}');

        expect(parsed.dependencies[0].line).toBeNull();
    });

    it('should locate a key in a block written on one line', () => {
        const parsed = parsePackageJson('{\n  "dependencies": { "a": "^1.0.0" }\n}');

        expect(parsed.dependencies[0].line).toBe(2);
    });

    it('should not run past the end of an unterminated block', () => {
        // Truncated input still yields a parse error from JSON.parse, but the span
        // helper must terminate rather than loop.
        expect(() => parsePackageJson('{\n  "dependencies": {\n    "a": "^1.0.0"')).toThrow(
            ParseError,
        );
    });

    it('should raise ParseError for invalid JSON, naming the file', () => {
        expect(() => parsePackageJson('{ not json', 'pkg/package.json')).toThrow(ParseError);
        expect(() => parsePackageJson('{ not json', 'pkg/package.json')).toThrow(
            'pkg/package.json',
        );
    });
});

describe('parseNpmOutdated', () => {
    it('should parse the captured output', async () => {
        const report = parseNpmOutdated(await read(path.join(FIXTURES, 'npm-outdated.json')));

        expect(report.typescript).toMatchObject({ type: 'devDependencies' });
        expect(report.lodash).toMatchObject({ type: 'dependencies' });
    });

    it('should treat empty output as nothing outdated', () => {
        // A clean run can print nothing at all rather than an empty object.
        expect(parseNpmOutdated('')).toEqual({});
        expect(parseNpmOutdated('   \n')).toEqual({});
        expect(parseNpmOutdated('{}')).toEqual({});
    });

    it('should tolerate an entry with no current version, which npm omits when uninstalled', () => {
        const report = parseNpmOutdated('{"a":{"latest":"2.0.0"}}');

        expect(report.a.current).toBeUndefined();
        expect(report.a.latest).toBe('2.0.0');
    });

    it('should tolerate unknown fields npm may add', () => {
        expect(() => parseNpmOutdated('{"a":{"latest":"2.0.0","futureField":1}}')).not.toThrow();
    });

    it('should raise ParseError for unparseable output', () => {
        expect(() => parseNpmOutdated('not json')).toThrow(ParseError);
    });

    it('should raise ParseError when the shape is wrong', () => {
        expect(() => parseNpmOutdated('{"a":"a string, not an entry"}')).toThrow(ParseError);
    });
});

describe('parseNpmAudit', () => {
    let auditJson: string;

    beforeAll(async () => {
        auditJson = await read(path.join(FIXTURES, 'npm-audit.json'));
    });

    it('should parse the captured output', () => {
        const report = parseNpmAudit(auditJson);

        expect(Object.keys(report.vulnerabilities).length).toBeGreaterThan(0);
    });

    it('should survive via[] mixing strings and objects [REQ-NPM-016]', () => {
        const report = parseNpmAudit(auditJson);
        const shapes = new Set<string>();
        for (const vulnerability of Object.values(report.vulnerabilities)) {
            for (const entry of vulnerability.via) {
                shapes.add(typeof entry);
            }
        }

        expect(shapes).toEqual(new Set(['string', 'object']));
    });

    it('should survive fixAvailable being boolean or object', () => {
        const report = parseNpmAudit(auditJson);
        const shapes = new Set(
            Object.values(report.vulnerabilities).map((v) => typeof v.fixAvailable),
        );

        expect(shapes).toEqual(new Set(['boolean', 'object']));
    });

    it('should treat empty output as no vulnerabilities', () => {
        expect(parseNpmAudit('').vulnerabilities).toEqual({});
    });

    it('should raise ParseError for unparseable output', () => {
        expect(() => parseNpmAudit('not json')).toThrow(ParseError);
    });

    it('should raise ParseError when a vulnerability is missing required fields', () => {
        expect(() => parseNpmAudit('{"vulnerabilities":{"a":{"name":"a"}}}')).toThrow(ParseError);
    });

    describe('advisoriesOf', () => {
        it('should return only the object entries of via[]', () => {
            const report = parseNpmAudit(auditJson);
            const babel = report.vulnerabilities['@babel/core'];

            expect(advisoriesOf(babel)).toHaveLength(1);
        });

        it('should mint no advisory from chain-link strings', () => {
            // A string names a package in a transitive chain, not an advisory.
            const report = parseNpmAudit(auditJson);
            const clerk = report.vulnerabilities['@clerk/clerk-sdk-node'];

            expect(clerk.via.every((entry) => typeof entry === 'string')).toBe(true);
            expect(advisoriesOf(clerk)).toEqual([]);
            expect(transitiveChainOf(clerk)).toEqual(['@clerk/backend', '@clerk/shared']);
        });

        it('should discard an advisory with no identifiable id', () => {
            // A finding keyed on undefined would collide with every other one.
            const report = parseNpmAudit(
                '{"vulnerabilities":{"a":{"name":"a","severity":"high","isDirect":true,' +
                    '"via":[{"title":"nameless"}]}}}',
            );

            expect(advisoriesOf(report.vulnerabilities.a)).toEqual([]);
        });
    });

    describe('advisoryId', () => {
        it('should prefer the GHSA identifier from the advisory URL', () => {
            expect(
                advisoryId({ url: 'https://github.com/advisories/GHSA-4x5r-pxfx-6jf8', source: 1 }),
            ).toBe('GHSA-4x5r-pxfx-6jf8');
        });

        it('should fall back to the npm source id', () => {
            expect(advisoryId({ source: 1123528 })).toBe('npm-1123528');
        });

        it('should return null when neither is present', () => {
            expect(advisoryId({ title: 'anonymous' })).toBeNull();
        });
    });

    describe('readFixAvailable', () => {
        it.each([
            ['a plain false', false, { available: false, version: null, isSemverMajor: null }],
            ['a plain true', true, { available: true, version: null, isSemverMajor: null }],
        ])('should normalise %s', (_label, fix, expected) => {
            expect(readFixAvailable(fix)).toEqual(expected);
        });

        it('should read the version and major flag from the object form', () => {
            expect(readFixAvailable({ name: 'x', version: '5.1.6', isSemVerMajor: true })).toEqual({
                available: true,
                version: '5.1.6',
                isSemverMajor: true,
            });
        });
    });
});

describe('parseWorkflow', () => {
    let workflow: string;

    beforeAll(async () => {
        workflow = await read(path.join(REPO_ROOT, '.github/workflows/ci.yml'));
    });

    it('should find every uses: reference in the real workflow', () => {
        const parsed = parseWorkflow(workflow, 'ci.yml');

        expect(parsed.actions.map((a) => a.repository)).toEqual([
            'actions/checkout',
            'actions/setup-node',
            'actions/checkout',
            'actions/setup-node',
        ]);
    });

    it('should report the line each reference is declared on [REQ-GHA-011]', () => {
        const parsed = parseWorkflow(workflow, 'ci.yml');
        const lines = workflow.split('\n');

        for (const action of parsed.actions) {
            expect(lines[action.line - 1]).toContain(action.raw);
        }
    });

    it('should carry a snippet for evidence', () => {
        const parsed = parseWorkflow(workflow, 'ci.yml');

        expect(parsed.actions[0].snippet).toContain('uses:');
    });

    it('should find a reusable workflow reference as well as a step [REQ-GHA-012]', () => {
        const yaml = [
            'jobs:',
            '  call:',
            '    uses: owner/repo/.github/workflows/shared.yml@v1',
            '  build:',
            '    steps:',
            '      - uses: actions/checkout@v4',
        ].join('\n');

        expect(parseWorkflow(yaml, 'w.yml').actions).toHaveLength(2);
    });

    it('should separate a subdirectory from the repository [REQ-GHA-013]', () => {
        const parsed = parseWorkflow(
            'jobs:\n  a:\n    steps:\n      - uses: owner/repo/sub/dir@v1\n',
            'w.yml',
        );

        expect(parsed.actions[0]).toMatchObject({
            repository: 'owner/repo',
            subdirectory: 'sub/dir',
            ref: 'v1',
        });
    });

    it('should skip a local action without erroring [REQ-GHA-014]', () => {
        const parsed = parseWorkflow(
            'jobs:\n  a:\n    steps:\n      - uses: ./.github/actions/local\n',
            'w.yml',
        );

        expect(parsed.actions).toEqual([]);
        expect(parsed.skipped[0]).toMatchObject({ reason: 'local-path' });
    });

    it('should route a docker reference to the images collector rather than dropping it', () => {
        const parsed = parseWorkflow(
            'jobs:\n  a:\n    steps:\n      - uses: docker://alpine:3.20\n',
            'w.yml',
        );

        expect(parsed.skipped[0]).toMatchObject({ reason: 'docker-image' });
    });

    it.each([
        ['a tag', 'actions/checkout@v4', 'tag'],
        ['a SHA', `actions/checkout@${'a'.repeat(40)}`, 'sha'],
        ['a branch', 'actions/checkout@main', 'branch'],
        ['no ref at all', 'actions/checkout', 'none'],
    ])('should classify %s', (_label, raw: string, pin: string) => {
        expect(parseActionReference(raw)?.pin).toBe(pin);
    });

    it('should reject a reference that is not owner/repo', () => {
        expect(parseActionReference('checkout')).toBeNull();
        expect(parseActionReference('owner/')).toBeNull();
    });

    it('should skip a uses: value that is not an action reference', () => {
        const parsed = parseWorkflow(
            'jobs:\n  a:\n    steps:\n      - uses: notavalidreference\n',
            'w.yml',
        );

        expect(parsed.actions).toEqual([]);
    });

    it('should ignore a uses: key whose value is not a string', () => {
        const parsed = parseWorkflow('jobs:\n  a:\n    steps:\n      - uses:\n', 'w.yml');

        expect(parsed.actions).toEqual([]);
    });

    it('should raise ParseError for malformed YAML, naming the file [REQ-GHA-016]', () => {
        expect(() => parseWorkflow('jobs:\n  - [unclosed\n', 'broken.yml')).toThrow(ParseError);
        expect(() => parseWorkflow('jobs:\n  - [unclosed\n', 'broken.yml')).toThrow('broken.yml');
    });

    it('should raise ParseError for duplicate keys rather than silently taking one', () => {
        expect(() => parseWorkflow('jobs:\n  a: 1\n  a: 2\n', 'dup.yml')).toThrow(ParseError);
    });

    it('should behave identically on a CRLF checkout', () => {
        const lf = parseWorkflow(workflow, 'ci.yml');
        const crlf = parseWorkflow(workflow.replace(/\n/g, '\r\n'), 'ci.yml');

        expect(crlf.actions.map((a) => a.line)).toEqual(lf.actions.map((a) => a.line));
    });
});

describe('isFirstPartyAction', () => {
    it.each([
        ['actions/checkout', true],
        ['github/codeql-action', true],
        ['ACTIONS/checkout', true],
        ['some-vendor/deploy', false],
    ])('should classify %s', (repository: string, expected: boolean) => {
        expect(isFirstPartyAction(repository)).toBe(expected);
    });
});

describe('readVersionComment', () => {
    it('should read the version a SHA pin documents', () => {
        expect(readVersionComment(`- uses: actions/checkout@${'a'.repeat(40)} # v4.2.2`)).toBe(
            'v4.2.2',
        );
    });

    it('should return null when there is no comment', () => {
        expect(readVersionComment('- uses: actions/checkout@v4')).toBeNull();
    });
});

describe('parseDockerfile', () => {
    let dockerfile: string;

    beforeAll(async () => {
        dockerfile = await read(path.join(REPO_ROOT, '.devcontainer/Dockerfile'));
    });

    it('should read the base image of the real devcontainer', () => {
        const parsed = parseDockerfile(dockerfile);

        expect(parsed.baseImages).toHaveLength(1);
        expect(parsed.baseImages[0]).toMatchObject({
            image: 'mcr.microsoft.com/devcontainers/base',
            tag: 'bullseye',
            digest: null,
            line: 1,
        });
    });

    it('should not treat a preceding stage as a registry reference [REQ-IMG-011]', () => {
        const parsed = parseDockerfile(
            ['FROM node:22 AS build', 'RUN echo hi', 'FROM build', 'FROM build AS final'].join(
                '\n',
            ),
        );

        expect(parsed.baseImages.map((b) => b.image)).toEqual(['node']);
        expect(parsed.stages).toEqual(['build', 'final']);
    });

    it('should resolve build-argument substitution [REQ-IMG-012]', () => {
        const parsed = parseDockerfile(
            ['ARG BASE=node', 'ARG TAG=22.1.0', 'FROM ${BASE}:${TAG}'].join('\n'),
        );

        expect(parsed.baseImages[0]).toMatchObject({
            image: 'node',
            tag: '22.1.0',
            unresolved: false,
        });
    });

    it('should use an inline default when the argument is undeclared', () => {
        const parsed = parseDockerfile('FROM node:${TAG:-22.1.0}');

        expect(parsed.baseImages[0]).toMatchObject({ tag: '22.1.0', unresolved: false });
    });

    it('should mark an unresolvable argument rather than treating it as literal [REQ-IMG-013]', () => {
        const parsed = parseDockerfile('FROM node:${UNDECLARED_TAG}');

        expect(parsed.baseImages[0].unresolved).toBe(true);
    });

    it('should record a digest pin as deliberate rather than as a tag', () => {
        const parsed = parseDockerfile(`FROM node@sha256:${'a'.repeat(64)}`);

        expect(parsed.baseImages[0]).toMatchObject({ tag: null });
        expect(parsed.baseImages[0].digest).toContain('sha256:');
    });

    it('should ignore platform flags', () => {
        const parsed = parseDockerfile('FROM --platform=linux/amd64 node:22');

        expect(parsed.baseImages[0]).toMatchObject({ image: 'node', tag: '22' });
    });

    it('should report the starting line of a continued instruction', () => {
        const parsed = parseDockerfile(['ARG TAG=22', 'FROM \\', '  node:${TAG}'].join('\n'));

        expect(parsed.baseImages[0]).toMatchObject({ tag: '22', line: 2 });
    });

    it('should read ARG and ENV declarations with their lines', () => {
        const parsed = parseDockerfile(
            ['ENV KUBECTL_VERSION=v1.31.4', 'ARG HELM=3.16.3'].join('\n'),
        );

        expect(parsed.args).toEqual([
            { name: 'KUBECTL_VERSION', value: 'v1.31.4', line: 1 },
            { name: 'HELM', value: '3.16.3', line: 2 },
        ]);
    });

    it('should read the two-token ARG form', () => {
        expect(parseDockerfile('ARG VERSION 1.2.3').args).toEqual([
            { name: 'VERSION', value: '1.2.3', line: 1 },
        ]);
    });

    it('should unquote a quoted value', () => {
        expect(parseDockerfile('ENV TAG="22.1.0"').args[0].value).toBe('22.1.0');
    });

    it('should be case-insensitive about instructions', () => {
        expect(parseDockerfile('from node:22').baseImages).toHaveLength(1);
    });

    it('should ignore a FROM with nothing but flags', () => {
        expect(parseDockerfile('FROM --platform=linux/amd64').baseImages).toEqual([]);
    });

    it('should ignore a bare target with no registry or tag, such as scratch', () => {
        expect(parseDockerfile('FROM scratch').baseImages).toEqual([]);
    });

    it('should not lose an instruction whose continuation ends the file', () => {
        const parsed = parseDockerfile('ARG TAG=22\nFROM \\\n  node:${TAG}');

        expect(parsed.baseImages[0]).toMatchObject({ tag: '22' });
    });

    it('should ignore a FROM naming a declared build argument', () => {
        const parsed = parseDockerfile('ARG BASE_STAGE=builder\nFROM BASE_STAGE');

        expect(parsed.baseImages).toEqual([]);
    });

    it('should behave identically on a CRLF checkout', () => {
        const lf = parseDockerfile(dockerfile);
        const crlf = parseDockerfile(dockerfile.replace(/\n/g, '\r\n'));

        expect(crlf.baseImages).toEqual(lf.baseImages);
    });
});

describe('splitImageReference', () => {
    it.each([
        ['a tagged image', 'node:22', { image: 'node', tag: '22', digest: null }],
        [
            'a registry-qualified image',
            'mcr.microsoft.com/devcontainers/base:bullseye',
            { image: 'mcr.microsoft.com/devcontainers/base', tag: 'bullseye', digest: null },
        ],
        ['an untagged image', 'node', { image: 'node', tag: null, digest: null }],
        [
            'a registry port, which is not a tag',
            'registry:5000/team/app',
            { image: 'registry:5000/team/app', tag: null, digest: null },
        ],
    ])('should split %s', (_label, reference: string, expected) => {
        expect(splitImageReference(reference)).toEqual(expected);
    });
});

describe('substitute', () => {
    const args = new Map([['TAG', '22.1.0']]);

    it.each([
        ['braced', 'node:${TAG}', 'node:22.1.0', false],
        ['bare', 'node:$TAG', 'node:22.1.0', false],
        ['with an unused default', 'node:${TAG:-1.0.0}', 'node:22.1.0', false],
        ['falling back to a default', 'node:${OTHER:-1.0.0}', 'node:1.0.0', false],
    ])('should substitute a %s reference', (_label, input, expected, unresolved) => {
        expect(substitute(input, args)).toEqual({ value: expected, unresolved });
    });

    it('should flag an unresolvable reference and leave it visible', () => {
        expect(substitute('node:${MISSING}', args)).toEqual({
            value: 'node:${MISSING}',
            unresolved: true,
        });
    });
});

describe('findToolPins', () => {
    const definitions = [
        { id: 'pulumi', pattern: 'sh -s -- --version (\\d+\\.\\d+\\.\\d+)' },
        { id: 'nodesource-node', pattern: 'setup_(\\d+)\\.x' },
    ];

    it('should find the pins in the real devcontainer', async () => {
        const dockerfile = await read(path.join(REPO_ROOT, '.devcontainer/Dockerfile'));
        const pins = findToolPins(dockerfile, definitions);

        expect(pins).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ id: 'pulumi', version: '3.178.0' }),
                expect.objectContaining({ id: 'nodesource-node', version: '22' }),
            ]),
        );
    });

    it('should return every occurrence, since a stage can pin the same tool twice', () => {
        const text = ['ENV KUBECTL_VERSION=v1.31.4', 'FROM x', 'ENV KUBECTL_VERSION=v1.31.4'].join(
            '\n',
        );
        const pins = findToolPins(text, [
            { id: 'kubectl', pattern: 'KUBECTL_VERSION=v?(\\d+\\.\\d+\\.\\d+)' },
        ]);

        expect(pins.map((pin) => pin.line)).toEqual([1, 3]);
    });

    it('should produce nothing when the tool is absent, and not error [REQ-IMG-019]', () => {
        expect(findToolPins('FROM node:22', definitions)).toEqual([]);
    });

    it('should carry the line and snippet for evidence', () => {
        const pins = findToolPins('FROM x\nENV HELM=3.16.3', [
            { id: 'helm', pattern: 'HELM=(\\d+\\.\\d+\\.\\d+)' },
        ]);

        expect(pins[0]).toMatchObject({ line: 2, snippet: 'ENV HELM=3.16.3' });
    });

    it('should raise a config error for an invalid pattern', () => {
        expect(() => findToolPins('x', [{ id: 'bad', pattern: '([unclosed' }])).toThrow(
            ConfigError,
        );
    });

    it('should raise a config error for a pattern with no capture group', () => {
        // Without one there is nothing to read the version from, which is a config
        // mistake rather than an absent tool.
        expect(() => findToolPins('x', [{ id: 'bad', pattern: 'HELM=\\d+' }])).toThrow(ConfigError);
    });

    it('should not mistake a non-capturing group for a capture group', () => {
        expect(() => findToolPins('x', [{ id: 'bad', pattern: '(?:HELM)=\\d+' }])).toThrow(
            ConfigError,
        );
    });

    it('should accept an escaped parenthesis without treating it as a group', () => {
        expect(() => findToolPins('x', [{ id: 'bad', pattern: '\\(HELM\\)=\\d+' }])).toThrow(
            ConfigError,
        );
    });
});

describe('ValuesDocument', () => {
    const VALUES = [
        'controller:',
        "    chartVersion: '0.10.1'",
        '    replicaCount: 1',
        '    image:',
        '        repository: ghcr.io/actions/gha-runner-scale-set-controller',
        "        tag: '0.10.1'",
        'cluster:',
        "    version: '1.31'",
        '    addons:',
        "        vpc-cni: 'v1.19.2-eksbuild.1'",
        "        coredns: 'v1.11.4-eksbuild.2'",
        'nodeGroups:',
        '    - name: runners-default',
        '      amiVersion: 1.31.0-20250101',
        '',
    ].join('\n');

    const document = () => new ValuesDocument(VALUES, 'values.yaml');

    describe('readString', () => {
        it('should read a nested value with its line [REQ-ARC-013]', () => {
            expect(document().readString('controller.chartVersion')).toEqual({
                path: 'controller.chartVersion',
                value: '0.10.1',
                line: 2,
                snippet: "chartVersion: '0.10.1'",
            });
        });

        it('should read a value two levels down', () => {
            expect(document().readString('controller.image.tag')?.line).toBe(6);
        });

        it('should address a list element by index', () => {
            expect(document().readString('nodeGroups.0.name')?.value).toBe('runners-default');
        });

        it('should render a value YAML parsed as a number back to its text', () => {
            // A collector compares and records what the file says, not what the parser
            // decided the type was.
            expect(document().readString('controller.replicaCount')?.value).toBe('1');
        });

        it.each([
            ['an absent key', 'controller.missing'],
            ['a path through a scalar', 'controller.chartVersion.deeper'],
            ['a mapping rather than a scalar', 'controller.image'],
            ['an out-of-range index', 'nodeGroups.7.name'],
        ])('should return null for %s [REQ-ARC-015]', (_label: string, path: string) => {
            expect(document().readString(path)).toBeNull();
        });
    });

    describe('readMap', () => {
        it('should read every entry of a mapping with its own line', () => {
            expect(document().readMap('cluster.addons')).toEqual([
                {
                    path: 'cluster.addons.vpc-cni',
                    value: 'v1.19.2-eksbuild.1',
                    line: 10,
                    snippet: "vpc-cni: 'v1.19.2-eksbuild.1'",
                },
                {
                    path: 'cluster.addons.coredns',
                    value: 'v1.11.4-eksbuild.2',
                    line: 11,
                    snippet: "coredns: 'v1.11.4-eksbuild.2'",
                },
            ]);
        });

        it('should return null when the path is not a mapping', () => {
            expect(document().readMap('cluster.version')).toBeNull();
        });

        it('should skip an entry whose key is not a string', () => {
            const numeric = new ValuesDocument(
                ['addons:', "    1: 'v1'", "    coredns: 'v2'"].join('\n'),
                'values.yaml',
            );
            expect(numeric.readMap('addons')?.map((entry) => entry.value)).toEqual(['v2']);
        });

        it('should skip an entry whose value is not a scalar', () => {
            const nested = new ValuesDocument(
                ['addons:', '    vpc-cni:', '        version: 1', "    coredns: 'v1'"].join('\n'),
                'values.yaml',
            );
            expect(nested.readMap('addons')?.map((entry) => entry.value)).toEqual(['v1']);
        });
    });

    describe('has', () => {
        it('should report whether a path resolves at all', () => {
            expect(document().has('cluster.addons')).toBe(true);
            expect(document().has('cluster.missing')).toBe(false);
        });
    });

    describe('construction', () => {
        it('should reject a file that is not valid YAML naming it', () => {
            expect(() => new ValuesDocument('\ttabs: are invalid', 'values.yaml')).toThrow(
                ParseError,
            );
            expect(() => new ValuesDocument('\ttabs: are invalid', 'values.yaml')).toThrow(
                /values\.yaml/,
            );
        });

        it('should treat an explicitly null value as absent', () => {
            // `version:` with nothing after it is a declaration that says nothing, which
            // is not the same as a version the collector can compare.
            expect(new ValuesDocument('version:', 'v.yaml').readString('version')).toBeNull();
        });
    });
});
