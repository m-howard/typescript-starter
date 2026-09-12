import {
    BuildFindingInput,
    buildFinding,
    calendarResolution,
    notApplicableResolution,
    resolutionFromSource,
} from '../src/maintenance/collectors/build-finding';
import { FindingSchema } from '../src/maintenance/schema';
import { InternalError } from '../src/maintenance/errors';
import { FixedClock } from '../src/maintenance/clock';
import { parseVersionForComparison } from '../src/maintenance/version';
import { fakeContext, fakeResolved, fakeUnresolved } from './support/maintenance-fakes';

const clock = () => new FixedClock('2026-09-12T06:00:00.000Z');

const input = (overrides: Partial<BuildFindingInput> = {}): BuildFindingInput => ({
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
    detail: 'typescript is declared at ^5.7.3 and the registry reports 5.9.2.',
    declared: '^5.7.3',
    observed: parseVersionForComparison('5.7.3'),
    latest: resolutionFromSource('npm:typescript', fakeResolved('5.9.2', 'npm-registry'), clock()),
    evidence: [
        {
            type: 'file',
            path: 'package.json',
            line: 68,
            column: null,
            snippet: '        "typescript": "^5.7.3"',
            contentSha256: null,
            repo: null,
            ref: null,
        },
    ],
    ...overrides,
});

