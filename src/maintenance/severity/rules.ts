/**
 * The deterministic severity rule table.
 *
 * Severity is the number people act on, so it is computed here rather than by a model:
 * identical facts always yield an identical severity, and every finding records which
 * rule fired so a reader can disagree with the rule rather than with the tool
 * (`docs/maintenance/adr/0006-deterministic-severity.md`).
 *
 * The table is ordered by non-increasing severity tier. That ordering is the
 * correctness property — order by topic instead and a "moderate advisory" rule shadows
 * "three majors behind" (REQ-SEV-002). A spec asserts the ordering holds.
 */

import { SEVERITY_RANK, Severity, SeverityDecision } from '../schema';
import { SEVERITY_RULES_VERSION } from '../schema/finding';
import { Clock, daysUntil } from '../clock';
import { DerivedSeverityFacts, SeverityFacts, SeverityOverride } from './facts';

export interface SeverityRule {
    id: string;
    severity: Severity;
    /** Why this rule fired, rendered into the decision for a human reader. */
    describe: (facts: DerivedSeverityFacts) => string;
    matches: (facts: DerivedSeverityFacts) => boolean;
}

/**
 * Severity tiers ordered most to least severe.
 *
 * Derived from {@link SEVERITY_RANK} rather than restated, so the two cannot disagree.
 */
const SEVERITY_LADDER: readonly Severity[] = (Object.keys(SEVERITY_RANK) as Severity[]).sort(
    (a, b) => SEVERITY_RANK[b] - SEVERITY_RANK[a],
);

/** Days-until-support-ends thresholds, ordered most to least urgent. */
const EOL_IMMINENT_DAYS = 30;
const EOL_SOON_DAYS = 90;

/**
 * The outermost end-of-support threshold the table reacts to.
 *
 * Exported because a collector needs the same horizon to decide whether an
 * end-of-life finding is worth emitting at all. Beyond it there is nothing to act on,
 * and a finding whose kind names a condition that does not hold is noise (REQ-SCH-009).
 * One constant, so the table and the collectors cannot disagree about where the
 * horizon sits.
 */
export const EOL_HORIZON_DAYS = 180;

/** Majors behind at which drift stops being routine. */
const MAJORS_BEHIND_URGENT = 2;

const eolWithin = (days: number) => (facts: DerivedSeverityFacts) =>
    facts.eolDays !== null && facts.eolDays <= days;

const describeEol = (facts: DerivedSeverityFacts): string =>
    facts.eolDays !== null && facts.eolDays <= 0
        ? `End of standard support passed ${Math.abs(facts.eolDays)} days ago.`
        : `End of standard support is ${facts.eolDays} days away.`;

const describeAdvisory = (facts: DerivedSeverityFacts): string =>
    `A ${facts.advisorySeverity} severity advisory affects this subject.`;

/**
 * Applied before the table.
 *
 * If upstream truth could not be established there is no basis to claim impact. The
 * finding still exists and still counts toward `unresolvedCount`; it just may not shout
 * (REQ-SEV-004).
 */
export const UNRESOLVED_RULE_ID = 'SEV-UNRESOLVED';

/**
 * Rules whose severity is exempt from development-scope demotion.
 *
 * An end-of-life build image bites you regardless of whether the thing that pulled it
 * in was a development dependency.
 */
const EOL_RULE_IDS: ReadonlySet<string> = new Set([
    'SEV-EOL-PAST',
    'SEV-EOL-SOON-30',
    'SEV-EOL-SOON-90',
    'SEV-EOL-SOON-180',
]);

