import { GithubActionsCollector } from '../src/maintenance/collectors/github-actions';
import { CollectorContext } from '../src/maintenance/types';
import { Finding } from '../src/maintenance/schema';
import {
    fakeContext,
    fakeResolved,
    fakeUnresolved,
    FakeSourceRegistry,
    InMemoryFileProvider,
    RecordingLogger,
} from './support/maintenance-fakes';

const WORKFLOW = '.github/workflows/ci.yml';

const config = (overrides: Record<string, unknown> = {}) => ({
    version: 1,
    collectors: { githubActions: { workflows: [WORKFLOW], ...overrides } },
});

const workflow = (steps: string): string =>
    [
        'name: CI',
        'on: [push]',
        'jobs:',
        '  build:',
        '    runs-on: ubuntu-latest',
        '    steps:',
        steps,
    ].join('\n');

interface Harness {
    ctx: CollectorContext;
    sources: FakeSourceRegistry;
    logger: RecordingLogger;
}

function harness(
    files: Record<string, string>,
    answers: Record<string, ReturnType<typeof fakeResolved>> = {},
    configOverrides: Record<string, unknown> = {},
): Harness {
    const sources = new FakeSourceRegistry(answers);
    const logger = new RecordingLogger();
    return {
        sources,
        logger,
        ctx: fakeContext({
            config: config(configOverrides),
            files: new InMemoryFileProvider(files),
            sources,
            logger,
        }),
    };
}

const byKind = (findings: readonly Finding[], kind: string): Finding[] =>
    findings.filter((finding) => finding.kind === kind);

