import {
    collectorSettings,
    deriveStatus,
    runCollector,
    toCollectorError,
} from '../src/maintenance/collectors/collector';
import {
    assertDistinctFingerprints,
    runCollectors,
    sortFindings,
    summarise,
    worstStatus,
} from '../src/maintenance/runner';
import { MaintenanceConfigSchema } from '../src/maintenance/schema/config';
import {
    Collector,
    CollectorContext,
    CollectorOutput,
    emptyOutput,
} from '../src/maintenance/types';
import {
    CollectorError,
    CollectorId,
    CollectorRun,
    Finding,
    MaintenanceReport,
    MaintenanceReportSchema,
} from '../src/maintenance/schema';
import { InternalError, NetworkError, ParseError } from '../src/maintenance/errors';
import { FixedClock } from '../src/maintenance/clock';
import { buildFinding, notApplicableResolution } from '../src/maintenance/collectors/build-finding';
import { fakeContext, RecordingLogger } from './support/maintenance-fakes';

const NPM_CONFIG = { version: 1, collectors: { npm: { enabled: true } } };

/** A collector whose behaviour the spec dictates outright. */
class StubCollector implements Collector {
    public readonly id: CollectorId = 'npm';
    public calls = 0;

    constructor(private readonly behaviour: (ctx: CollectorContext) => Promise<CollectorOutput>) {}

    public isEnabled(): boolean {
        return true;
    }

    public collect(ctx: CollectorContext): Promise<CollectorOutput> {
        this.calls += 1;
        return this.behaviour(ctx);
    }
}

const anyFinding = (ctx: CollectorContext): Finding =>
    buildFinding(
        {
            collector: 'npm',
            kind: 'dependency-outdated',
            subject: {
                kind: 'npm-package',
                id: 'typescript',
                displayName: 'typescript',
                ecosystem: 'npm',
                scope: 'dev',
            },
            title: 'typescript is behind',
            detail: 'typescript is behind its latest release.',
            declared: '^5.7.3',
            observed: null,
            latest: notApplicableResolution('static-config', 'fixed for the test'),
            evidence: [
                {
                    type: 'file',
                    path: 'package.json',
                    line: 1,
                    column: null,
                    snippet: null,
                    contentSha256: null,
                    repo: null,
                    ref: null,
                },
            ],
        },
        ctx,
    );

const anError: CollectorError = {
    code: 'network',
    message: 'registry.npmjs.org is unreachable',
    target: 'npm:typescript',
    retryable: true,
};

describe('deriveStatus', () => {
    const resolved = { unresolved: false } as Finding;
    const unresolved = { unresolved: true } as Finding;

    it('should report ok when nothing was degraded [REQ-ERR-035]', () => {
        expect(deriveStatus({ findings: [resolved], errors: [] })).toBe('ok');
        expect(deriveStatus({ findings: [], errors: [] })).toBe('ok');
    });

    it('should report partial when there are both findings and errors [REQ-ERR-033]', () => {
        expect(deriveStatus({ findings: [resolved], errors: [anError] })).toBe('partial');
    });

    it('should report partial when a finding is unresolved but nothing errored [REQ-ERR-038]', () => {
        // Offline, or a token-less run against a rate-limited GitHub: every lookup fails
        // without a single collector-level error. `ok` there would put "worst run ok" at
        // the top of a report that established nothing.
        expect(deriveStatus({ findings: [resolved, unresolved], errors: [] })).toBe('partial');
    });

    it('should report failed when there are errors and nothing to show [REQ-ERR-034]', () => {
        expect(deriveStatus({ findings: [], errors: [anError] })).toBe('failed');
    });
});

describe('toCollectorError', () => {
    it('should carry the code, target and retryability of the failure [REQ-ERR-036]', () => {
        const error = new NetworkError('unreachable', { target: 'npm:typescript' });
        expect(toCollectorError(error)).toEqual({
            code: 'network',
            message: 'unreachable',
            target: 'npm:typescript',
            retryable: true,
        });
    });

    it('should mark a parse failure as not worth retrying [REQ-ERR-032]', () => {
        expect(toCollectorError(new ParseError('bad json')).retryable).toBe(false);
    });
});

