import { ArcCollector } from '../src/maintenance/collectors/arc';
import { CollectorContext } from '../src/maintenance/types';
import { Finding } from '../src/maintenance/schema';
import {
    fakeContext,
    fakeResolved,
    fakeUnresolved,
    FakeSourceRegistry,
    InMemoryFileProvider,
} from './support/maintenance-fakes';

const CONTROLLER_FILE = 'infra/arc/controller.values.yaml';
const SCALE_SET_FILE = 'infra/arc/scale-set.values.yaml';
const CONTROLLER_CHART =
    'helm:ghcr.io/actions/actions-runner-controller-charts/gha-runner-scale-set-controller';
const SCALE_SET_CHART =
    'helm:ghcr.io/actions/actions-runner-controller-charts/gha-runner-scale-set';
const RUNNER_IMAGE = 'oci:ghcr.io/actions/actions-runner';

const controllerValues = (version: string) =>
    ['controller:', `    chartVersion: '${version}'`, '    replicaCount: 1'].join('\n');

const scaleSetValues = (version: string, image = 'ghcr.io/actions/actions-runner:2.321.0') =>
    [
        'scaleSet:',
        `    chartVersion: '${version}'`,
        '    minRunners: 0',
        '    runner:',
        `        image: ${image}`,
    ].join('\n');

const config = (overrides: Record<string, unknown> = {}) => ({
    version: 1,
    collectors: {
        arc: {
            chart: {
                valuesFile: CONTROLLER_FILE,
                versionPath: 'controller.chartVersion',
                source: CONTROLLER_CHART,
            },
            runnerScaleSet: {
                valuesFile: SCALE_SET_FILE,
                versionPath: 'scaleSet.chartVersion',
                source: SCALE_SET_CHART,
            },
            runnerImage: {
                valuesFile: SCALE_SET_FILE,
                imagePath: 'scaleSet.runner.image',
                source: RUNNER_IMAGE,
                tagPattern: '^\\d+\\.\\d+\\.\\d+$',
            },
            ...overrides,
        },
    },
});

const CURRENT = {
    [CONTROLLER_CHART]: fakeResolved('0.10.1', 'helm-oci'),
    [SCALE_SET_CHART]: fakeResolved('0.10.1', 'helm-oci'),
    [RUNNER_IMAGE]: fakeResolved('2.321.0', 'oci-registry'),
};

interface Harness {
    ctx: CollectorContext;
    sources: FakeSourceRegistry;
}

function harness(
    files: Record<string, string>,
    answers: Record<string, ReturnType<typeof fakeResolved>> = CURRENT,
    overrides: Record<string, unknown> = {},
): Harness {
    const sources = new FakeSourceRegistry(answers);
    return {
        sources,
        ctx: fakeContext({
            config: config(overrides),
            files: new InMemoryFileProvider(files),
            sources,
        }),
    };
}

const inSync = (controller = '0.10.1', scaleSet = controller) => ({
    [CONTROLLER_FILE]: controllerValues(controller),
    [SCALE_SET_FILE]: scaleSetValues(scaleSet),
});

const byKind = (findings: readonly Finding[], kind: string): Finding[] =>
    findings.filter((finding) => finding.kind === kind);

