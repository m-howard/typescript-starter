import {
    COLLECTOR_IDS,
    CollectorErrorCodeSchema,
    CollectorRunSchema,
    EnrichedFindingSchema,
    Finding,
    FindingSchema,
    MaintenanceReportSchema,
    REPORT_SCHEMA_VERSION,
    SEVERITY_RANK,
    Severity,
    SeveritySchema,
} from '../src/maintenance/schema';
import { MAINTENANCE_ERROR_CODES } from '../src/maintenance/errors';

/** A minimal Finding exactly as a collector would emit it. */
function makeFinding(overrides: Partial<Finding> = {}): Finding {
    return {
        id: 'npm/outdated/typescript',
        fingerprint: 'a'.repeat(32),
        fingerprintVersion: 'fp1',
        stateHash: 'b'.repeat(32),
        collector: 'npm',
        kind: 'dependency-outdated',
        subject: {
            kind: 'npm-package',
            id: 'typescript',
            displayName: 'typescript',
            ecosystem: 'npm',
            scope: 'dev',
        },
        title: 'typescript is behind latest',
        detail: 'Declared ^5.7.3, latest is 5.9.2.',
        versions: {
            declared: '^5.7.3',
            observed: '5.7.3',
            latest: '5.9.2',
            bump: 'minor',
            majorsBehind: 0,
        },
        latestResolution: {
            status: 'resolved',
            version: '5.9.2',
            ref: 'npm:typescript',
            method: 'npm-registry',
            confidence: 'high',
            retrievedAt: '2026-09-12T06:00:00.000Z',
            reason: null,
        },
        severity: {
            severity: 'low',
            ruleId: 'SEV-DRIFT-MINOR',
            ruleVersion: 'sev1',
            modifiers: [],
            source: 'rule-table',
            reason: 'Declared version is one minor behind latest.',
        },
        advisory: null,
        lifecycle: null,
        unresolved: false,
        remediationHint: 'npm install --save-dev typescript@5.9.2',
        references: ['https://www.npmjs.com/package/typescript'],
        evidence: [
            {
                type: 'file',
                path: 'package.json',
                line: 63,
                column: 5,
                snippet: '"typescript": "^5.7.3",',
                contentSha256: null,
                repo: null,
                ref: null,
            },
        ],
        discriminator: null,
        tags: ['direct'],
        ...overrides,
    };
}