describe('collectorSettings', () => {
    it('should return the configured block for an admitted collector', () => {
        const ctx = fakeContext({ config: NPM_CONFIG });
        expect(collectorSettings(ctx.config, 'npm').manifest).toBe('package.json');
    });

    it('should treat an absent block as an invariant violation', () => {
        const ctx = fakeContext();
        expect(() => collectorSettings(ctx.config, 'npm')).toThrow(InternalError);
    });
});

describe('runCollector', () => {
    describe('status derivation', () => {
        it('should record ok and the findings a collector returned [REQ-ERR-035]', async () => {
            const collector = new StubCollector((ctx) =>
                Promise.resolve({ findings: [anyFinding(ctx)], errors: [] }),
            );
            const { run, findings } = await runCollector(
                collector,
                fakeContext({ config: NPM_CONFIG }),
            );
            expect(run).toMatchObject({
                collector: 'npm',
                status: 'ok',
                findingCount: 1,
                unresolvedCount: 0,
                errors: [],
                skippedReason: null,
            });
            expect(findings).toHaveLength(1);
        });

        it('should record partial when a collector reports errors alongside findings [REQ-ERR-033]', async () => {
            const collector = new StubCollector((ctx) =>
                Promise.resolve({ findings: [anyFinding(ctx)], errors: [anError] }),
            );
            const { run } = await runCollector(collector, fakeContext({ config: NPM_CONFIG }));
            expect(run.status).toBe('partial');
            expect(run.errors).toEqual([anError]);
        });

        it('should record failed when a collector reports errors and nothing else [REQ-ERR-034]', async () => {
            const collector = new StubCollector(() =>
                Promise.resolve({ findings: [], errors: [anError] }),
            );
            const { run } = await runCollector(collector, fakeContext({ config: NPM_CONFIG }));
            expect(run.status).toBe('failed');
        });

        it('should count the unresolved findings separately [REQ-ERR-038]', async () => {
            const collector = new StubCollector((ctx) => {
                const finding = anyFinding(ctx);
                return Promise.resolve({
                    findings: [finding, { ...finding, unresolved: true }],
                    errors: [],
                });
            });
            const { run } = await runCollector(collector, fakeContext({ config: NPM_CONFIG }));
            expect(run).toMatchObject({ findingCount: 2, unresolvedCount: 1, status: 'partial' });
        });
    });

    describe('skipping [REQ-CFG-007]', () => {
        it('should skip a collector the configuration does not mention', async () => {
            const collector = new StubCollector(() => Promise.resolve(emptyOutput()));
            const { run, findings } = await runCollector(collector, fakeContext());
            expect(run.status).toBe('skipped');
            expect(run.skippedReason).toBe('collectors.npm is not present in the configuration.');
            expect(findings).toEqual([]);
            expect(collector.calls).toBe(0);
        });

        it('should skip a configured collector that is disabled', async () => {
            const collector = new StubCollector(() => Promise.resolve(emptyOutput()));
            collector.isEnabled = () => false;
            const { run } = await runCollector(
                collector,
                fakeContext({ config: { version: 1, collectors: { npm: { enabled: false } } } }),
            );
            expect(run.skippedReason).toBe('collectors.npm.enabled is false.');
            expect(collector.calls).toBe(0);
        });

        it('should distinguish a caller-requested skip from a configuration one', async () => {
            const collector = new StubCollector(() => Promise.resolve(emptyOutput()));
            const { run } = await runCollector(collector, fakeContext({ config: NPM_CONFIG }), {
                skipReason: 'Not selected by --collectors.',
            });
            expect(run.status).toBe('skipped');
            expect(run.skippedReason).toBe('Not selected by --collectors.');
            expect(collector.calls).toBe(0);
        });

        it('should map a hyphenated collector id onto its configuration key', async () => {
            const collector = new StubCollector(() => Promise.resolve(emptyOutput()));
            Object.defineProperty(collector, 'id', { value: 'github-actions' });
            const { run } = await runCollector(collector, fakeContext());
            expect(run.skippedReason).toBe(
                'collectors.githubActions is not present in the configuration.',
            );
        });
    });

    describe('a collector that throws [REQ-ERR-031]', () => {
        it('should record failed and emit exactly one synthetic finding', async () => {
            const collector = new StubCollector(() =>
                Promise.reject(new NetworkError('registry unreachable', { target: 'npm' })),
            );
            const { run, findings } = await runCollector(
                collector,
                fakeContext({ config: NPM_CONFIG }),
            );
            expect(run.status).toBe('failed');
            expect(findings).toHaveLength(1);
            expect(findings[0]).toMatchObject({
                kind: 'upstream-unresolved',
                collector: 'npm',
                unresolved: true,
                subject: { kind: 'collector', id: 'npm' },
            });
            expect(run.errors).toEqual([
                {
                    code: 'network',
                    message: 'registry unreachable',
                    target: 'npm',
                    retryable: true,
                },
            ]);
        });

        it('should point the synthetic finding at the configuration that declared the run', async () => {
            const collector = new StubCollector(() => Promise.reject(new Error('boom')));
            const { findings } = await runCollector(
                collector,
                fakeContext({ config: NPM_CONFIG, configPath: 'custom.yaml' }),
            );
            expect(findings[0].evidence).toEqual([
                {
                    type: 'file',
                    path: 'custom.yaml',
                    line: null,
                    column: null,
                    snippet: null,
                    contentSha256: null,
                    repo: null,
                    ref: null,
                },
            ]);
        });

        it('should score the synthetic finding info rather than claim an impact', async () => {
            const collector = new StubCollector(() => Promise.reject(new Error('boom')));
            const { findings } = await runCollector(collector, fakeContext({ config: NPM_CONFIG }));
            expect(findings[0].severity).toMatchObject({
                severity: 'info',
                ruleId: 'SEV-UNRESOLVED',
            });
        });

        it('should classify a thrown non-maintenance value rather than let it escape', async () => {
            const collector = new StubCollector(() => Promise.reject('a bare string'));
            const { run } = await runCollector(collector, fakeContext({ config: NPM_CONFIG }));
            expect(run.errors[0]).toMatchObject({ code: 'internal', message: 'a bare string' });
        });

        it('should suggest a re-run only when the failure was transient', async () => {
            const transient = new StubCollector(() => Promise.reject(new NetworkError('down')));
            const permanent = new StubCollector(() => Promise.reject(new ParseError('bad json')));
            const ctx = fakeContext({ config: NPM_CONFIG });
            expect((await runCollector(transient, ctx)).findings[0].remediationHint).toContain(
                'Re-run the scan',
            );
            expect((await runCollector(permanent, ctx)).findings[0].remediationHint).toBeNull();
        });

        it('should report the failure through the injected logger, never the console', async () => {
            const logger = new RecordingLogger();
            const collector = new StubCollector(() => Promise.reject(new Error('boom')));
            await runCollector(collector, fakeContext({ config: NPM_CONFIG, logger }));
            expect(logger.at('error')).toEqual(['The npm collector failed']);
        });
    });

    describe('timing [REQ-RPT-004]', () => {
        it('should measure duration from the injected clock', async () => {
            const clock = new FixedClock('2026-09-12T06:00:00.000Z');
            const collector = new StubCollector(() => {
                clock.advance(250);
                return Promise.resolve(emptyOutput());
            });
            const { run } = await runCollector(
                collector,
                fakeContext({ config: NPM_CONFIG, clock }),
            );
            expect(run.startedAt).toBe('2026-09-12T06:00:00.000Z');
            expect(run.durationMs).toBe(250);
        });
    });
});

