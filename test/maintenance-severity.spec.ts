import { FixedClock } from '../src/maintenance/clock';
import { SEVERITY_RANK, Severity } from '../src/maintenance/schema';
import {
    SEVERITY_RULES,
    UNRESOLVED_RULE_ID,
    computeSeverity,
    deriveFacts,
    findExpiredOverrides,
} from '../src/maintenance/severity/rules';
import { SeverityFacts, SeverityOverride } from '../src/maintenance/severity/facts';

const NOW = '2026-09-12T06:00:00.000Z';
const clock = new FixedClock(NOW);

/** Facts that match nothing but SEV-DEFAULT, so each case turns on one axis. */
function makeFacts(overrides: Partial<SeverityFacts> = {}): SeverityFacts {
    return {
        kind: 'dependency-outdated',
        unresolved: false,
        bump: 'unknown',
        majorsBehind: null,
        zeroMajor: false,
        advisorySeverity: null,
        deprecated: false,
        endOfSupport: null,
        scope: 'runtime',
        isFirstPartyAction: false,
        ...overrides,
    };
}

/** An ISO date the given number of days from the fixed clock. */
function daysFromNow(days: number): string {
    const date = new Date(new Date(NOW).getTime() + days * 24 * 60 * 60 * 1000);
    return date.toISOString().slice(0, 10);
}

describe('SEVERITY_RULES table', () => {
    it('should be ordered by non-increasing severity tier [REQ-SEV-002]', () => {
        // The correctness property of the table: order by topic instead and a
        // "moderate advisory" rule shadows "three majors behind".
        for (let i = 0; i < SEVERITY_RULES.length - 1; i += 1) {
            const current = SEVERITY_RANK[SEVERITY_RULES[i].severity];
            const next = SEVERITY_RANK[SEVERITY_RULES[i + 1].severity];

            expect(current).toBeGreaterThanOrEqual(next);
        }
    });

    it('should give every rule a unique id', () => {
        const ids = SEVERITY_RULES.map((rule) => rule.id);

        expect(new Set(ids).size).toBe(ids.length);
    });

    it('should end with a rule that matches unconditionally', () => {
        const last = SEVERITY_RULES[SEVERITY_RULES.length - 1];

        expect(last.id).toBe('SEV-DEFAULT');
        expect(last.matches(deriveFacts(makeFacts(), clock))).toBe(true);
    });
});