describe('FindingSchema', () => {
    describe('stage separation', () => {
        it.each([
            ['assessment', { verdict: 'act-now' }],
            ['issue', { number: 1 }],
            ['recommendation', 'upgrade it'],
            ['suggestedSeverity', 'high'],
        ])(
            'should reject a judgement key %s emitted by a collector [REQ-SCH-002]',
            (key: string, value: unknown) => {
                const result = FindingSchema.safeParse({ ...makeFinding(), [key]: value });

                expect(result.success).toBe(false);
            },
        );

        it('should reject any undeclared property [REQ-SCH-003]', () => {
            expect(FindingSchema.safeParse({ ...makeFinding(), typo: 1 }).success).toBe(false);
        });

        it('should accept a well-formed collector finding', () => {
            expect(FindingSchema.safeParse(makeFinding()).success).toBe(true);
        });
    });

    describe('evidence', () => {
        it('should require at least one evidence record [REQ-EVI-001]', () => {
            expect(FindingSchema.safeParse(makeFinding({ evidence: [] })).success).toBe(false);
        });

        it.each([
            [
                'command',
                {
                    type: 'command' as const,
                    argv: ['npm', 'outdated', '--json'],
                    cwd: '/repo',
                    exitCode: 1,
                    durationMs: 820,
                    stdoutSha256: null,
                    stderrExcerpt: null,
                },
            ],
            [
                'http',
                {
                    type: 'http' as const,
                    url: 'https://registry.npmjs.org/typescript',
                    method: 'GET' as const,
                    status: 200,
                    retrievedAt: '2026-09-12T06:00:00.000Z',
                    etag: null,
                    fromCache: false,
                },
            ],
        ])('should accept %s evidence [REQ-EVI-003, REQ-EVI-004]', (_label, evidence) => {
            expect(FindingSchema.safeParse(makeFinding({ evidence: [evidence] })).success).toBe(
                true,
            );
        });

        it('should reject an evidence variant with an unknown discriminator', () => {
            const evidence = [{ type: 'guess', path: 'package.json' }] as never;

            expect(FindingSchema.safeParse(makeFinding({ evidence })).success).toBe(false);
        });
    });

    describe('identity fields', () => {
        it.each([
            ['too short', 'abc'],
            ['too long', 'a'.repeat(33)],
            ['not hex', 'z'.repeat(32)],
        ])('should reject a fingerprint that is %s', (_label, fingerprint: string) => {
            expect(FindingSchema.safeParse(makeFinding({ fingerprint })).success).toBe(false);
        });

        it('should reject an id that is not a lowercase slug', () => {
            expect(FindingSchema.safeParse(makeFinding({ id: 'NPM/Outdated' })).success).toBe(
                false,
            );
        });

        it('should pin the fingerprint algorithm version [REQ-ID-007]', () => {
            const wrongVersion = { ...makeFinding(), fingerprintVersion: 'fp2' };

            expect(FindingSchema.safeParse(wrongVersion).success).toBe(false);
        });
    });

    describe('unresolved findings', () => {
        it('should accept a null latest with a reason, rather than requiring a value', () => {
            const unresolved = makeFinding({
                unresolved: true,
                versions: {
                    declared: '^5.7.3',
                    observed: '5.7.3',
                    latest: null,
                    bump: 'unknown',
                    majorsBehind: null,
                },
                latestResolution: {
                    status: 'unresolved',
                    version: null,
                    ref: 'npm:typescript',
                    method: 'not-attempted',
                    confidence: 'low',
                    retrievedAt: null,
                    reason: 'Offline mode is active',
                },
            });

            expect(FindingSchema.safeParse(unresolved).success).toBe(true);
        });
    });
});

describe('EnrichedFindingSchema', () => {
    it('should accept a collector Finding unchanged, with assessment absent [REQ-SCH-007]', () => {
        const result = EnrichedFindingSchema.safeParse(makeFinding());

        expect(result.success).toBe(true);
    });

    it('should accept every Finding the collect stage can emit [REQ-SCH-007]', () => {
        const variants: Finding[] = [
            makeFinding(),
            makeFinding({ unresolved: true, advisory: null }),
            makeFinding({ discriminator: 'GHSA-4x5r-pxfx-6jf8', kind: 'dependency-vulnerable' }),
            makeFinding({ tags: [], references: [] }),
        ];

        for (const variant of variants) {
            expect(FindingSchema.safeParse(variant).success).toBe(true);
            expect(EnrichedFindingSchema.safeParse(variant).success).toBe(true);
        }
    });

    it('should accept a null assessment', () => {
        const enriched = { ...makeFinding(), assessment: null, issue: null };

        expect(EnrichedFindingSchema.safeParse(enriched).success).toBe(true);
    });

    it('should accept a populated assessment that Finding rejects', () => {
        const assessment = {
            verdict: 'schedule' as const,
            rationale: 'Minor bump with no breaking changes noted.',
            riskNotes: null,
            suggestedSeverity: null,
            breakingChangeLikelihood: 'low' as const,
            complexity: 'trivial' as const,
            upgradeSteps: ['npm install --save-dev typescript@5.9.2'],
            verificationSteps: ['npm run build', 'npm test'],
            blastRadius: ['build'],
            sources: [
                {
                    url: 'https://github.com/microsoft/TypeScript/releases',
                    title: 'TypeScript releases',
                    trust: 'official' as const,
                    retrievedAt: '2026-09-12T06:05:00.000Z',
                },
            ],
            confidence: 'high' as const,
            model: 'github-copilot',
            generatedAt: '2026-09-12T06:05:00.000Z',
        };

        expect(EnrichedFindingSchema.safeParse({ ...makeFinding(), assessment }).success).toBe(
            true,
        );
        expect(FindingSchema.safeParse({ ...makeFinding(), assessment }).success).toBe(false);
    });

    it('should still reject an undeclared key, so extend does not open the contract', () => {
        const enriched = { ...makeFinding(), assessment: null, bogus: 1 };

        expect(EnrichedFindingSchema.safeParse(enriched).success).toBe(false);
    });
});