describe('sortFindings [REQ-RPT-002]', () => {
    const finding = (severity: string, collector: string, id: string): Finding =>
        ({ severity: { severity }, collector, id }) as Finding;

    it('should order by descending severity first', () => {
        const sorted = sortFindings([
            finding('low', 'npm', 'a'),
            finding('critical', 'npm', 'b'),
            finding('medium', 'npm', 'c'),
        ]);
        expect(sorted.map((f) => f.id)).toEqual(['b', 'c', 'a']);
    });

    it('should break ties on collector then id', () => {
        const sorted = sortFindings([
            finding('high', 'npm', 'z'),
            finding('high', 'arc', 'b'),
            finding('high', 'npm', 'a'),
            finding('high', 'arc', 'a'),
        ]);
        expect(sorted.map((f) => `${f.collector}/${f.id}`)).toEqual([
            'arc/a',
            'arc/b',
            'npm/a',
            'npm/z',
        ]);
    });

    it('should not mutate the array it was given', () => {
        const input = [finding('low', 'npm', 'a'), finding('critical', 'npm', 'b')];
        sortFindings(input);
        expect(input.map((f) => f.id)).toEqual(['a', 'b']);
    });

    it('should produce the same order whatever order it receives', () => {
        const findings = [
            finding('low', 'npm', 'a'),
            finding('critical', 'images', 'b'),
            finding('critical', 'arc', 'c'),
        ];
        expect(sortFindings(findings).map((f) => f.id)).toEqual(
            sortFindings([...findings].reverse()).map((f) => f.id),
        );
    });
});

