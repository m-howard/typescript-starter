import { EksCollector } from '../src/maintenance/collectors/eks';
import { runCollector } from '../src/maintenance/collectors/collector';
import { CollectorContext } from '../src/maintenance/types';
import { Finding } from '../src/maintenance/schema';
import { FixedClock } from '../src/maintenance/clock';
import {
    fakeContext,
    fakeResolved,
    FakeCommandRunner,
    FakeSourceRegistry,
    InMemoryFileProvider,
} from './support/maintenance-fakes';

const INVENTORY = 'infra/eks/cluster.yaml';
const AWS_ARGV = 'aws eks describe-cluster-versions --output json';
const DOCS = 'https://docs.aws.amazon.com/eks/latest/userguide/kubernetes-versions.html';

const inventory = (version: string, addons = true) =>
    [
        'cluster:',
        '    name: gha-runners',
        `    version: '${version}'`,
        ...(addons
            ? [
                  '    addons:',
                  "        vpc-cni: 'v1.19.2-eksbuild.1'",
                  "        coredns: 'v1.11.4-eksbuild.2'",
              ]
            : []),
        "lastReconciled: '2026-09-12'",
    ].join('\n');

const CALENDAR = {
    lastVerified: '2026-09-01',
    staleAfterDays: 90,
    source: DOCS,
    defaultVersion: '1.34',
    versions: [
        {
            version: '1.31',
            endOfStandardSupport: '2025-11-26',
            endOfExtendedSupport: '2026-11-26',
            status: 'extended-support',
        },
        {
            version: '1.33',
            endOfStandardSupport: '2026-10-01',
            endOfExtendedSupport: '2027-10-01',
            status: 'standard-support',
        },
        {
            version: '1.34',
            endOfStandardSupport: '2027-11-26',
            endOfExtendedSupport: '2028-11-26',
            status: 'standard-support',
        },
    ],
};

const config = (overrides: Record<string, unknown> = {}) => ({
    version: 1,
    collectors: {
        eks: { inventoryFile: INVENTORY, supportCalendar: CALENDAR, ...overrides },
    },
});

interface Harness {
    ctx: CollectorContext;
    commands: FakeCommandRunner;
}

function harness(
    options: {
        version?: string;
        addons?: boolean;
        settings?: Record<string, unknown>;
        clock?: FixedClock;
        aws?: { exitCode?: number; stdout?: string } | Error;
        answers?: Record<string, ReturnType<typeof fakeResolved>>;
        files?: Record<string, string>;
    } = {},
): Harness {
    const commands = new FakeCommandRunner();
    if (options.aws !== undefined) {
        commands.on(AWS_ARGV, options.aws);
    }
    return {
        commands,
        ctx: fakeContext({
            config: config(options.settings),
            files: new InMemoryFileProvider(
                options.files ?? {
                    [INVENTORY]: inventory(options.version ?? '1.34', options.addons ?? true),
                },
            ),
            commands,
            sources: new FakeSourceRegistry(options.answers ?? {}),
            clock: options.clock ?? new FixedClock('2026-09-12T06:00:00.000Z'),
        }),
    };
}

const byKind = (findings: readonly Finding[], kind: string): Finding[] =>
    findings.filter((finding) => finding.kind === kind);

