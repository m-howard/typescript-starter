import * as fs from 'fs';
import * as path from 'path';
import { NpmCollector } from '../src/maintenance/collectors/npm';
import { runCollector } from '../src/maintenance/collectors/collector';
import { CollectorContext } from '../src/maintenance/types';
import { Finding } from '../src/maintenance/schema';
import { NotFoundError } from '../src/maintenance/errors';
import {
    fakeContext,
    fakeResolved,
    fakeUnresolved,
    FakeCommandRunner,
    FakeSourceRegistry,
    InMemoryFileProvider,
} from './support/maintenance-fakes';

const OUTDATED = 'npm outdated --json --long';
const AUDIT = 'npm audit --json';

const fixture = (name: string): string =>
    fs.readFileSync(path.join(__dirname, 'fixtures', 'maintenance', name), 'utf8');

const MANIFEST = JSON.stringify(
    {
        name: 'typescript-starter',
        version: '1.0.0',
        dependencies: { lodash: '^4.17.21', '@clerk/clerk-sdk-node': '^4.13.0' },
        devDependencies: { typescript: '^5.8.3', jest: '^29.7.0' },
    },
    null,
    4,
);

const config = (overrides: Record<string, unknown> = {}) => ({
    version: 1,
    collectors: { npm: { ...overrides } },
});

interface Harness {
    ctx: CollectorContext;
    commands: FakeCommandRunner;
    sources: FakeSourceRegistry;
}

function harness(
    options: {
        outdated?: Record<string, unknown> | string | Error;
        audit?: string | Error;
        exitCode?: number;
        answers?: Record<string, ReturnType<typeof fakeResolved>>;
        settings?: Record<string, unknown>;
        manifest?: string;
    } = {},
): Harness {
    const commands = new FakeCommandRunner();
    if (options.outdated !== undefined) {
        commands.on(
            OUTDATED,
            options.outdated instanceof Error
                ? options.outdated
                : {
                      exitCode: options.exitCode ?? 1,
                      stdout:
                          typeof options.outdated === 'string'
                              ? options.outdated
                              : JSON.stringify(options.outdated),
                  },
        );
    }
    if (options.audit !== undefined) {
        commands.on(
            AUDIT,
            options.audit instanceof Error
                ? options.audit
                : { exitCode: options.exitCode ?? 1, stdout: options.audit },
        );
    }
    const sources = new FakeSourceRegistry(options.answers ?? {});
    return {
        commands,
        sources,
        ctx: fakeContext({
            config: config(options.settings),
            files: new InMemoryFileProvider({ 'package.json': options.manifest ?? MANIFEST }),
            commands,
            sources,
        }),
    };
}

const byKind = (findings: readonly Finding[], kind: string): Finding[] =>
    findings.filter((finding) => finding.kind === kind);

const forSubject = (findings: readonly Finding[], id: string): Finding[] =>
    findings.filter((finding) => finding.subject.id === id);

/** Every declared package resolved to exactly what the manifest asks for: no drift. */
const NO_DRIFT = {
    'npm:lodash': fakeResolved('4.17.21', 'npm-registry'),
    'npm:@clerk/clerk-sdk-node': fakeResolved('4.13.0', 'npm-registry'),
    'npm:typescript': fakeResolved('5.8.3', 'npm-registry'),
    'npm:jest': fakeResolved('29.7.0', 'npm-registry'),
};