describe('summarise [REQ-RPT-003]', () => {
    const finding = (severity: string, collector: string, unresolved = false): Finding =>
        ({ severity: { severity }, collector, unresolved }) as Finding;

    it('should count every severity and every collector, including the empty ones', () => {
        const summary = summarise(
            [finding('critical', 'npm'), finding('low', 'npm'), finding('low', 'images', true)],
            [],
        );
        expect(summary).toEqual({
            totalFindings: 3,
            bySeverity: { critical: 1, high: 0, medium: 0, low: 2, info: 0 },
            byCollector: { npm: 2, 'github-actions': 0, arc: 0, eks: 0, images: 1 },
            unresolvedCount: 1,
            worstStatus: 'skipped',
        });
    });

    it('should agree with the findings array it was given', () => {
        const findings = [finding('high', 'arc'), finding('info', 'eks', true)];
        const summary = summarise(findings, []);
        const counted = Object.values(summary.bySeverity).reduce((a, b) => a + b, 0);
        expect(summary.totalFindings).toBe(findings.length);
        expect(counted).toBe(findings.length);
    });
});

describe('worstStatus', () => {
    const run = (status: string): CollectorRun => ({ status }) as CollectorRun;

    it.each([
        [['ok', 'partial', 'failed'], 'failed'],
        [['ok', 'partial', 'skipped'], 'partial'],
        [['ok', 'skipped'], 'ok'],
        [['skipped'], 'skipped'],
    ])('should read %s as %s', (statuses: string[], expected: string) => {
        expect(worstStatus(statuses.map(run))).toBe(expected);
    });

    it('should not treat a skipped collector as a degraded run', () => {
        // A repository that configures two collectors and skips three has had the run it
        // asked for, not a bad one.
        expect(worstStatus([run('ok'), run('skipped'), run('skipped')])).toBe('ok');
    });
});

describe('assertDistinctFingerprints [REQ-ID-001]', () => {
    const finding = (id: string, fingerprint: string): Finding => ({ id, fingerprint }) as Finding;

    it('should accept findings with distinct fingerprints', () => {
        expect(() =>
            assertDistinctFingerprints([
                finding('a', '1'.repeat(32)),
                finding('b', '2'.repeat(32)),
            ]),
        ).not.toThrow();
    });

    it('should refuse two findings sharing a fingerprint, naming both', () => {
        // The publish stage matches an open issue by fingerprint, so a duplicate means
        // one issue for two problems, or the same issue rewritten twice per run.
        expect(() =>
            assertDistinctFingerprints([
                finding('a', '1'.repeat(32)),
                finding('b', '1'.repeat(32)),
            ]),
        ).toThrow(/a and b/);
    });
});