describe('GithubActionsCollector', () => {
    describe('isEnabled', () => {
        it('should run only when the configuration declares it [REQ-CFG-007]', () => {
            const collector = new GithubActionsCollector();
            expect(collector.isEnabled(fakeContext({ config: config() }).config)).toBe(true);
            expect(collector.isEnabled(fakeContext().config)).toBe(false);
        });
    });

    describe('unpinned actions', () => {
        it('should emit a finding for a mutable tag when SHA pinning is required [REQ-GHA-010]', async () => {
            const { ctx } = harness(
                { [WORKFLOW]: workflow('      - uses: actions/checkout@v4') },
                { 'github-release:actions/checkout': fakeResolved('4.0.0') },
            );
            const findings = byKind(
                (await new GithubActionsCollector().collect(ctx)).findings,
                'action-unpinned',
            );
            expect(findings).toHaveLength(1);
            expect(findings[0]).toMatchObject({
                id: 'github-actions/action-unpinned/actions-checkout',
                subject: { id: 'actions/checkout', scope: 'build' },
                versions: { declared: 'v4' },
            });
        });

        it('should score a third-party mutable tag above a first-party one [REQ-SEV-056]', async () => {
            const { ctx } = harness(
                {
                    [WORKFLOW]: workflow(
                        [
                            '      - uses: actions/checkout@v4',
                            '      - uses: some-vendor/deploy@v1',
                        ].join('\n'),
                    ),
                },
                {
                    'github-release:actions/checkout': fakeResolved('4.0.0'),
                    'github-release:some-vendor/deploy': fakeResolved('1.0.0'),
                },
            );
            const findings = byKind(
                (await new GithubActionsCollector().collect(ctx)).findings,
                'action-unpinned',
            );
            expect(findings.map((f) => [f.subject.id, f.severity.severity])).toEqual([
                ['actions/checkout', 'low'],
                ['some-vendor/deploy', 'high'],
            ]);
        });

        it('should treat a reference with no ref at all as unpinned', async () => {
            const { ctx } = harness(
                { [WORKFLOW]: workflow('      - uses: some-vendor/deploy') },
                { 'github-release:some-vendor/deploy': fakeResolved('1.0.0') },
            );
            const findings = byKind(
                (await new GithubActionsCollector().collect(ctx)).findings,
                'action-unpinned',
            );
            expect(findings).toHaveLength(1);
            expect(findings[0].detail).toContain('referenced by (no ref)');
        });

        it('should treat a branch ref as unpinned even when SHA pinning is off', async () => {
            const { ctx } = harness(
                { [WORKFLOW]: workflow('      - uses: some-vendor/deploy@main') },
                { 'github-release:some-vendor/deploy': fakeResolved('1.0.0') },
                { requireShaPins: false },
            );
            const findings = byKind(
                (await new GithubActionsCollector().collect(ctx)).findings,
                'action-unpinned',
            );
            expect(findings).toHaveLength(1);
        });

        it('should accept a version tag when SHA pinning is not required', async () => {
            const { ctx } = harness(
                { [WORKFLOW]: workflow('      - uses: actions/checkout@v4') },
                { 'github-release:actions/checkout': fakeResolved('4.0.0') },
                { requireShaPins: false },
            );
            const { findings } = await new GithubActionsCollector().collect(ctx);
            expect(byKind(findings, 'action-unpinned')).toEqual([]);
        });

        it('should not emit an unpinned finding for a SHA pin', async () => {
            const sha = 'a'.repeat(40);
            const { ctx } = harness(
                { [WORKFLOW]: workflow(`      - uses: actions/checkout@${sha} # v4.2.2`) },
                { 'github-release:actions/checkout': fakeResolved('4.2.2') },
            );
            const { findings } = await new GithubActionsCollector().collect(ctx);
            expect(byKind(findings, 'action-unpinned')).toEqual([]);
        });
    });

    describe('outdated actions', () => {
        it('should compare a major-only tag at major precision [REQ-GHA-017]', async () => {
            const { ctx } = harness(
                { [WORKFLOW]: workflow('      - uses: actions/checkout@v4') },
                { 'github-release:actions/checkout': fakeResolved('4.3.1') },
            );
            const { findings } = await new GithubActionsCollector().collect(ctx);
            // v4 already points at 4.3.1, so reporting drift here would be a false positive.
            expect(byKind(findings, 'action-outdated')).toEqual([]);
        });

        it('should report a major-only tag once the major has moved [REQ-SCH-009]', async () => {
            const { ctx } = harness(
                { [WORKFLOW]: workflow('      - uses: actions/checkout@v4') },
                { 'github-release:actions/checkout': fakeResolved('5.1.0') },
            );
            const findings = byKind(
                (await new GithubActionsCollector().collect(ctx)).findings,
                'action-outdated',
            );
            expect(findings).toHaveLength(1);
            expect(findings[0]).toMatchObject({
                versions: { declared: 'v4', observed: '4.0.0', latest: '5.1.0', bump: 'major' },
                severity: { severity: 'medium', ruleId: 'SEV-DRIFT-MAJOR' },
            });
        });

        it('should read the version of a SHA pin from its trailing comment [REQ-GHA-019]', async () => {
            const sha = 'b'.repeat(40);
            const { ctx } = harness(
                { [WORKFLOW]: workflow(`      - uses: actions/checkout@${sha} # v4.2.1`) },
                { 'github-release:actions/checkout': fakeResolved('4.2.2') },
            );
            const findings = byKind(
                (await new GithubActionsCollector().collect(ctx)).findings,
                'action-outdated',
            );
            expect(findings[0].versions).toMatchObject({
                declared: 'v4.2.1',
                observed: '4.2.1',
                bump: 'patch',
            });
        });

        it('should say so when a SHA pin carries no version comment [REQ-GHA-019]', async () => {
            const sha = 'c'.repeat(40);
            const { ctx } = harness(
                { [WORKFLOW]: workflow(`      - uses: actions/checkout@${sha}`) },
                { 'github-release:actions/checkout': fakeResolved('4.2.2') },
            );
            const findings = byKind(
                (await new GithubActionsCollector().collect(ctx)).findings,
                'action-outdated',
            );
            expect(findings[0].versions).toMatchObject({ observed: null, bump: 'unknown' });
            expect(findings[0].detail).toContain('no version comment');
        });

        it('should fall back to tags when the repository publishes no releases', async () => {
            const { ctx, sources } = harness(
                { [WORKFLOW]: workflow('      - uses: some-vendor/deploy@v1.0.0') },
                {
                    'github-release:some-vendor/deploy': fakeUnresolved('404 Not Found'),
                    'github-tag:some-vendor/deploy': fakeResolved('1.4.0', 'github-tag'),
                },
            );
            const findings = byKind(
                (await new GithubActionsCollector().collect(ctx)).findings,
                'action-outdated',
            );
            expect(sources.asked).toEqual([
                'github-release:some-vendor/deploy',
                'github-tag:some-vendor/deploy',
            ]);
            expect(findings[0].latestResolution).toMatchObject({
                method: 'github-tag',
                ref: 'github-tag:some-vendor/deploy',
            });
        });

        it('should compare a minor-precision tag at minor precision [REQ-GHA-017]', async () => {
            const { ctx } = harness(
                { [WORKFLOW]: workflow('      - uses: some-vendor/deploy@v1.2') },
                { 'github-release:some-vendor/deploy': fakeResolved('1.4.0') },
            );
            const findings = byKind(
                (await new GithubActionsCollector().collect(ctx)).findings,
                'action-outdated',
            );
            expect(findings[0].versions.bump).toBe('minor');
            expect(findings[0].detail).toContain('the whole minor line');
        });

        it('should stay readable when a source omits its reason', async () => {
            const { ctx } = harness(
                { [WORKFLOW]: workflow('      - uses: some-vendor/deploy@v1.0.0') },
                {
                    'github-release:some-vendor/deploy': {
                        ...fakeUnresolved('ignored'),
                        reason: null,
                    },
                    'github-tag:some-vendor/deploy': { ...fakeUnresolved('ignored'), reason: null },
                },
            );
            const findings = byKind(
                (await new GithubActionsCollector().collect(ctx)).findings,
                'action-outdated',
            );
            expect(findings[0].detail).toBe(
                'The latest version of some-vendor/deploy could not be established. ' +
                    'It is referenced in .github/workflows/ci.yml:7.',
            );
        });

        it('should emit an unresolved finding rather than omit it [REQ-GHA-015]', async () => {
            const { ctx } = harness(
                { [WORKFLOW]: workflow('      - uses: some-vendor/deploy@v1.0.0') },
                {
                    'github-release:some-vendor/deploy': fakeUnresolved('rate limited'),
                    'github-tag:some-vendor/deploy': fakeUnresolved('rate limited'),
                },
            );
            const findings = byKind(
                (await new GithubActionsCollector().collect(ctx)).findings,
                'action-outdated',
            );
            expect(findings).toHaveLength(1);
            expect(findings[0]).toMatchObject({
                unresolved: true,
                latestResolution: { status: 'unresolved', reason: 'rate limited' },
                severity: { ruleId: 'SEV-UNRESOLVED' },
            });
        });
    });

    describe('grouping and evidence', () => {
        it('should emit one finding per repository carrying every occurrence [REQ-GHA-018]', async () => {
            const { ctx } = harness(
                {
                    [WORKFLOW]: workflow(
                        [
                            '      - uses: actions/checkout@v4',
                            '      - uses: actions/checkout@v4',
                        ].join('\n'),
                    ),
                },
                { 'github-release:actions/checkout': fakeResolved('4.0.0') },
            );
            const findings = byKind(
                (await new GithubActionsCollector().collect(ctx)).findings,
                'action-unpinned',
            );
            expect(findings).toHaveLength(1);
            expect(findings[0].evidence).toHaveLength(2);
        });

        it('should give every finding in a run a distinct fingerprint [REQ-ID-001]', async () => {
            const { ctx } = harness(
                {
                    [WORKFLOW]: workflow(
                        [
                            '      - uses: actions/checkout@v3',
                            '      - uses: actions/checkout@v3',
                            '      - uses: some-vendor/deploy@main',
                        ].join('\n'),
                    ),
                },
                {
                    'github-release:actions/checkout': fakeResolved('4.3.1'),
                    'github-release:some-vendor/deploy': fakeResolved('1.0.0'),
                },
            );
            const { findings } = await new GithubActionsCollector().collect(ctx);
            expect(findings.length).toBeGreaterThan(1);
            expect(new Set(findings.map((f) => f.fingerprint)).size).toBe(findings.length);
        });

        it('should report the line and column of each reference [REQ-GHA-011]', async () => {
            const { ctx } = harness(
                { [WORKFLOW]: workflow('      - uses: actions/checkout@v4') },
                { 'github-release:actions/checkout': fakeResolved('4.0.0') },
            );
            const findings = byKind(
                (await new GithubActionsCollector().collect(ctx)).findings,
                'action-unpinned',
            );
            expect(findings[0].evidence[0]).toMatchObject({
                type: 'file',
                path: WORKFLOW,
                line: 7,
                snippet: '- uses: actions/checkout@v4',
            });
        });

        it('should report the oldest reference when pins disagree', async () => {
            const { ctx } = harness(
                {
                    [WORKFLOW]: workflow(
                        [
                            '      - uses: actions/checkout@v4.2.2',
                            '      - uses: actions/checkout@v4.1.0',
                        ].join('\n'),
                    ),
                },
                { 'github-release:actions/checkout': fakeResolved('4.3.0') },
            );
            const findings = byKind(
                (await new GithubActionsCollector().collect(ctx)).findings,
                'action-outdated',
            );
            expect(findings[0].versions.observed).toBe('4.1.0');
            expect(findings[0].detail).toContain('References disagree: v4.2.2, v4.1.0');
        });

        it('should prefer a comparable reference over one with no discoverable version', async () => {
            const sha = 'd'.repeat(40);
            const { ctx } = harness(
                {
                    [WORKFLOW]: workflow(
                        [
                            `      - uses: actions/checkout@${sha}`,
                            '      - uses: actions/checkout@v4.1.0',
                        ].join('\n'),
                    ),
                },
                { 'github-release:actions/checkout': fakeResolved('4.3.0') },
            );
            const findings = byKind(
                (await new GithubActionsCollector().collect(ctx)).findings,
                'action-outdated',
            );
            expect(findings[0].versions.observed).toBe('4.1.0');
        });

        it('should fall back to an incomparable reference when none can be compared', async () => {
            const { ctx } = harness(
                {
                    [WORKFLOW]: workflow(
                        [
                            `      - uses: actions/checkout@${'e'.repeat(40)}`,
                            `      - uses: actions/checkout@${'f'.repeat(40)}`,
                        ].join('\n'),
                    ),
                },
                { 'github-release:actions/checkout': fakeResolved('4.3.0') },
            );
            const findings = byKind(
                (await new GithubActionsCollector().collect(ctx)).findings,
                'action-outdated',
            );
            expect(findings[0].versions).toMatchObject({ observed: null, bump: 'unknown' });
        });

        it('should resolve a subdirectory reference against its repository [REQ-GHA-013]', async () => {
            const { ctx, sources } = harness(
                { [WORKFLOW]: workflow('      - uses: actions/cache/restore@v4.0.0') },
                { 'github-release:actions/cache': fakeResolved('4.2.0') },
            );
            const findings = byKind(
                (await new GithubActionsCollector().collect(ctx)).findings,
                'action-outdated',
            );
            expect(sources.asked).toEqual(['github-release:actions/cache']);
            expect(findings[0].subject.id).toBe('actions/cache');
        });

        it('should examine a reusable workflow reference [REQ-GHA-012]', async () => {
            const { ctx } = harness(
                {
                    [WORKFLOW]: [
                        'name: CI',
                        'on: [push]',
                        'jobs:',
                        '  call:',
                        '    uses: some-vendor/workflows/.github/workflows/build.yml@v1.0.0',
                    ].join('\n'),
                },
                { 'github-release:some-vendor/workflows': fakeResolved('1.2.0') },
            );
            const findings = byKind(
                (await new GithubActionsCollector().collect(ctx)).findings,
                'action-outdated',
            );
            expect(findings[0].subject.id).toBe('some-vendor/workflows');
        });
    });

    describe('exclusions', () => {
        it('should skip a local action without a finding or an error [REQ-GHA-014]', async () => {
            const { ctx, logger } = harness({
                [WORKFLOW]: workflow('      - uses: ./.github/actions/setup'),
            });
            const output = await new GithubActionsCollector().collect(ctx);
            expect(output).toEqual({ findings: [], errors: [] });
            expect(logger.at('debug')[0]).toContain('local-path');
        });

        it('should leave a docker:// reference to the images collector', async () => {
            const { ctx, logger } = harness({
                [WORKFLOW]: workflow('      - uses: docker://alpine:3.20'),
            });
            const output = await new GithubActionsCollector().collect(ctx);
            expect(output.findings).toEqual([]);
            expect(logger.at('debug')[0]).toContain('docker-image');
        });

        it('should honour the configured ignore list', async () => {
            const { ctx } = harness(
                { [WORKFLOW]: workflow('      - uses: actions/checkout@v4') },
                {},
                { ignore: ['actions/checkout'] },
            );
            expect((await new GithubActionsCollector().collect(ctx)).findings).toEqual([]);
        });
    });

    describe('failure handling', () => {
        it('should record a parse error and continue with the other files [REQ-GHA-016]', async () => {
            const { ctx } = harness(
                {
                    [WORKFLOW]: '\tname: tabs are not valid YAML indentation',
                    '.github/workflows/other.yml': workflow('      - uses: actions/checkout@v4'),
                },
                { 'github-release:actions/checkout': fakeResolved('4.0.0') },
                { workflows: [WORKFLOW, '.github/workflows/other.yml'] },
            );
            const { findings, errors } = await new GithubActionsCollector().collect(ctx);
            expect(errors).toHaveLength(1);
            expect(errors[0]).toMatchObject({ code: 'parse-error', target: WORKFLOW });
            expect(findings.length).toBeGreaterThan(0);
        });

        it('should record a missing workflow rather than abandoning the run', async () => {
            const { ctx } = harness({});
            const { errors } = await new GithubActionsCollector().collect(ctx);
            expect(errors).toEqual([
                {
                    code: 'not-found',
                    message: `File not found: ${WORKFLOW}`,
                    target: WORKFLOW,
                    retryable: false,
                },
            ]);
        });
    });
});
