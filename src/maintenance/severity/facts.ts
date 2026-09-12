/**
 * The input to severity evaluation.
 *
 * Pure data, assembled by a collector from what it observed. Keeping it separate from
 * the rule table is what lets the rules be a total function of their inputs with no
 * I/O and no hidden state (REQ-SEV-005).
 */

import { FindingKind, SemverBump } from '../schema';
import { SubjectScopeSchema } from '../schema/finding';
import { z } from 'zod';

export type SubjectScope = z.infer<typeof SubjectScopeSchema>;

/** Severity as reported by an advisory database, which uses its own ladder. */
export type AdvisorySeverity = 'critical' | 'high' | 'moderate' | 'low' | 'info';

export interface SeverityFacts {
    kind: FindingKind;
    /** True when upstream truth could not be established. Short-circuits the table. */
    unresolved: boolean;
    bump: SemverBump;
    majorsBehind: number | null;
    /**
     * The advisory's own severity, or null when the finding is not advisory-driven.
     * The CVSS score is deliberately not an input — see REQ-SEV-055.
     */
    advisorySeverity: AdvisorySeverity | null;
    deprecated: boolean;
    /** End of standard support as an ISO date, or null when it does not apply. */
    endOfSupport: string | null;
    scope: SubjectScope;
    /**
     * Whether an action is published by GitHub itself.
     *
     * An unpinned `actions/checkout@v4` is a different risk from an unpinned
     * third-party action: GitHub controls the former's tag, so the latter is a
     * supply-chain exposure and the former mostly is not (REQ-SEV-056).
     */
    isFirstPartyAction: boolean;
}

/** Facts with the clock-dependent value resolved once, before the table runs. */
export interface DerivedSeverityFacts extends SeverityFacts {
    /** Whole days until end of support; negative once passed, null when not applicable. */
    eolDays: number | null;
}

/** A severity override declared in configuration. */
export interface SeverityOverride {
    /** Matches `Finding.id`. One of `id` or `fingerprint` must be given. */
    id?: string;
    /** Matches `Finding.fingerprint`. */
    fingerprint?: string;
    severity: import('../schema').Severity;
    /** Why the override exists. Required, so a reviewer can judge it. */
    reason: string;
    /**
     * ISO date after which the override is ignored.
     *
     * Required by design: a permanent override is how a maintenance queue goes
     * silently blind (REQ-SEV-053, REQ-SEV-054).
     */
    expiresAt: string;
}