describe('ArcCollector', () => {
    describe('isEnabled', () => {
        it('should run only when the configuration declares it [REQ-CFG-007]', () => {
            const collector = new ArcCollector();
            expect(collector.isEnabled(fakeContext({ config: config() }).config)).toBe(true);
            expect(collector.isEnabled(fakeContext().config)).toBe(false);
        });
    });

    describe('chart versions [REQ-ARC-010]', () => {
        it('should read both charts from their declared values files', async () => {
            const { ctx, sources } = harness(inSync(), {
                ...CURRENT,
                [CONTROLLER_CHART]: fakeResolved('0.14.2', 'helm-oci'),
                [SCALE_SET_CHART]: fakeResolved('0.14.2', 'helm-oci'),
            });
            const { findings } = await new ArcCollector().collect(ctx);
            expect(sources.asked).toEqual(
                expect.arrayContaining([CONTROLLER_CHART, SCALE_SET_CHART]),
            );
            expect(findings.map((f) => f.kind).sort()).toEqual([
                'chart-outdated',
                'controller-outdated',
            ]);
        });

        it('should resolve chart versions from the OCI chart repositories [REQ-ARC-011]', async () => {
            const { ctx } = harness(inSync(), {
                ...CURRENT,
                [CONTROLLER_CHART]: fakeResolved('0.14.2', 'helm-oci'),
            });
            const findings = byKind(
                (await new ArcCollector().collect(ctx)).findings,
                'controller-outdated',
            );
            expect(findings[0].latestResolution).toMatchObject({
                method: 'helm-oci',
                ref: CONTROLLER_CHART,
                confidence: 'high',
            });
        });

        it('should treat a pre-1.0 minor as the breaking channel it is', async () => {
            const { ctx } = harness(inSync(), {
                ...CURRENT,
                [CONTROLLER_CHART]: fakeResolved('0.14.2', 'helm-oci'),
            });
            const findings = byKind(
                (await new ArcCollector().collect(ctx)).findings,
                'controller-outdated',
            );
            expect(findings[0].severity).toMatchObject({
                severity: 'medium',
                ruleId: 'SEV-DRIFT-ZEROMAJOR',
            });
        });

        it('should report the line each version sits on [REQ-ARC-013]', async () => {
            const { ctx } = harness(inSync(), {
                ...CURRENT,
                [CONTROLLER_CHART]: fakeResolved('0.14.2', 'helm-oci'),
            });
            const findings = byKind(
                (await new ArcCollector().collect(ctx)).findings,
                'controller-outdated',
            );
            expect(findings[0].evidence[0]).toMatchObject({
                type: 'file',
                path: CONTROLLER_FILE,
                line: 2,
                snippet: "chartVersion: '0.10.1'",
            });
        });

        it('should emit nothing when both charts are current [REQ-SCH-009]', async () => {
            const { ctx } = harness(inSync());
            expect((await new ArcCollector().collect(ctx)).findings).toEqual([]);
        });

        it('should emit an unresolved finding rather than report no drift [REQ-ERR-030]', async () => {
            const { ctx } = harness(inSync(), {
                ...CURRENT,
                [CONTROLLER_CHART]: fakeUnresolved('ghcr.io token exchange failed', 'helm-oci'),
            });
            const findings = byKind(
                (await new ArcCollector().collect(ctx)).findings,
                'controller-outdated',
            );
            expect(findings[0]).toMatchObject({
                unresolved: true,
                severity: { ruleId: 'SEV-UNRESOLVED' },
            });
            expect(findings[0].detail).toContain('ghcr.io token exchange failed');
        });
    });

    describe('version skew [REQ-ARC-012]', () => {
        it('should emit a finding naming both versions when they differ', async () => {
            const { ctx } = harness(inSync('0.10.1', '0.9.3'));
            const findings = (await new ArcCollector().collect(ctx)).findings.filter(
                (finding) => finding.discriminator === 'version-skew',
            );
            expect(findings).toHaveLength(1);
            expect(findings[0]).toMatchObject({
                kind: 'chart-outdated',
                id: 'arc/chart-outdated/gha-runner-scale-set-controller/version-skew',
                versions: { declared: '0.10.1 / 0.9.3' },
            });
            expect(findings[0].title).toContain('0.10.1');
            expect(findings[0].title).toContain('0.9.3');
        });

        it('should carry both declarations as evidence', async () => {
            const { ctx } = harness(inSync('0.10.1', '0.9.3'));
            const skew = (await new ArcCollector().collect(ctx)).findings.find(
                (finding) => finding.discriminator === 'version-skew',
            );
            expect(skew?.evidence.map((e) => (e.type === 'file' ? e.path : null))).toEqual([
                CONTROLLER_FILE,
                SCALE_SET_FILE,
            ]);
        });

        it('should be separate from drift, so both can be reported at once', async () => {
            const { ctx } = harness(inSync('0.10.1', '0.9.3'), {
                ...CURRENT,
                [CONTROLLER_CHART]: fakeResolved('0.14.2', 'helm-oci'),
                [SCALE_SET_CHART]: fakeResolved('0.14.2', 'helm-oci'),
            });
            const { findings } = await new ArcCollector().collect(ctx);
            // Both charts behind and mismatched with each other: three separate pieces
            // of work, three distinct fingerprints.
            expect(findings).toHaveLength(3);
            expect(new Set(findings.map((f) => f.fingerprint)).size).toBe(3);
        });

        it('should stay quiet when the versions match', async () => {
            const { ctx } = harness(inSync('0.10.1', '0.10.1'));
            const skew = (await new ArcCollector().collect(ctx)).findings.find(
                (finding) => finding.discriminator === 'version-skew',
            );
            expect(skew).toBeUndefined();
        });

        it('should not check parity when the configuration turns it off', async () => {
            const { ctx } = harness(inSync('0.10.1', '0.9.3'), CURRENT, {
                requireChartVersionParity: false,
            });
            const skew = (await new ArcCollector().collect(ctx)).findings.find(
                (finding) => finding.discriminator === 'version-skew',
            );
            expect(skew).toBeUndefined();
        });

        it('should not claim skew when one of the versions could not be read', async () => {
            const { ctx } = harness({ [SCALE_SET_FILE]: scaleSetValues('0.9.3') });
            const skew = (await new ArcCollector().collect(ctx)).findings.find(
                (finding) => finding.discriminator === 'version-skew',
            );
            expect(skew).toBeUndefined();
        });
    });

    describe('the runner image', () => {
        it('should compare the declared tag against the published tags', async () => {
            const { ctx, sources } = harness(inSync(), {
                ...CURRENT,
                [RUNNER_IMAGE]: fakeResolved('2.331.0', 'oci-registry'),
            });
            const findings = byKind(
                (await new ArcCollector().collect(ctx)).findings,
                'image-base-outdated',
            );
            expect(findings).toHaveLength(1);
            expect(findings[0].versions).toMatchObject({
                declared: '2.321.0',
                latest: '2.331.0',
                bump: 'minor',
            });
            expect(sources.requests).toContainEqual({
                ref: RUNNER_IMAGE,
                options: { tagPattern: /^\d+\.\d+\.\d+$/ },
            });
        });

        it('should emit an unresolved finding when the registry cannot be reached', async () => {
            const { ctx } = harness(inSync(), {
                ...CURRENT,
                [RUNNER_IMAGE]: fakeUnresolved('ghcr.io returned 429', 'oci-registry'),
            });
            const findings = byKind(
                (await new ArcCollector().collect(ctx)).findings,
                'image-base-outdated',
            );
            expect(findings[0]).toMatchObject({
                unresolved: true,
                severity: { ruleId: 'SEV-UNRESOLVED' },
            });
            expect(findings[0].title).toContain('could not be checked');
            expect(findings[0].detail).toContain('ghcr.io returned 429');
            expect(findings[0].remediationHint).toBeNull();
        });

        it('should still report an untagged runner image', async () => {
            const { ctx } = harness(
                {
                    [CONTROLLER_FILE]: controllerValues('0.10.1'),
                    [SCALE_SET_FILE]: scaleSetValues('0.10.1', 'ghcr.io/actions/actions-runner'),
                },
                { ...CURRENT, [RUNNER_IMAGE]: fakeResolved('2.331.0', 'oci-registry') },
            );
            const findings = byKind(
                (await new ArcCollector().collect(ctx)).findings,
                'image-base-outdated',
            );
            // No tag means whatever `latest` points at today, which is drift nobody can
            // see in a diff.
            expect(findings[0].versions).toMatchObject({ declared: null, bump: 'unknown' });
            expect(findings[0].title).toContain('an untagged reference');
        });

        it('should not report a digest-pinned runner image as drift [REQ-IMG-017]', async () => {
            const { ctx } = harness({
                [CONTROLLER_FILE]: controllerValues('0.10.1'),
                [SCALE_SET_FILE]: scaleSetValues(
                    '0.10.1',
                    `ghcr.io/actions/actions-runner@sha256:${'a'.repeat(64)}`,
                ),
            });
            expect((await new ArcCollector().collect(ctx)).findings).toEqual([]);
        });

        it('should record an unresolvable image path and emit no image finding', async () => {
            const { ctx } = harness({
                [CONTROLLER_FILE]: controllerValues('0.10.1'),
                [SCALE_SET_FILE]: ['scaleSet:', "    chartVersion: '0.10.1'"].join('\n'),
            });
            const { errors, findings } = await new ArcCollector().collect(ctx);
            expect(errors).toEqual([
                {
                    code: 'config-error',
                    message: `${SCALE_SET_FILE} has no value at scaleSet.runner.image`,
                    target: `${SCALE_SET_FILE}#scaleSet.runner.image`,
                    retryable: false,
                },
            ]);
            expect(findings).toEqual([]);
        });

        it('should reject an invalid tag filter as a configuration error', async () => {
            const { ctx } = harness(inSync(), CURRENT, {
                runnerImage: {
                    valuesFile: SCALE_SET_FILE,
                    imagePath: 'scaleSet.runner.image',
                    source: RUNNER_IMAGE,
                    tagPattern: '([',
                },
            });
            const { errors } = await new ArcCollector().collect(ctx);
            expect(errors[0]).toMatchObject({ code: 'config-error', target: RUNNER_IMAGE });
        });
    });

    describe('failure handling', () => {
        it('should record a missing values file and keep going [REQ-ARC-014]', async () => {
            const { ctx } = harness(
                { [SCALE_SET_FILE]: scaleSetValues('0.10.1') },
                { ...CURRENT, [SCALE_SET_CHART]: fakeResolved('0.14.2', 'helm-oci') },
            );
            const { errors, findings } = await new ArcCollector().collect(ctx);
            expect(errors).toEqual([
                {
                    code: 'not-found',
                    message: `File not found: ${CONTROLLER_FILE}`,
                    target: CONTROLLER_FILE,
                    retryable: false,
                },
            ]);
            expect(byKind(findings, 'chart-outdated')).toHaveLength(1);
        });

        it('should record an unresolvable path naming it [REQ-ARC-015]', async () => {
            const { ctx } = harness({
                [CONTROLLER_FILE]: 'controller:\n    replicaCount: 1',
                [SCALE_SET_FILE]: scaleSetValues('0.10.1'),
            });
            const { errors } = await new ArcCollector().collect(ctx);
            expect(errors).toEqual([
                {
                    code: 'config-error',
                    message: `${CONTROLLER_FILE} has no value at controller.chartVersion`,
                    target: `${CONTROLLER_FILE}#controller.chartVersion`,
                    retryable: false,
                },
            ]);
        });

        it('should read a values file once however many targets point at it', async () => {
            // Both the scale-set chart version and the runner image live in one file.
            const files = new InMemoryFileProvider(inSync());
            const ctx = fakeContext({
                config: config(),
                files,
                sources: new FakeSourceRegistry(CURRENT),
            });
            await new ArcCollector().collect(ctx);
            expect(files.reads.filter((path) => path === SCALE_SET_FILE)).toHaveLength(1);
        });
    });
});