describe('buildFinding', () => {
    describe('assembly', () => {
        it('should produce a finding that satisfies the published contract [REQ-SCH-010]', () => {
            const finding = buildFinding(input(), fakeContext({ clock: clock() }));
            expect(FindingSchema.safeParse(finding).success).toBe(true);
        });

        it('should derive the id and fingerprint from the same inputs [REQ-ID-006]', () => {
            const finding = buildFinding(input(), fakeContext({ clock: clock() }));
            expect(finding.id).toBe('npm/dependency-outdated/typescript');
            expect(finding.fingerprint).toMatch(/^[0-9a-f]{32}$/);
            expect(finding.fingerprintVersion).toBe('fp1');
        });

        it('should classify the gap between observed and latest', () => {
            const finding = buildFinding(input(), fakeContext({ clock: clock() }));
            expect(finding.versions).toEqual({
                declared: '^5.7.3',
                observed: '5.7.3',
                latest: '5.9.2',
                bump: 'minor',
                majorsBehind: 0,
            });
        });

        it('should score severity through the rule table and record the rule', () => {
            const finding = buildFinding(input(), fakeContext({ clock: clock() }));
            // A dev-scope minor drift: low from SEV-DRIFT-MINOR, already at the demotion
            // floor so no modifier is recorded.
            expect(finding.severity).toMatchObject({
                severity: 'low',
                ruleId: 'SEV-DRIFT-MINOR',
                source: 'rule-table',
                modifiers: [],
            });
        });

        it('should keep the fingerprint stable while the version moves [REQ-ID-001]', () => {
            const ctx = fakeContext({ clock: clock() });
            const before = buildFinding(input(), ctx);
            const after = buildFinding(
                input({
                    observed: parseVersionForComparison('5.8.0'),
                    latest: resolutionFromSource(
                        'npm:typescript',
                        fakeResolved('6.0.0', 'npm-registry'),
                        clock(),
                    ),
                }),
                ctx,
            );
            expect(after.fingerprint).toBe(before.fingerprint);
            expect(after.stateHash).not.toBe(before.stateHash);
        });

        it('should carry the references and tags a collector supplied', () => {
            const finding = buildFinding(
                input({
                    references: ['https://www.typescriptlang.org/'],
                    tags: ['npm', 'toolchain'],
                    remediationHint: 'npm install --save-dev typescript@5.9.2',
                }),
                fakeContext({ clock: clock() }),
            );
            expect(finding.references).toEqual(['https://www.typescriptlang.org/']);
            expect(finding.tags).toEqual(['npm', 'toolchain']);
            expect(finding.remediationHint).toBe('npm install --save-dev typescript@5.9.2');
        });

        it('should default every optional field rather than omitting it', () => {
            const finding = buildFinding(input(), fakeContext({ clock: clock() }));
            expect(finding.advisory).toBeNull();
            expect(finding.lifecycle).toBeNull();
            expect(finding.discriminator).toBeNull();
            expect(finding.remediationHint).toBeNull();
            expect(finding.references).toEqual([]);
            expect(finding.tags).toEqual([]);
        });
    });

    describe('advisory and lifecycle facts', () => {
        it('should score from the advisory severity, not the version gap', () => {
            const finding = buildFinding(
                input({
                    kind: 'dependency-vulnerable',
                    discriminator: 'GHSA-abcd-1234-efgh',
                    subject: {
                        kind: 'npm-package',
                        id: 'left-pad',
                        displayName: 'left-pad',
                        ecosystem: 'npm',
                        scope: 'runtime',
                    },
                    advisory: {
                        id: 'GHSA-abcd-1234-efgh',
                        source: 'npm-audit',
                        severity: 'critical',
                        cvssScore: 9.8,
                        cvssVector: null,
                        cwe: ['CWE-79'],
                        title: 'Prototype pollution',
                        url: 'https://github.com/advisories/GHSA-abcd-1234-efgh',
                        vulnerableRange: '<1.3.1',
                        isDirect: true,
                        fixAvailable: true,
                        fixedVersion: '1.3.1',
                        fixIsSemverMajor: false,
                    },
                }),
                fakeContext({ clock: clock() }),
            );
            expect(finding.severity).toMatchObject({
                severity: 'critical',
                ruleId: 'SEV-VULN-CRITICAL',
            });
            // The advisory id enters identity, so a second CVE on the same package is
            // new work rather than an update to the first (REQ-ID-003).
            expect(finding.id).toBe('npm/dependency-vulnerable/left-pad/ghsa-abcd-1234-efgh');
        });

        it('should score from the lifecycle dates when support has lapsed', () => {
            const finding = buildFinding(
                input({
                    kind: 'image-distro-eol',
                    subject: {
                        kind: 'container-image',
                        id: 'Dockerfile#debian',
                        displayName: 'debian',
                        ecosystem: 'oci',
                        scope: 'build',
                    },
                    lifecycle: {
                        endOfStandardSupport: '2026-08-31',
                        endOfExtendedSupport: null,
                        daysUntilEndOfSupport: -12,
                        deprecated: true,
                        deprecationMessage: 'Debian 11 is archived.',
                        calendarSource: 'maintenance.config.yaml#calendar',
                        calendarLastVerified: '2026-09-01',
                    },
                }),
                fakeContext({ clock: clock() }),
            );
            expect(finding.severity).toMatchObject({
                severity: 'critical',
                ruleId: 'SEV-EOL-PAST',
            });
        });

        it('should fold the advisory fixed version into the state hash [REQ-ID-004]', () => {
            const ctx = fakeContext({ clock: clock() });
            const advisory = {
                id: 'GHSA-abcd-1234-efgh',
                source: 'npm-audit' as const,
                severity: 'high' as const,
                cvssScore: null,
                cvssVector: null,
                cwe: [],
                title: 'Prototype pollution',
                url: null,
                vulnerableRange: '<1.3.1',
                isDirect: true,
                fixAvailable: true,
                fixedVersion: '1.3.1',
                fixIsSemverMajor: false,
            };
            const before = buildFinding(input({ advisory }), ctx);
            const after = buildFinding(
                input({ advisory: { ...advisory, fixedVersion: '1.4.0' } }),
                ctx,
            );
            expect(after.fingerprint).toBe(before.fingerprint);
            expect(after.stateHash).not.toBe(before.stateHash);
        });
    });

    describe('unresolved derivation', () => {
        it('should derive unresolved from the resolution rather than the caller [REQ-ERR-030]', () => {
            const finding = buildFinding(
                input({
                    latest: resolutionFromSource(
                        'npm:typescript',
                        fakeUnresolved('registry unreachable', 'npm-registry'),
                        clock(),
                    ),
                }),
                fakeContext({ clock: clock() }),
            );
            expect(finding.unresolved).toBe(true);
            expect(finding.latestResolution.reason).toBe('registry unreachable');
            expect(finding.severity.ruleId).toBe('SEV-UNRESOLVED');
            expect(finding.severity.severity).toBe('info');
        });

        it('should not mark a not-applicable resolution unresolved [REQ-SEV-004]', () => {
            const finding = buildFinding(
                input({
                    collector: 'github-actions',
                    kind: 'action-unpinned',
                    subject: {
                        kind: 'github-action',
                        id: 'third-party/action',
                        displayName: 'third-party/action',
                        ecosystem: 'github-actions',
                        scope: 'build',
                    },
                    observed: null,
                    latest: notApplicableResolution('not-attempted', 'nothing to resolve'),
                    isFirstPartyAction: false,
                }),
                fakeContext({ clock: clock() }),
            );
            // Were this treated as unresolved, the pre-emptive guard would force it to
            // info and the supply-chain rule would never be reached.
            expect(finding.unresolved).toBe(false);
            expect(finding.severity.ruleId).toBe('SEV-ACTION-UNPINNED-3P');
            expect(finding.severity.severity).toBe('high');
        });
    });

    describe('comparison precision [REQ-GHA-017]', () => {
        it('should read a major-only reference as current while the major holds', () => {
            const finding = buildFinding(
                input({
                    declared: 'v4',
                    observed: parseVersionForComparison('v4'),
                    comparePrecision: 'major',
                    latest: resolutionFromSource(
                        'github-release:actions/checkout',
                        fakeResolved('4.3.1'),
                        clock(),
                    ),
                }),
                fakeContext({ clock: clock() }),
            );
            expect(finding.versions.bump).toBe('none');
            // The true latest is still recorded; only the comparison was narrowed.
            expect(finding.versions.latest).toBe('4.3.1');
        });

        it('should read a major-only reference as behind once the major moves', () => {
            const finding = buildFinding(
                input({
                    declared: 'v4',
                    observed: parseVersionForComparison('v4'),
                    comparePrecision: 'major',
                    latest: resolutionFromSource(
                        'github-release:actions/checkout',
                        fakeResolved('5.1.0'),
                        clock(),
                    ),
                }),
                fakeContext({ clock: clock() }),
            );
            expect(finding.versions).toMatchObject({ bump: 'major', majorsBehind: 1 });
        });

        it('should compare a full reference exactly', () => {
            const finding = buildFinding(
                input({
                    declared: 'v4.2.1',
                    observed: parseVersionForComparison('v4.2.1'),
                    comparePrecision: 'patch',
                    latest: resolutionFromSource(
                        'github-release:actions/checkout',
                        fakeResolved('4.2.2'),
                        clock(),
                    ),
                }),
                fakeContext({ clock: clock() }),
            );
            expect(finding.versions.bump).toBe('patch');
        });

        it('should compare a loose two-part version without a precision hint', () => {
            const finding = buildFinding(
                input({
                    declared: '1.30',
                    observed: parseVersionForComparison('1.30'),
                    latest: calendarResolution('1.31', 'calendar', clock()),
                }),
                fakeContext({ clock: clock() }),
            );
            expect(finding.versions).toMatchObject({
                observed: '1.30.0',
                latest: '1.31',
                bump: 'minor',
            });
        });
    });

    describe('validation', () => {
        it('should throw rather than emit a finding with no evidence [REQ-EVI-001]', () => {
            expect(() =>
                buildFinding(input({ evidence: [] }), fakeContext({ clock: clock() })),
            ).toThrow(InternalError);
        });

        it('should name the offending field when the contract is violated', () => {
            expect(() =>
                buildFinding(input({ title: '' }), fakeContext({ clock: clock() })),
            ).toThrow(/title/);
        });
    });

    describe('config overrides', () => {
        it('should apply an override matched by id [REQ-SEV-052]', () => {
            const ctx = fakeContext({
                clock: clock(),
                config: {
                    version: 1,
                    severity: {
                        overrides: [
                            {
                                id: 'npm/dependency-outdated/typescript',
                                severity: 'info',
                                reason: 'Upgrade is scheduled for the next quarter.',
                                expiresAt: '2026-12-01',
                            },
                        ],
                    },
                },
            });
            const finding = buildFinding(input(), ctx);
            expect(finding.severity).toMatchObject({
                severity: 'info',
                source: 'config-override',
                modifiers: ['config-override'],
            });
        });
    });
});