describe('runCollectors', () => {
    const loaded = {
        config: MaintenanceConfigSchema.parse({ version: 1, collectors: { npm: {} } }),
        path: 'maintenance.config.yaml',
        sha256: 'a'.repeat(64),
    };

    const environment = {
        repository: { name: 'typescript-starter', owner: null, commitSha: null, ref: null },
        runtime: { node: 'v22.0.0', npm: null, platform: 'linux-x64', offline: false },
    };

    const run = (collectors: Collector[], selected?: CollectorId[], clock = new FixedClock()) =>
        runCollectors({
            collectors,
            context: fakeContext({ config: loaded.config, clock }),
            config: loaded,
            environment,
            selected,
        });

    const stub = (
        id: CollectorId,
        behaviour: (ctx: CollectorContext) => Promise<CollectorOutput>,
    ) => {
        const collector = new StubCollector(behaviour);
        Object.defineProperty(collector, 'id', { value: id });
        return collector;
    };

    it('should record a run for every collector, including skipped ones [REQ-RPT-001]', async () => {
        const report = await run([
            stub('npm', (ctx) => Promise.resolve({ findings: [anyFinding(ctx)], errors: [] })),
            stub('arc', () => Promise.resolve(emptyOutput())),
        ]);
        expect(report.collectorRuns.map((r) => `${r.collector}=${r.status}`)).toEqual([
            'npm=ok',
            'arc=skipped',
        ]);
    });

    it('should record an unselected collector as skipped with a reason [REQ-CLI-006]', async () => {
        const report = await run(
            [
                stub('npm', (ctx) => Promise.resolve({ findings: [anyFinding(ctx)], errors: [] })),
                stub('images', () => Promise.resolve(emptyOutput())),
            ],
            ['npm'],
        );
        const images = report.collectorRuns.find((r) => r.collector === 'images');
        expect(images).toMatchObject({
            status: 'skipped',
            skippedReason: 'Not selected: this run was limited to npm.',
        });
    });

    it('should produce a report that satisfies the published contract [REQ-RPT-007]', async () => {
        const report = await run([
            stub('npm', (ctx) => Promise.resolve({ findings: [anyFinding(ctx)], errors: [] })),
        ]);
        expect(MaintenanceReportSchema.safeParse(report).success).toBe(true);
        expect(report).toMatchObject({
            schemaVersion: '1.0.0',
            stage: 'collect',
            config: { path: 'maintenance.config.yaml', version: 1 },
        });
    });

    it('should differ between two runs over unchanged inputs only by timestamp [REQ-RPT-004]', async () => {
        const collectors = () => [
            stub('npm', (ctx) => Promise.resolve({ findings: [anyFinding(ctx)], errors: [] })),
        ];
        const first = await run(
            collectors(),
            undefined,
            new FixedClock('2026-09-12T06:00:00.000Z'),
        );
        const second = await run(
            collectors(),
            undefined,
            new FixedClock('2026-09-13T06:00:00.000Z'),
        );
        expect(second.generatedAt).not.toBe(first.generatedAt);
        expect(withoutTimestamps(second)).toEqual(withoutTimestamps(first));
    });

    it('should refuse to assemble a report with duplicate fingerprints', async () => {
        const collector = stub('npm', (ctx) => {
            const finding = anyFinding(ctx);
            return Promise.resolve({ findings: [finding, { ...finding }], errors: [] });
        });
        await expect(run([collector])).rejects.toThrow(InternalError);
    });

    it('should keep going after a collector fails and still assemble a report [REQ-ERR-037]', async () => {
        const report = await run([
            stub('npm', () => Promise.reject(new NetworkError('registry unreachable'))),
            stub('arc', (ctx) => Promise.resolve({ findings: [anyFinding(ctx)], errors: [] })),
        ]);
        expect(report.collectorRuns.map((r) => `${r.collector}=${r.status}`)).toEqual([
            'npm=failed',
            'arc=skipped',
        ]);
        // The failed collector still contributes its synthetic finding, so the surface it
        // covers does not silently read as healthy.
        expect(report.findings.map((f) => f.kind)).toEqual(['upstream-unresolved']);
        expect(report.summary.worstStatus).toBe('failed');
    });

    it('should refuse an invalid report rather than write one [REQ-RPT-007]', async () => {
        await expect(
            runCollectors({
                collectors: [stub('npm', () => Promise.resolve(emptyOutput()))],
                context: fakeContext({ config: loaded.config }),
                config: loaded,
                // An empty node version cannot satisfy the contract; a report that does
                // not validate must never reach the pass-2 stage.
                environment: { ...environment, runtime: { ...environment.runtime, node: '' } },
            }),
        ).rejects.toThrow(/runtime\.node/);
    });

    it('should carry the environment and config digest through to the report [REQ-RPT-006]', async () => {
        const report = await run([stub('npm', () => Promise.resolve(emptyOutput()))]);
        expect(report.runtime).toEqual(environment.runtime);
        expect(report.config.sha256).toBe(loaded.sha256);
    });
});

/** Strip the two fields a second run is allowed to differ in. */
function withoutTimestamps(report: MaintenanceReport): unknown {
    return {
        ...report,
        generatedAt: null,
        collectorRuns: report.collectorRuns.map((run) => ({ ...run, startedAt: null })),
    };
}