/** First match wins. Ordered by non-increasing severity tier. */
export const SEVERITY_RULES: readonly SeverityRule[] = Object.freeze([
    {
        id: 'SEV-EOL-PAST',
        severity: 'critical',
        matches: (f) => f.eolDays !== null && f.eolDays <= 0,
        describe: describeEol,
    },
    {
        id: 'SEV-VULN-CRITICAL',
        severity: 'critical',
        matches: (f) => f.advisorySeverity === 'critical',
        describe: describeAdvisory,
    },
    {
        id: 'SEV-EOL-SOON-30',
        severity: 'high',
        matches: eolWithin(EOL_IMMINENT_DAYS),
        describe: describeEol,
    },
    {
        id: 'SEV-VULN-HIGH',
        severity: 'high',
        matches: (f) => f.advisorySeverity === 'high',
        describe: describeAdvisory,
    },
    {
        id: 'SEV-ACTION-UNPINNED-3P',
        severity: 'high',
        matches: (f) => f.kind === 'action-unpinned' && !f.isFirstPartyAction,
        describe: () =>
            'A third-party action is referenced by a mutable tag, which is a supply-chain exposure.',
    },
    {
        id: 'SEV-DRIFT-MAJOR-MULTI',
        severity: 'high',
        matches: (f) =>
            f.bump === 'major' && f.majorsBehind !== null && f.majorsBehind >= MAJORS_BEHIND_URGENT,
        describe: (f) => `Declared version is ${f.majorsBehind} major versions behind latest.`,
    },
    {
        id: 'SEV-EOL-SOON-90',
        severity: 'medium',
        matches: eolWithin(EOL_SOON_DAYS),
        describe: describeEol,
    },
    {
        id: 'SEV-VULN-MODERATE',
        severity: 'medium',
        matches: (f) => f.advisorySeverity === 'moderate',
        describe: describeAdvisory,
    },
    {
        id: 'SEV-DEPRECATED',
        severity: 'medium',
        matches: (f) => f.deprecated,
        describe: () => 'The subject is deprecated upstream.',
    },
    {
        id: 'SEV-DRIFT-MAJOR',
        severity: 'medium',
        matches: (f) => f.bump === 'major',
        describe: () => 'Declared version is a major version behind latest.',
    },
    {
        id: 'SEV-DRIFT-ZEROMAJOR',
        severity: 'medium',
        matches: (f) => f.zeroMajor && (f.bump === 'minor' || f.bump === 'major'),
        describe: () =>
            'A pre-1.0 dependency is behind by a minor version, which is where a 0.x ' +
            'project publishes breaking changes.',
    },
    {
        id: 'SEV-CONFIG-STALE',
        severity: 'medium',
        matches: (f) => f.kind === 'config-stale',
        describe: () => 'The scan configuration has not been verified recently.',
    },
    {
        id: 'SEV-VULN-LOW',
        severity: 'low',
        matches: (f) => f.advisorySeverity === 'low' || f.advisorySeverity === 'info',
        describe: describeAdvisory,
    },
    {
        id: 'SEV-ACTION-UNPINNED-1P',
        severity: 'low',
        matches: (f) => f.kind === 'action-unpinned',
        describe: () =>
            'A first-party action is referenced by a mutable tag, which GitHub controls.',
    },
    {
        id: 'SEV-EOL-SOON-180',
        severity: 'low',
        matches: eolWithin(EOL_HORIZON_DAYS),
        describe: describeEol,
    },
    {
        id: 'SEV-DRIFT-MINOR',
        severity: 'low',
        matches: (f) => f.bump === 'minor',
        describe: () => 'Declared version is one or more minor versions behind latest.',
    },
    {
        id: 'SEV-DRIFT-PATCH',
        severity: 'low',
        matches: (f) => f.bump === 'patch' || f.bump === 'prerelease',
        describe: () => 'Declared version is behind latest by a patch or prerelease.',
    },
    {
        id: 'SEV-CURRENT',
        severity: 'info',
        matches: (f) => f.bump === 'none',
        describe: () => 'Declared version matches latest.',
    },
    {
        id: 'SEV-DEFAULT',
        severity: 'info',
        matches: () => true,
        describe: () => 'No severity rule matched more specifically.',
    },
]);

export interface ComputeSeverityOptions {
    clock: Clock;
    /** Overrides from configuration. Expired ones are ignored (REQ-SEV-054). */
    overrides?: readonly SeverityOverride[];
    /** The finding's id, for override matching. */
    findingId?: string;
    /** The finding's fingerprint, for override matching. */
    fingerprint?: string;
}