describe('resolutionFromSource', () => {
    it('should stamp a resolved answer with the time it was obtained [REQ-EVI-005]', () => {
        const resolution = resolutionFromSource('npm:typescript', fakeResolved('5.9.2'), clock());
        expect(resolution).toEqual({
            status: 'resolved',
            version: '5.9.2',
            ref: 'npm:typescript',
            method: 'github-release',
            confidence: 'high',
            retrievedAt: '2026-09-12T06:00:00.000Z',
            reason: null,
        });
    });

    it('should leave an unresolved answer unstamped and carry its reason', () => {
        const resolution = resolutionFromSource(
            'npm:typescript',
            fakeUnresolved('offline'),
            clock(),
        );
        expect(resolution).toMatchObject({
            status: 'unresolved',
            version: null,
            retrievedAt: null,
            reason: 'offline',
        });
    });
});

describe('notApplicableResolution', () => {
    it('should record certainty about there being nothing to resolve', () => {
        expect(notApplicableResolution('static-config', 'no upstream')).toEqual({
            status: 'not-applicable',
            version: null,
            ref: null,
            method: 'static-config',
            confidence: 'high',
            retrievedAt: null,
            reason: 'no upstream',
        });
    });
});

describe('calendarResolution', () => {
    it('should resolve from a committed table at medium confidence by default', () => {
        expect(calendarResolution('1.31', 'config#calendar', clock())).toMatchObject({
            status: 'resolved',
            version: '1.31',
            method: 'support-calendar',
            confidence: 'medium',
            retrievedAt: '2026-09-12T06:00:00.000Z',
        });
    });

    it('should report a missing entry as unresolved naming the table', () => {
        expect(calendarResolution(null, 'config#calendar', clock())).toMatchObject({
            status: 'unresolved',
            version: null,
            reason: 'No entry in config#calendar.',
        });
    });
});
