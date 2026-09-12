import {
    collectorSettings,
    deriveStatus,
    runCollector,
    toCollectorError,
} from '../src/maintenance/collectors/collector';
import {
    Collector,
    CollectorContext,
    CollectorOutput,
    emptyOutput,
} from '../src/maintenance/types';
import { CollectorError, CollectorId, Finding } from '../src/maintenance/schema';
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
    it('should report ok when a collector produced no errors [REQ-ERR-035]', () => {
        expect(deriveStatus({ findings: [], errors: [] })).toBe('ok');
    });

    it('should report partial when there are both findings and errors [REQ-ERR-033]', () => {
        expect(deriveStatus({ findings: [{} as Finding], errors: [anError] })).toBe('partial');
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

        it('should count the unresolved findings separately', async () => {
            const collector = new StubCollector((ctx) => {
                const finding = anyFinding(ctx);
                return Promise.resolve({
                    findings: [finding, { ...finding, unresolved: true }],
                    errors: [],
                });
            });
            const { run } = await runCollector(collector, fakeContext({ config: NPM_CONFIG }));
            expect(run).toMatchObject({ findingCount: 2, unresolvedCount: 1 });
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