/**
 * Resolve the severity of a finding.
 *
 * Pure apart from reading the current date through the injected clock, so severity
 * specs do not rot as end-of-support dates pass.
 */
export function computeSeverity(
    facts: SeverityFacts,
    options: ComputeSeverityOptions,
): SeverityDecision {
    const derived = deriveFacts(facts, options.clock);
    const base = derived.unresolved
        ? {
              severity: 'info' as Severity,
              ruleId: UNRESOLVED_RULE_ID,
              reason: 'Upstream truth could not be established, so no impact is claimed.',
          }
        : matchRule(derived);

    const modifiers: string[] = [];
    let severity = base.severity;

    if (shouldDemoteForScope(derived, base.ruleId, severity)) {
        severity = demoteOneTier(severity);
        modifiers.push('dev-scope-demotion');
    }

    const override = findActiveOverride(options);
    if (override) {
        modifiers.push('config-override');
        return {
            severity: override.severity,
            ruleId: base.ruleId,
            ruleVersion: SEVERITY_RULES_VERSION,
            modifiers,
            source: 'config-override',
            reason: override.reason,
        };
    }

    return {
        severity,
        ruleId: base.ruleId,
        ruleVersion: SEVERITY_RULES_VERSION,
        modifiers,
        source: 'rule-table',
        reason: base.reason,
    };
}

/** Resolve the clock-dependent fact once, so every rule sees the same value. */
export function deriveFacts(facts: SeverityFacts, clock: Clock): DerivedSeverityFacts {
    return {
        ...facts,
        eolDays: facts.endOfSupport === null ? null : daysUntil(clock, facts.endOfSupport),
    };
}

/**
 * Overrides whose expiry has passed.
 *
 * Returned rather than acted on here, so the runner can raise a `config-stale` finding
 * naming each one while `computeSeverity` stays a pure function (REQ-SEV-054).
 */
export function findExpiredOverrides(
    overrides: readonly SeverityOverride[],
    clock: Clock,
): SeverityOverride[] {
    return overrides.filter((override) => isExpired(override, clock));
}

function matchRule(facts: DerivedSeverityFacts): {
    severity: Severity;
    ruleId: string;
    reason: string;
} {
    for (const rule of SEVERITY_RULES) {
        if (rule.matches(facts)) {
            return { severity: rule.severity, ruleId: rule.id, reason: rule.describe(facts) };
        }
    }
    /* istanbul ignore next -- SEV-DEFAULT matches unconditionally, so this is unreachable. */
    throw new Error('No severity rule matched, which SEV-DEFAULT should make impossible');
}

/**
 * A critical advisory in a development-only tool is not a production incident, so
 * development-scope findings step down exactly one tier — except for end-of-life rules
 * (REQ-SEV-050, REQ-SEV-051).
 */
function shouldDemoteForScope(
    facts: DerivedSeverityFacts,
    ruleId: string,
    severity: Severity,
): boolean {
    return (
        facts.scope === 'dev' &&
        !EOL_RULE_IDS.has(ruleId) &&
        SEVERITY_RANK[severity] > SEVERITY_RANK.low
    );
}

/**
 * Step down exactly one tier.
 *
 * The `low` floor is enforced by {@link shouldDemoteForScope}, which only demotes a
 * severity ranked above `low` — so the tier below always exists and is never beneath
 * `low`. Clamping again here would be a second, unreachable guard.
 */
function demoteOneTier(severity: Severity): Severity {
    return SEVERITY_LADDER[SEVERITY_LADDER.indexOf(severity) + 1];
}

function findActiveOverride(options: ComputeSeverityOptions): SeverityOverride | undefined {
    return (options.overrides ?? []).find(
        (override) => matchesOverride(override, options) && !isExpired(override, options.clock),
    );
}

function matchesOverride(override: SeverityOverride, options: ComputeSeverityOptions): boolean {
    if (override.fingerprint !== undefined && override.fingerprint === options.fingerprint) {
        return true;
    }
    return override.id !== undefined && override.id === options.findingId;
}

function isExpired(override: SeverityOverride, clock: Clock): boolean {
    return daysUntil(clock, override.expiresAt) < 0;
}