describe('computeSeverity', () => {
    describe('the rule table', () => {
        const cases: ReadonlyArray<[string, Partial<SeverityFacts>, Severity]> = [
            ['SEV-EOL-PAST', { endOfSupport: daysFromNow(-12) }, 'critical'],
            ['SEV-VULN-CRITICAL', { advisorySeverity: 'critical' }, 'critical'],
            ['SEV-EOL-SOON-30', { endOfSupport: daysFromNow(20) }, 'high'],
            ['SEV-VULN-HIGH', { advisorySeverity: 'high' }, 'high'],
            [
                'SEV-ACTION-UNPINNED-3P',
                { kind: 'action-unpinned', isFirstPartyAction: false },
                'high',
            ],
            ['SEV-DRIFT-MAJOR-MULTI', { bump: 'major', majorsBehind: 3 }, 'high'],
            ['SEV-EOL-SOON-90', { endOfSupport: daysFromNow(75) }, 'medium'],
            ['SEV-VULN-MODERATE', { advisorySeverity: 'moderate' }, 'medium'],
            ['SEV-DEPRECATED', { deprecated: true }, 'medium'],
            ['SEV-DRIFT-MAJOR', { bump: 'major', majorsBehind: 1 }, 'medium'],
            ['SEV-DRIFT-ZEROMAJOR', { bump: 'minor', zeroMajor: true }, 'medium'],
            ['SEV-CONFIG-STALE', { kind: 'config-stale' }, 'medium'],
            ['SEV-VULN-LOW', { advisorySeverity: 'low' }, 'low'],
            [
                'SEV-ACTION-UNPINNED-1P',
                { kind: 'action-unpinned', isFirstPartyAction: true },
                'low',
            ],
            ['SEV-EOL-SOON-180', { endOfSupport: daysFromNow(150) }, 'low'],
            ['SEV-DRIFT-MINOR', { bump: 'minor' }, 'low'],
            ['SEV-DRIFT-PATCH', { bump: 'patch' }, 'low'],
            ['SEV-CURRENT', { bump: 'none' }, 'info'],
            ['SEV-DEFAULT', {}, 'info'],
        ];

        it.each(cases)(
            'should apply %s [REQ-SEV-001, REQ-SEV-003]',
            (ruleId: string, facts: Partial<SeverityFacts>, expected: Severity) => {
                const decision = computeSeverity(makeFacts(facts), { clock });

                expect(decision.ruleId).toBe(ruleId);
                expect(decision.severity).toBe(expected);
            },
        );

        it('should exercise every rule in the table, so none is dead', () => {
            const exercised = new Set(cases.map(([ruleId]) => ruleId));
            const declared = SEVERITY_RULES.map((rule) => rule.id);

            expect(declared.filter((id) => !exercised.has(id))).toEqual([]);
        });

        it('should record the rule version and a human-readable reason', () => {
            const decision = computeSeverity(makeFacts({ advisorySeverity: 'critical' }), {
                clock,
            });

            expect(decision.ruleVersion).toBe('sev1');
            expect(decision.source).toBe('rule-table');
            expect(decision.reason.length).toBeGreaterThan(0);
        });

        it('should prefer the higher tier when two rules could match', () => {
            // A moderate advisory must not shadow multi-major drift.
            const decision = computeSeverity(
                makeFacts({ advisorySeverity: 'moderate', bump: 'major', majorsBehind: 3 }),
                { clock },
            );

            expect(decision.ruleId).toBe('SEV-DRIFT-MAJOR-MULTI');
            expect(decision.severity).toBe('high');
        });

        it('should treat an end-of-support date exactly today as passed', () => {
            const decision = computeSeverity(makeFacts({ endOfSupport: daysFromNow(0) }), {
                clock,
            });

            expect(decision.ruleId).toBe('SEV-EOL-PAST');
        });

        it('should score a pre-1.0 minor bump above a stable one', () => {
            // ARC 0.10.1 -> 0.14.2 reports as a minor, but 0.x is where a project
            // publishes breaking changes, so `low` would understate it.
            const preRelease = computeSeverity(makeFacts({ bump: 'minor', zeroMajor: true }), {
                clock,
            });
            const stable = computeSeverity(makeFacts({ bump: 'minor', zeroMajor: false }), {
                clock,
            });

            expect(preRelease.severity).toBe('medium');
            expect(stable.severity).toBe('low');
        });

        it('should leave a pre-1.0 patch bump as routine', () => {
            const decision = computeSeverity(makeFacts({ bump: 'patch', zeroMajor: true }), {
                clock,
            });

            expect(decision.ruleId).toBe('SEV-DRIFT-PATCH');
        });

        it('should not fire an end-of-life rule beyond the widest window', () => {
            const decision = computeSeverity(makeFacts({ endOfSupport: daysFromNow(400) }), {
                clock,
            });

            expect(decision.ruleId).toBe('SEV-DEFAULT');
        });
    });

    describe('unresolved findings', () => {
        it('should force info before the table runs [REQ-SEV-004]', () => {
            const decision = computeSeverity(
                makeFacts({ unresolved: true, advisorySeverity: 'critical' }),
                { clock },
            );

            expect(decision.severity).toBe('info');
            expect(decision.ruleId).toBe(UNRESOLVED_RULE_ID);
        });

        it('should explain why no impact is claimed', () => {
            const decision = computeSeverity(makeFacts({ unresolved: true }), { clock });

            expect(decision.reason).toMatch(/could not be established/i);
        });
    });

    describe('development-scope demotion', () => {
        it('should step down exactly one tier [REQ-SEV-050]', () => {
            const decision = computeSeverity(
                makeFacts({ advisorySeverity: 'critical', scope: 'dev' }),
                { clock },
            );

            expect(decision.severity).toBe('high');
            expect(decision.modifiers).toContain('dev-scope-demotion');
        });

        it('should floor at low rather than reaching info [REQ-SEV-051]', () => {
            const decision = computeSeverity(makeFacts({ bump: 'major', scope: 'dev' }), {
                clock,
            });

            expect(decision.severity).toBe('low');
        });

        it('should not demote a finding already at low', () => {
            const decision = computeSeverity(makeFacts({ bump: 'minor', scope: 'dev' }), {
                clock,
            });

            expect(decision.severity).toBe('low');
            expect(decision.modifiers).toEqual([]);
        });

        it.each([
            ['SEV-EOL-PAST', daysFromNow(-1), 'critical'],
            ['SEV-EOL-SOON-30', daysFromNow(10), 'high'],
            ['SEV-EOL-SOON-90', daysFromNow(60), 'medium'],
        ])(
            'should exempt %s, because an EOL image bites regardless of scope',
            (ruleId: string, endOfSupport: string, expected: string) => {
                const decision = computeSeverity(makeFacts({ endOfSupport, scope: 'dev' }), {
                    clock,
                });

                expect(decision.ruleId).toBe(ruleId);
                expect(decision.severity).toBe(expected);
                expect(decision.modifiers).toEqual([]);
            },
        );

        it.each([['runtime'], ['build'], ['infra'], ['unknown']] as const)(
            'should not demote %s scope',
            (scope) => {
                const decision = computeSeverity(
                    makeFacts({ advisorySeverity: 'critical', scope }),
                    { clock },
                );

                expect(decision.severity).toBe('critical');
            },
        );
    });

    describe('configuration overrides', () => {
        const override: SeverityOverride = {
            id: 'npm/dependency-vulnerable/@clerk/clerk-sdk-node',
            severity: 'low',
            reason: 'Dev-only SDK slated for removal; tracked in RUNNER-412.',
            expiresAt: daysFromNow(30),
        };

        it('should apply a live override and record its source [REQ-SEV-052]', () => {
            const decision = computeSeverity(makeFacts({ advisorySeverity: 'critical' }), {
                clock,
                overrides: [override],
                findingId: override.id,
            });

            expect(decision.severity).toBe('low');
            expect(decision.source).toBe('config-override');
            expect(decision.reason).toBe(override.reason);
            expect(decision.modifiers).toContain('config-override');
        });

        it('should match by fingerprint as well as by id', () => {
            const byFingerprint: SeverityOverride = {
                fingerprint: 'a'.repeat(32),
                severity: 'info',
                reason: 'Accepted risk.',
                expiresAt: daysFromNow(10),
            };
            const decision = computeSeverity(makeFacts({ advisorySeverity: 'high' }), {
                clock,
                overrides: [byFingerprint],
                fingerprint: 'a'.repeat(32),
            });

            expect(decision.severity).toBe('info');
        });

        it('should ignore an expired override [REQ-SEV-054]', () => {
            // A permanent override is how a maintenance queue goes silently blind.
            const expired = { ...override, expiresAt: daysFromNow(-1) };
            const decision = computeSeverity(makeFacts({ advisorySeverity: 'critical' }), {
                clock,
                overrides: [expired],
                findingId: override.id,
            });

            expect(decision.severity).toBe('critical');
            expect(decision.source).toBe('rule-table');
            expect(decision.modifiers).not.toContain('config-override');
        });

        it('should ignore an override that matches nothing', () => {
            const decision = computeSeverity(makeFacts({ advisorySeverity: 'high' }), {
                clock,
                overrides: [override],
                findingId: 'npm/dependency-outdated/typescript',
            });

            expect(decision.severity).toBe('high');
            expect(decision.source).toBe('rule-table');
        });

        it('should still record the rule that would have fired', () => {
            const decision = computeSeverity(makeFacts({ advisorySeverity: 'critical' }), {
                clock,
                overrides: [override],
                findingId: override.id,
            });

            expect(decision.ruleId).toBe('SEV-VULN-CRITICAL');
        });
    });

    describe('purity', () => {
        it('should read the date only from the injected clock [REQ-SEV-005]', () => {
            const early = new FixedClock('2026-09-12T00:00:00.000Z');
            const late = new FixedClock('2026-09-12T23:59:00.000Z');
            const facts = makeFacts({ endOfSupport: '2026-11-26' });

            expect(computeSeverity(facts, { clock: early })).toEqual(
                computeSeverity(facts, { clock: late }),
            );
        });

        it('should change verdict as the clock advances toward an end-of-support date', () => {
            const facts = makeFacts({ endOfSupport: daysFromNow(100) });
            const later = new FixedClock(NOW);
            later.advanceDays(50);

            expect(computeSeverity(facts, { clock }).ruleId).toBe('SEV-EOL-SOON-180');
            expect(computeSeverity(facts, { clock: later }).ruleId).toBe('SEV-EOL-SOON-90');
        });

        it('should not mutate the facts it is given', () => {
            const facts = makeFacts({ endOfSupport: daysFromNow(10) });
            const snapshot = JSON.stringify(facts);

            computeSeverity(facts, { clock });

            expect(JSON.stringify(facts)).toBe(snapshot);
        });
    });
});

describe('findExpiredOverrides', () => {
    it('should return only the overrides past their expiry [REQ-SEV-054]', () => {
        const live: SeverityOverride = {
            id: 'a',
            severity: 'low',
            reason: 'live',
            expiresAt: daysFromNow(1),
        };
        const expired: SeverityOverride = {
            id: 'b',
            severity: 'low',
            reason: 'expired',
            expiresAt: daysFromNow(-1),
        };

        expect(findExpiredOverrides([live, expired], clock)).toEqual([expired]);
    });

    it('should treat an override expiring today as still live', () => {
        const today: SeverityOverride = {
            id: 'a',
            severity: 'low',
            reason: 'today',
            expiresAt: daysFromNow(0),
        };

        expect(findExpiredOverrides([today], clock)).toEqual([]);
    });

    it('should return an empty array when nothing is configured', () => {
        expect(findExpiredOverrides([], clock)).toEqual([]);
    });
});