describe('SeveritySchema', () => {
    it('should rank every severity it declares', () => {
        for (const severity of SeveritySchema.options) {
            expect(typeof SEVERITY_RANK[severity]).toBe('number');
        }
    });

    it('should rank critical above info', () => {
        const descending: Severity[] = ['critical', 'high', 'medium', 'low', 'info'];

        for (let i = 0; i < descending.length - 1; i += 1) {
            expect(SEVERITY_RANK[descending[i]]).toBeGreaterThan(SEVERITY_RANK[descending[i + 1]]);
        }
    });
});

describe('CollectorRunSchema', () => {
    const run = {
        collector: 'npm' as const,
        status: 'partial' as const,
        startedAt: '2026-09-12T06:00:00.000Z',
        durationMs: 1200,
        findingCount: 3,
        unresolvedCount: 1,
        errors: [
            {
                code: 'rate-limited' as const,
                message: 'GitHub API rate limit exhausted',
                target: 'github-release:actions/checkout',
                retryable: true,
            },
        ],
        skippedReason: null,
    };

    it('should accept a degraded run carrying structured errors [REQ-ERR-036]', () => {
        expect(CollectorRunSchema.safeParse(run).success).toBe(true);
    });

    it('should share its error codes with the runtime error hierarchy', () => {
        expect(CollectorErrorCodeSchema.options).toEqual([...MAINTENANCE_ERROR_CODES]);
    });

    it('should reject a negative duration', () => {
        expect(CollectorRunSchema.safeParse({ ...run, durationMs: -1 }).success).toBe(false);
    });
});

describe('MaintenanceReportSchema', () => {
    function makeReport(overrides: Record<string, unknown> = {}) {
        return {
            schemaVersion: REPORT_SCHEMA_VERSION,
            stage: 'collect',
            generatedAt: '2026-09-12T06:00:00.000Z',
            repository: {
                name: 'typescript-starter',
                owner: 'm-howard',
                commitSha: 'cf2873e',
                ref: 'refs/heads/main',
            },
            runtime: { node: 'v22.22.2', npm: '10.9.7', platform: 'linux', offline: false },
            config: { path: 'maintenance.config.yaml', sha256: 'c'.repeat(64), version: 1 },
            collectorRuns: [],
            findings: [makeFinding()],
            summary: {
                totalFindings: 1,
                bySeverity: { critical: 0, high: 0, medium: 0, low: 1, info: 0 },
                byCollector: { npm: 1, 'github-actions': 0, arc: 0, eks: 0, images: 0 },
                unresolvedCount: 0,
                worstStatus: 'ok',
            },
            ...overrides,
        };
    }

    it('should round-trip a complete report [REQ-SCH-001]', () => {
        const result = MaintenanceReportSchema.safeParse(makeReport());

        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.data.findings[0].subject.id).toBe('typescript');
        }
    });

    it('should pin stage to collect, so assess output cannot masquerade as collect', () => {
        expect(MaintenanceReportSchema.safeParse(makeReport({ stage: 'assess' })).success).toBe(
            false,
        );
    });

    it('should reject an undeclared top-level property', () => {
        expect(MaintenanceReportSchema.safeParse(makeReport({ extra: true })).success).toBe(false);
    });

    it('should require a summary bucket for every collector', () => {
        const summary = {
            totalFindings: 0,
            bySeverity: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
            byCollector: { npm: 0 },
            unresolvedCount: 0,
            worstStatus: 'ok',
        };

        expect(MaintenanceReportSchema.safeParse(makeReport({ summary })).success).toBe(false);
    });

    it('should cover every collector id in the summary shape', () => {
        const result = MaintenanceReportSchema.safeParse(makeReport());

        expect(result.success).toBe(true);
        if (result.success) {
            expect(Object.keys(result.data.summary.byCollector).sort()).toEqual(
                [...COLLECTOR_IDS].sort(),
            );
        }
    });
});