describe('EksCollector', () => {
    describe('isEnabled', () => {
        it('should run only when the configuration declares it [REQ-CFG-007]', () => {
            const collector = new EksCollector();
            expect(collector.isEnabled(fakeContext({ config: config() }).config)).toBe(true);
            expect(collector.isEnabled(fakeContext().config)).toBe(false);
        });
    });

    describe('the cluster version [REQ-EKS-010]', () => {
        it('should read it from the declared inventory file with its line', async () => {
            const { ctx } = harness({ version: '1.31' });
            const findings = byKind(
                (await new EksCollector().collect(ctx)).findings,
                'cluster-version-outdated',
            );
            expect(findings[0].evidence[0]).toMatchObject({
                type: 'file',
                path: INVENTORY,
                line: 3,
                snippet: "version: '1.31'",
            });
        });

        it('should compare it against the newest version in standard support [REQ-EKS-011]', async () => {
            const { ctx } = harness({ version: '1.31' });
            const findings = byKind(
                (await new EksCollector().collect(ctx)).findings,
                'cluster-version-outdated',
            );
            // 1.33 is in the table too but 1.34 is the newest still in standard support.
            expect(findings[0].versions).toMatchObject({
                declared: '1.31',
                observed: '1.31.0',
                latest: '1.34',
                bump: 'minor',
            });
            expect(findings[0].latestResolution).toMatchObject({
                method: 'support-calendar',
                confidence: 'medium',
            });
        });

        it('should emit nothing about drift when the cluster is on the newest version [REQ-SCH-009]', async () => {
            const { ctx } = harness({ version: '1.34' });
            const findings = byKind(
                (await new EksCollector().collect(ctx)).findings,
                'cluster-version-outdated',
            );
            expect(findings).toEqual([]);
        });

        it('should never take a latest version from upstream Kubernetes [REQ-EKS-016]', async () => {
            const { ctx } = harness({
                version: '1.31',
                answers: { 'github-release:kubernetes/kubernetes': fakeResolved('1.40.0') },
            });
            const findings = byKind(
                (await new EksCollector().collect(ctx)).findings,
                'cluster-version-outdated',
            );
            expect((ctx.sources as FakeSourceRegistry).asked).toEqual([]);
            expect(findings[0].versions.latest).toBe('1.34');
        });
    });

    describe('support dates [REQ-EKS-013]', () => {
        it('should score a lapsed cluster version critical', async () => {
            const { ctx } = harness({ version: '1.31' });
            const findings = byKind(
                (await new EksCollector().collect(ctx)).findings,
                'cluster-version-eol',
            );
            expect(findings).toHaveLength(1);
            expect(findings[0]).toMatchObject({
                severity: { severity: 'critical', ruleId: 'SEV-EOL-PAST' },
                lifecycle: {
                    endOfStandardSupport: '2025-11-26',
                    endOfExtendedSupport: '2026-11-26',
                    daysUntilEndOfSupport: -290,
                    calendarLastVerified: '2026-09-01',
                },
            });
        });

        it('should escalate as the date approaches', async () => {
            // 1.33 leaves standard support on 2026-10-01, 19 days after the fixed clock.
            const { ctx } = harness({ version: '1.33' });
            const findings = byKind(
                (await new EksCollector().collect(ctx)).findings,
                'cluster-version-eol',
            );
            expect(findings[0].severity).toMatchObject({
                severity: 'high',
                ruleId: 'SEV-EOL-SOON-30',
            });
        });

        it('should stay quiet while support is comfortably ahead [REQ-SCH-009]', async () => {
            const { ctx } = harness({ version: '1.34' });
            expect(
                byKind((await new EksCollector().collect(ctx)).findings, 'cluster-version-eol'),
            ).toEqual([]);
        });

        it('should be a separate finding from drift, so both can be reported at once', async () => {
            const { ctx } = harness({ version: '1.31' });
            const { findings } = await new EksCollector().collect(ctx);
            expect(findings.map((f) => f.kind).sort()).toEqual([
                'cluster-version-eol',
                'cluster-version-outdated',
            ]);
            expect(new Set(findings.map((f) => f.fingerprint)).size).toBe(2);
        });

        it('should point at the calendar it read the dates from', async () => {
            const { ctx } = harness({ version: '1.31' });
            const findings = byKind(
                (await new EksCollector().collect(ctx)).findings,
                'cluster-version-eol',
            );
            expect(findings[0].lifecycle?.calendarSource).toBe(
                'maintenance.config.yaml#collectors.eks.supportCalendar',
            );
            expect(findings[0].references).toEqual([DOCS]);
        });
    });

    describe('a version the calendar does not know [REQ-EKS-014]', () => {
        it('should emit the drift finding and record a config error', async () => {
            const { ctx } = harness({ version: '1.29' });
            const { findings, errors } = await new EksCollector().collect(ctx);
            expect(errors).toEqual([
                {
                    code: 'config-error',
                    message: 'The support calendar has no entry for EKS 1.29',
                    target: 'maintenance.config.yaml#collectors.eks.supportCalendar',
                    retryable: false,
                },
            ]);
            expect(findings.map((f) => f.kind)).toEqual(['cluster-version-outdated']);
            expect(findings[0].detail).toContain('no entry for 1.29');
        });
    });

    describe('a calendar with nothing to upgrade to', () => {
        it('should report the latest version as unresolved rather than invent one', async () => {
            const { ctx } = harness({
                version: '1.31',
                settings: {
                    supportCalendar: {
                        ...CALENDAR,
                        versions: CALENDAR.versions.map((entry) => ({
                            ...entry,
                            status: 'extended-support',
                        })),
                    },
                },
            });
            const findings = byKind(
                (await new EksCollector().collect(ctx)).findings,
                'cluster-version-outdated',
            );
            // A version on extended support is not something to upgrade *to*.
            expect(findings[0]).toMatchObject({
                unresolved: true,
                severity: { ruleId: 'SEV-UNRESOLVED' },
            });
        });

        it('should ignore a calendar entry whose version cannot be read', async () => {
            const { ctx } = harness({
                version: '1.31',
                settings: {
                    supportCalendar: {
                        ...CALENDAR,
                        versions: [
                            ...CALENDAR.versions,
                            {
                                version: 'latest',
                                endOfStandardSupport: '2030-01-01',
                                endOfExtendedSupport: null,
                                status: 'standard-support',
                            },
                        ],
                    },
                },
            });
            const findings = byKind(
                (await new EksCollector().collect(ctx)).findings,
                'cluster-version-outdated',
            );
            // Letting an unreadable entry rank would make input order decide the answer.
            expect(findings[0].versions.latest).toBe('1.34');
        });
    });

    describe('calendar freshness [REQ-EKS-012]', () => {
        it('should nag once the last-verified date is past the staleness window', async () => {
            const { ctx } = harness({
                version: '1.34',
                clock: new FixedClock('2027-01-01T00:00:00.000Z'),
            });
            const findings = byKind(
                (await new EksCollector().collect(ctx)).findings,
                'config-stale',
            );
            expect(findings).toHaveLength(1);
            expect(findings[0]).toMatchObject({
                subject: { kind: 'maintenance-config', displayName: 'EKS support calendar' },
                severity: { severity: 'medium', ruleId: 'SEV-CONFIG-STALE' },
            });
            expect(findings[0].title).toContain('122 days ago');
        });

        it('should stay quiet inside the window', async () => {
            const { ctx } = harness({ version: '1.34' });
            expect(
                byKind((await new EksCollector().collect(ctx)).findings, 'config-stale'),
            ).toEqual([]);
        });
    });

    describe('addons [REQ-EKS-015]', () => {
        const addonSettings = {
            addonLatest: { 'vpc-cni': 'github-release:aws/amazon-vpc-cni-k8s' },
        };

        it('should compare on the semantic core while recording the declared string', async () => {
            const { ctx } = harness({
                version: '1.34',
                settings: addonSettings,
                answers: {
                    'github-release:aws/amazon-vpc-cni-k8s': fakeResolved('1.20.0'),
                },
            });
            const findings = byKind(
                (await new EksCollector().collect(ctx)).findings,
                'addon-outdated',
            );
            expect(findings).toHaveLength(1);
            expect(findings[0]).toMatchObject({
                subject: { kind: 'eks-addon', id: 'vpc-cni' },
                versions: {
                    // The declared string is recorded in full; the comparison happens on
                    // the semantic core.
                    declared: 'v1.19.2-eksbuild.1',
                    observed: '1.19.2',
                    latest: '1.20.0',
                    bump: 'minor',
                },
                evidence: [{ type: 'file', path: INVENTORY, line: 5 }],
            });
        });

        it('should not read an -eksbuild suffix as being behind its own version', async () => {
            const { ctx } = harness({
                version: '1.34',
                settings: addonSettings,
                answers: {
                    'github-release:aws/amazon-vpc-cni-k8s': fakeResolved('1.19.2'),
                },
            });
            // Semver orders `1.19.2-eksbuild.1` before `1.19.2`, which would report the
            // addon as a patch behind the release it is a build of.
            expect(
                byKind((await new EksCollector().collect(ctx)).findings, 'addon-outdated'),
            ).toEqual([]);
        });

        it('should say nothing about an addon with no declared upstream', async () => {
            const { ctx } = harness({
                version: '1.34',
                settings: addonSettings,
                answers: {
                    'github-release:aws/amazon-vpc-cni-k8s': fakeResolved('1.19.2'),
                },
            });
            // coredns has no entry in addonLatest: reporting drift toward an upstream
            // release EKS may not offer is the mistake ADR-0002 rejects.
            const findings = byKind(
                (await new EksCollector().collect(ctx)).findings,
                'addon-outdated',
            );
            expect(findings).toEqual([]);
        });

        it('should tolerate an inventory with no addon block at all', async () => {
            const { ctx } = harness({ version: '1.34', addons: false });
            expect((await new EksCollector().collect(ctx)).findings).toEqual([]);
        });
    });

    describe('the AWS CLI strategy [REQ-EKS-040]', () => {
        const awsSettings = { latestStrategy: 'support-calendar+aws-cli' };
        const awsOutput = JSON.stringify({
            clusterVersions: [
                { clusterVersion: '1.34', clusterVersionStatus: 'standard-support' },
                { clusterVersion: '1.35', clusterVersionStatus: 'standard-support' },
                { clusterVersion: '1.31', clusterVersionStatus: 'extended-support' },
            ],
        });

        it('should prefer the CLI answer and record high confidence', async () => {
            const { ctx } = harness({
                version: '1.31',
                settings: awsSettings,
                aws: { stdout: awsOutput },
            });
            const findings = byKind(
                (await new EksCollector().collect(ctx)).findings,
                'cluster-version-outdated',
            );
            expect(findings[0].latestResolution).toMatchObject({
                version: '1.35',
                method: 'aws-cli',
                confidence: 'high',
            });
        });

        it('should record the invocation as evidence [REQ-EVI-003]', async () => {
            const { ctx } = harness({
                version: '1.31',
                settings: awsSettings,
                aws: { stdout: awsOutput },
            });
            const findings = byKind(
                (await new EksCollector().collect(ctx)).findings,
                'cluster-version-outdated',
            );
            expect(findings[0].evidence[1]).toMatchObject({
                type: 'command',
                argv: ['aws', 'eks', 'describe-cluster-versions', '--output', 'json'],
                exitCode: 0,
            });
        });

        it.each([
            ['the CLI is missing', new Error('spawn aws ENOENT')],
            ['the CLI exits non-zero', { exitCode: 255, stdout: '' }],
            ['the output is not JSON', { stdout: 'Unable to locate credentials' }],
            ['the document has an unexpected shape', { stdout: '{"clusterVersions":[{}]}' }],
            ['the CLI lists no versions', { stdout: '{"clusterVersions":[]}' }],
        ])(
            'should fall back to the calendar and record the downgrade when %s [REQ-EKS-041]',
            async (_label, aws) => {
                const { ctx } = harness({ version: '1.31', settings: awsSettings, aws });
                const { findings, errors } = await new EksCollector().collect(ctx);
                const drift = byKind(findings, 'cluster-version-outdated')[0];
                // The answer still arrives; that it came from a committed table rather
                // than a live API is visible in method and confidence.
                expect(drift.latestResolution).toMatchObject({
                    version: '1.34',
                    method: 'support-calendar',
                    confidence: 'medium',
                });
                expect(errors).toHaveLength(1);
                expect(errors[0].target).toBe('aws eks describe-cluster-versions --output json');
            },
        );

        it('should report the run as partial once the CLI has failed', async () => {
            const { ctx } = harness({
                version: '1.31',
                settings: awsSettings,
                aws: { exitCode: 255, stdout: '' },
            });
            const { run } = await runCollector(new EksCollector(), ctx);
            expect(run.status).toBe('partial');
        });

        it('should not run the CLI under the default strategy', async () => {
            const { ctx, commands } = harness({ version: '1.31' });
            await new EksCollector().collect(ctx);
            expect(commands.calls).toEqual([]);
        });
    });

    describe('failure handling', () => {
        it('should record a missing cluster version path', async () => {
            const { ctx } = harness({ files: { [INVENTORY]: 'cluster:\n    name: gha-runners' } });
            const { errors, findings } = await new EksCollector().collect(ctx);
            expect(errors).toEqual([
                {
                    code: 'config-error',
                    message: `${INVENTORY} has no value at cluster.version`,
                    target: `${INVENTORY}#cluster.version`,
                    retryable: false,
                },
            ]);
            expect(findings).toEqual([]);
        });

        it('should fail outright when the inventory cannot be read', async () => {
            const ctx = fakeContext({
                config: config(),
                files: new InMemoryFileProvider({}),
            });
            const { run, findings } = await runCollector(new EksCollector(), ctx);
            expect(run.status).toBe('failed');
            expect(run.errors[0]).toMatchObject({ code: 'not-found', target: INVENTORY });
            expect(findings[0].kind).toBe('upstream-unresolved');
        });
    });
});