describe('NpmCollector', () => {
    describe('isEnabled', () => {
        it('should run only when the configuration declares it [REQ-CFG-007]', () => {
            const collector = new NpmCollector();
            expect(collector.isEnabled(fakeContext({ config: config() }).config)).toBe(true);
            expect(collector.isEnabled(fakeContext().config)).toBe(false);
        });
    });

    describe('the declared set [REQ-NPM-010]', () => {
        it('should come from the manifest, including devDependencies', async () => {
            const { ctx } = harness({
                settings: { runOutdated: false, runAudit: false },
                answers: {
                    'npm:lodash': fakeResolved('5.0.0', 'npm-registry'),
                    'npm:@clerk/clerk-sdk-node': fakeResolved('5.1.6', 'npm-registry'),
                    'npm:typescript': fakeResolved('5.9.3', 'npm-registry'),
                    'npm:jest': fakeResolved('30.0.0', 'npm-registry'),
                },
            });
            const findings = byKind(
                (await new NpmCollector().collect(ctx)).findings,
                'dependency-outdated',
            );
            expect(findings.map((f) => f.subject.id).sort()).toEqual([
                '@clerk/clerk-sdk-node',
                'jest',
                'lodash',
                'typescript',
            ]);
        });

        it('should record whether each dependency is runtime or development [REQ-NPM-018]', async () => {
            const { ctx } = harness({
                outdated: JSON.parse(fixture('npm-outdated.json')) as Record<string, unknown>,
                answers: NO_DRIFT,
            });
            const findings = (await new NpmCollector().collect(ctx)).findings;
            expect(forSubject(findings, 'lodash')[0].subject.scope).toBe('runtime');
            expect(forSubject(findings, 'typescript')[0].subject.scope).toBe('dev');
        });

        it('should prefer the scope npm reported over the manifest block', async () => {
            // Declared under `dependencies` here, but npm's --long output says otherwise;
            // npm knows the installed tree and the manifest only knows what was asked for.
            const { ctx } = harness({
                outdated: {
                    lodash: { current: '4.17.21', latest: '5.0.0', type: 'devDependencies' },
                },
                answers: NO_DRIFT,
            });
            const findings = forSubject((await new NpmCollector().collect(ctx)).findings, 'lodash');
            expect(findings[0].subject.scope).toBe('dev');
        });

        it('should honour the configured ignore list', async () => {
            const { ctx } = harness({
                settings: { runOutdated: false, runAudit: false, ignore: ['lodash', 'jest'] },
                answers: NO_DRIFT,
            });
            await new NpmCollector().collect(ctx);
            expect(ctx.sources).toBeInstanceOf(FakeSourceRegistry);
            expect((ctx.sources as FakeSourceRegistry).asked.sort()).toEqual([
                'npm:@clerk/clerk-sdk-node',
                'npm:typescript',
            ]);
        });
    });

    describe('drift', () => {
        it('should read the installed version from npm outdated', async () => {
            const { ctx } = harness({
                outdated: JSON.parse(fixture('npm-outdated.json')) as Record<string, unknown>,
                answers: NO_DRIFT,
            });
            const findings = forSubject(
                (await new NpmCollector().collect(ctx)).findings,
                'typescript',
            );
            expect(findings[0]).toMatchObject({
                versions: {
                    declared: '^5.8.3',
                    observed: '5.8.3',
                    latest: '7.0.2',
                    bump: 'major',
                    majorsBehind: 2,
                },
                severity: { severity: 'medium', ruleId: 'SEV-DRIFT-MAJOR-MULTI' },
            });
            // Two majors behind is high, demoted one tier because it is a dev dependency.
            expect(findings[0].severity.modifiers).toEqual(['dev-scope-demotion']);
        });

        it('should resolve a package npm outdated never mentioned [REQ-NPM-014]', async () => {
            const { ctx, sources } = harness({
                outdated: { typescript: { current: '5.8.3', latest: '7.0.2' } },
                answers: {
                    ...NO_DRIFT,
                    'npm:lodash': fakeResolved('4.18.1', 'npm-registry'),
                },
            });
            const findings = forSubject((await new NpmCollector().collect(ctx)).findings, 'lodash');
            // Absent from `npm outdated` usually means current — but "usually" is not a
            // fact, so it is asked about rather than assumed.
            expect(sources.asked).toContain('npm:lodash');
            expect(findings[0].versions).toMatchObject({ latest: '4.18.1', bump: 'minor' });
        });

        it('should ask the registry about the version actually in use', async () => {
            const { ctx, sources } = harness({
                settings: { runOutdated: false, runAudit: false },
                answers: NO_DRIFT,
            });
            await new NpmCollector().collect(ctx);
            expect(sources.requests).toContainEqual({
                ref: 'npm:typescript',
                options: { observedVersion: '5.8.3' },
            });
        });

        it('should emit nothing for a dependency already at latest [REQ-SCH-009]', async () => {
            const { ctx } = harness({
                settings: { runOutdated: false, runAudit: false },
                answers: NO_DRIFT,
            });
            expect((await new NpmCollector().collect(ctx)).findings).toEqual([]);
        });

        it('should emit an unresolved finding rather than report no drift [REQ-ERR-030]', async () => {
            const { ctx } = harness({
                settings: { runOutdated: false, runAudit: false },
                answers: {
                    ...NO_DRIFT,
                    'npm:lodash': fakeUnresolved('registry unreachable', 'npm-registry'),
                },
            });
            const findings = forSubject((await new NpmCollector().collect(ctx)).findings, 'lodash');
            expect(findings).toHaveLength(1);
            expect(findings[0]).toMatchObject({
                unresolved: true,
                severity: { ruleId: 'SEV-UNRESOLVED' },
            });
            expect(findings[0].detail).toContain('registry unreachable');
        });

        it('should quote the manifest line it read [REQ-EVI-002]', async () => {
            const { ctx } = harness({
                settings: { runOutdated: false, runAudit: false },
                answers: { ...NO_DRIFT, 'npm:lodash': fakeResolved('4.18.1', 'npm-registry') },
            });
            const findings = forSubject((await new NpmCollector().collect(ctx)).findings, 'lodash');
            expect(findings[0].evidence[0]).toMatchObject({
                type: 'file',
                path: 'package.json',
                line: 5,
                snippet: '"lodash": "^4.17.21",',
            });
        });

        it('should suggest an install command matching the dependency scope', async () => {
            const { ctx } = harness({
                settings: { runOutdated: false, runAudit: false },
                answers: {
                    ...NO_DRIFT,
                    'npm:lodash': fakeResolved('4.18.1', 'npm-registry'),
                    'npm:typescript': fakeResolved('5.9.3', 'npm-registry'),
                },
            });
            const findings = (await new NpmCollector().collect(ctx)).findings;
            expect(forSubject(findings, 'lodash')[0].remediationHint).toBe(
                'npm install --save lodash@4.18.1',
            );
            expect(forSubject(findings, 'typescript')[0].remediationHint).toBe(
                'npm install --save-dev typescript@5.9.3',
            );
        });
    });

    describe('deprecation [REQ-NPM-017]', () => {
        it('should emit a finding when the registry deprecates the version in use', async () => {
            const { ctx } = harness({
                settings: { runOutdated: false, runAudit: false },
                answers: {
                    ...NO_DRIFT,
                    'npm:lodash': fakeResolved('4.17.21', 'npm-registry', 'high', true),
                },
            });
            const findings = byKind(
                (await new NpmCollector().collect(ctx)).findings,
                'dependency-deprecated',
            );
            expect(findings).toHaveLength(1);
            expect(findings[0]).toMatchObject({
                subject: { id: 'lodash' },
                lifecycle: { deprecated: true },
                severity: { severity: 'medium', ruleId: 'SEV-DEPRECATED' },
            });
        });

        it('should emit it even when the package is otherwise current', async () => {
            const { ctx } = harness({
                settings: { runOutdated: false, runAudit: false },
                answers: {
                    ...NO_DRIFT,
                    'npm:lodash': fakeResolved('4.17.21', 'npm-registry', 'high', true),
                },
            });
            const findings = (await new NpmCollector().collect(ctx)).findings;
            expect(findings.map((f) => f.kind)).toEqual(['dependency-deprecated']);
        });

        it('should stay quiet when the registry says nothing about deprecation', async () => {
            const { ctx } = harness({
                settings: { runOutdated: false, runAudit: false },
                answers: NO_DRIFT,
            });
            expect((await new NpmCollector().collect(ctx)).findings).toEqual([]);
        });
    });

    describe('advisories', () => {
        const withAudit = () =>
            harness({
                settings: { runOutdated: false },
                audit: fixture('npm-audit.json'),
                answers: NO_DRIFT,
            });

        it('should emit one finding per package and advisory pair [REQ-NPM-015]', async () => {
            const { ctx } = withAudit();
            const findings = byKind(
                (await new NpmCollector().collect(ctx)).findings,
                'dependency-vulnerable',
            );
            // The slash inside a scoped name becomes a hyphen: `/` separates the id's
            // own segments, so a package name cannot be allowed to add more of them.
            expect(findings.map((f) => f.id).sort()).toEqual([
                'npm/dependency-vulnerable/@babel-core/ghsa-4x5r-pxfx-6jf8',
                'npm/dependency-vulnerable/@clerk-backend/transitive-only',
                'npm/dependency-vulnerable/@clerk-clerk-sdk-node/transitive-only',
            ]);
        });

        it('should mint no advisory from a transitive chain entry [REQ-NPM-016]', async () => {
            const { ctx } = withAudit();
            const findings = forSubject(
                (await new NpmCollector().collect(ctx)).findings,
                '@clerk/backend',
            );
            // via[] here holds only the strings "@clerk/shared" and "cookie".
            expect(findings[0].advisory?.id).toBe('npm-audit:@clerk/backend');
            expect(findings[0].detail).toContain('@clerk/shared → cookie');
        });

        it('should score an advisory-less vulnerable package from npm own rollup', async () => {
            const { ctx } = withAudit();
            const findings = forSubject(
                (await new NpmCollector().collect(ctx)).findings,
                '@clerk/clerk-sdk-node',
            );
            // A direct, high-severity, fixable vulnerability with no advisory object of
            // its own is the most actionable entry in the document, not the least.
            expect(findings[0]).toMatchObject({
                discriminator: 'transitive-only',
                severity: { severity: 'high', ruleId: 'SEV-VULN-HIGH' },
                advisory: {
                    severity: 'high',
                    isDirect: true,
                    fixAvailable: true,
                    fixedVersion: '5.1.6',
                    fixIsSemverMajor: true,
                },
            });
            expect(findings[0].remediationHint).toBe(
                'npm audit fix --force (this applies a breaking change)',
            );
        });

        it('should carry the advisory identifier, severity and fix into the finding', async () => {
            const { ctx } = withAudit();
            const findings = forSubject(
                (await new NpmCollector().collect(ctx)).findings,
                '@babel/core',
            );
            expect(findings[0]).toMatchObject({
                discriminator: 'GHSA-4x5r-pxfx-6jf8',
                advisory: {
                    id: 'GHSA-4x5r-pxfx-6jf8',
                    source: 'npm-audit',
                    severity: 'low',
                    isDirect: false,
                    fixAvailable: true,
                },
                severity: { ruleId: 'SEV-VULN-LOW' },
            });
        });

        it('should keep a long advisory title within the contract', async () => {
            const { ctx } = harness({
                settings: { runOutdated: false },
                audit: JSON.stringify({
                    vulnerabilities: {
                        lodash: {
                            name: 'lodash',
                            severity: 'high',
                            isDirect: true,
                            via: [
                                {
                                    source: 1,
                                    url: 'https://github.com/advisories/GHSA-aaaa-bbbb-cccc',
                                    title: 'x'.repeat(400),
                                    severity: 'high',
                                },
                            ],
                            effects: [],
                            nodes: [],
                            fixAvailable: false,
                        },
                    },
                }),
                answers: NO_DRIFT,
            });
            const findings = byKind(
                (await new NpmCollector().collect(ctx)).findings,
                'dependency-vulnerable',
            );
            expect(findings[0].title).toHaveLength(160);
            expect(findings[0].title.endsWith('…')).toBe(true);
        });

        it('should list the same advisory once however many paths report it', async () => {
            const advisory = {
                source: 1,
                url: 'https://github.com/advisories/GHSA-aaaa-bbbb-cccc',
                title: 'ReDoS',
                severity: 'high',
            };
            const { ctx } = harness({
                settings: { runOutdated: false },
                audit: JSON.stringify({
                    vulnerabilities: {
                        lodash: {
                            name: 'lodash',
                            severity: 'high',
                            isDirect: true,
                            // npm lists an advisory once per affected path.
                            via: [advisory, advisory, advisory],
                            effects: [],
                            nodes: [],
                            fixAvailable: false,
                        },
                    },
                }),
                answers: NO_DRIFT,
            });
            const findings = byKind(
                (await new NpmCollector().collect(ctx)).findings,
                'dependency-vulnerable',
            );
            expect(findings).toHaveLength(1);
        });

        it('should not claim a scope it does not know for a transitive package', async () => {
            const { ctx } = withAudit();
            const findings = forSubject(
                (await new NpmCollector().collect(ctx)).findings,
                '@babel/core',
            );
            // Guessing `dev` here would quietly demote a production problem one tier.
            expect(findings[0].subject.scope).toBe('unknown');
        });

        it('should honour the ignore list for a vulnerable package too', async () => {
            const { ctx } = harness({
                settings: { runOutdated: false, ignore: ['@babel/core', '@clerk/backend'] },
                audit: fixture('npm-audit.json'),
                answers: NO_DRIFT,
            });
            const findings = byKind(
                (await new NpmCollector().collect(ctx)).findings,
                'dependency-vulnerable',
            );
            expect(findings.map((f) => f.subject.id)).toEqual(['@clerk/clerk-sdk-node']);
        });

        it('should give every finding in a run a distinct fingerprint [REQ-ID-001]', async () => {
            const { ctx } = harness({
                outdated: JSON.parse(fixture('npm-outdated.json')) as Record<string, unknown>,
                audit: fixture('npm-audit.json'),
                answers: NO_DRIFT,
            });
            const { findings } = await new NpmCollector().collect(ctx);
            expect(findings.length).toBeGreaterThan(1);
            expect(new Set(findings.map((f) => f.fingerprint)).size).toBe(findings.length);
        });
    });

    describe('running the npm commands', () => {
        it('should treat exit 1 as success for both commands [REQ-NPM-011, REQ-NPM-012]', async () => {
            const { ctx } = harness({
                outdated: JSON.parse(fixture('npm-outdated.json')) as Record<string, unknown>,
                audit: fixture('npm-audit.json'),
                exitCode: 1,
                answers: NO_DRIFT,
            });
            const { errors, findings } = await new NpmCollector().collect(ctx);
            expect(errors).toEqual([]);
            expect(findings.length).toBeGreaterThan(0);
        });

        it('should bound the output buffer explicitly [REQ-NPM-020]', async () => {
            const { ctx, commands } = harness({
                outdated: {},
                audit: '{}',
                answers: NO_DRIFT,
            });
            await new NpmCollector().collect(ctx);
            for (const call of commands.calls) {
                expect(call.maxBuffer).toBe(32 * 1024 * 1024);
            }
        });

        it('should skip a command the configuration turns off', async () => {
            const { ctx, commands } = harness({
                settings: { runOutdated: false, runAudit: false },
                answers: NO_DRIFT,
            });
            await new NpmCollector().collect(ctx);
            expect(commands.calls).toEqual([]);
        });

        it('should record any other exit status and keep going [REQ-NPM-013]', async () => {
            const { ctx } = harness({
                outdated: { lodash: { current: '4.17.21', latest: '4.18.1' } },
                audit: '',
                exitCode: 2,
                answers: {
                    ...NO_DRIFT,
                    'npm:lodash': fakeResolved('4.18.1', 'npm-registry'),
                },
            });
            const { errors, findings } = await new NpmCollector().collect(ctx);
            expect(errors).toHaveLength(2);
            expect(errors[0]).toMatchObject({ code: 'command-failed', target: 'npm outdated' });
            // The manifest and the registry still answered, so drift is still reported.
            expect(forSubject(findings, 'lodash')[0].versions.latest).toBe('4.18.1');
        });

        it('should record unparseable output rather than crash [REQ-NPM-013]', async () => {
            const { ctx } = harness({
                outdated: 'not json at all',
                settings: { runAudit: false },
                answers: NO_DRIFT,
            });
            const { errors } = await new NpmCollector().collect(ctx);
            expect(errors).toHaveLength(1);
            expect(errors[0]).toMatchObject({ code: 'parse-error', target: 'npm outdated' });
        });

        it('should record unparseable audit output rather than crash [REQ-NPM-013]', async () => {
            const { ctx } = harness({
                settings: { runOutdated: false },
                audit: '{ "vulnerabilities": "not an object" }',
                answers: NO_DRIFT,
            });
            const { errors, findings } = await new NpmCollector().collect(ctx);
            expect(errors).toHaveLength(1);
            expect(errors[0]).toMatchObject({ code: 'parse-error', target: 'npm audit' });
            expect(findings).toEqual([]);
        });

        it('should report an audit failure without losing the outdated findings', async () => {
            const { ctx } = harness({
                outdated: { lodash: { current: '4.17.21', latest: '4.18.1' } },
                audit: new NotFoundError('no lockfile', { target: 'npm audit' }),
                answers: NO_DRIFT,
            });
            const { errors, findings } = await new NpmCollector().collect(ctx);
            expect(errors).toEqual([
                {
                    code: 'not-found',
                    message: 'no lockfile',
                    target: 'npm audit',
                    retryable: false,
                },
            ]);
            expect(forSubject(findings, 'lodash')).toHaveLength(1);
        });
    });

    describe('degrading without npm [REQ-NPM-019]', () => {
        it('should still report drift from the manifest and the registry, as partial', async () => {
            const { ctx } = harness({
                outdated: new NotFoundError('npm not found', { target: 'npm' }),
                audit: new NotFoundError('npm not found', { target: 'npm' }),
                answers: {
                    ...NO_DRIFT,
                    'npm:lodash': fakeResolved('4.18.1', 'npm-registry'),
                },
            });
            const { run, findings } = await runCollector(new NpmCollector(), ctx);
            expect(run.status).toBe('partial');
            expect(run.errors).toHaveLength(2);
            expect(forSubject(findings, 'lodash')[0].versions.latest).toBe('4.18.1');
        });
    });

    describe('failure handling', () => {
        it('should fail outright when the manifest cannot be read', async () => {
            const ctx = fakeContext({
                config: config(),
                files: new InMemoryFileProvider({}),
                commands: new FakeCommandRunner(),
            });
            // Without the declared set there is nothing to scan, so this is a failure
            // rather than a degraded run.
            const { run, findings } = await runCollector(new NpmCollector(), ctx);
            expect(run.status).toBe('failed');
            expect(run.errors[0]).toMatchObject({ code: 'not-found', target: 'package.json' });
            expect(findings[0].kind).toBe('upstream-unresolved');
        });
    });
});
