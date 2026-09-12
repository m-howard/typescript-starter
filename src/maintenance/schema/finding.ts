/**
 * The collect-stage contract.
 *
 * A Finding states WHAT IS, never WHAT TO DO. Judgement belongs to `EnrichedFinding`,
 * produced by the pass-2 assess stage. `z.strictObject` is what makes that separation
 * mechanical: an `assessment`, `recommendation` or `issue` key on collector output is a
 * parse failure, not something a reviewer has to notice (REQ-SCH-002, REQ-SCH-003).
 */

import { z } from 'zod';
import {
    ConfidenceSchema,
    EvidenceSchema,
    IsoDateSchema,
    IsoDateTimeSchema,
    SemverBumpSchema,
    SeveritySchema,
    ShortHashSchema,
} from './common';
import { CollectorIdSchema } from './collector-run';

/**
 * Fingerprint algorithm version.
 *
 * Bumping it rotates every fingerprint and so orphans every existing issue. That is
 * occasionally the right call, but it must be a deliberate, auditable one.
 */
export const FINGERPRINT_VERSION = 'fp1';

/** Severity rule-table version, recorded on every finding for auditability. */
export const SEVERITY_RULES_VERSION = 'sev1';

/**
 * Longest a finding title may be.
 *
 * Exported because collectors compose titles from text they do not control — an advisory
 * title runs to whatever length its author chose — and must bound them before the
 * contract does it for them by rejecting the whole finding.
 */
export const FINDING_TITLE_MAX_LENGTH = 160;

export const SubjectKindSchema = z
    .enum([
        'npm-package',
        'github-action',
        'container-image',
        'image-tool',
        'helm-chart',
        'k8s-controller',
        'eks-cluster',
        'eks-addon',
        'maintenance-config',
        'collector',
    ])
    .meta({ id: 'SubjectKind' });
export type SubjectKind = z.infer<typeof SubjectKindSchema>;

/** Where a dependency sits, which drives the development-scope severity demotion. */
export const SubjectScopeSchema = z.enum(['runtime', 'dev', 'build', 'infra', 'unknown']);

/** The maintainable thing a finding is about. */
export const SubjectSchema = z
    .strictObject({
        kind: SubjectKindSchema,
        /**
         * Stable identity. Globally-identifiable subjects use their global name
         * (`typescript`, `actions/checkout`); file-scoped subjects are path-qualified
         * but never line-qualified, so reformatting a file cannot orphan an issue.
         */
        id: z.string().min(1),
        displayName: z.string().min(1),
        ecosystem: z.string().nullable(),
        scope: SubjectScopeSchema,
    })
    .meta({ id: 'Subject' });
export type Subject = z.infer<typeof SubjectSchema>;

export const FindingKindSchema = z
    .enum([
        'dependency-outdated',
        'dependency-vulnerable',
        'dependency-deprecated',
        'action-outdated',
        'action-unpinned',
        'image-base-outdated',
        'image-tool-outdated',
        'image-distro-eol',
        'chart-outdated',
        'controller-outdated',
        'cluster-version-outdated',
        'cluster-version-eol',
        'addon-outdated',
        'upstream-unresolved',
        'config-stale',
    ])
    .meta({ id: 'FindingKind' });
export type FindingKind = z.infer<typeof FindingKindSchema>;

/** How a latest version was obtained. Drives the confidence a reader should place in it. */
export const ProvenanceMethodSchema = z
    .enum([
        'npm-registry',
        'github-release',
        'github-tag',
        'oci-registry',
        'helm-oci',
        'static-config',
        'aws-cli',
        'support-calendar',
        'not-attempted',
    ])
    .meta({ id: 'ProvenanceMethod' });

/**
 * Outcome of asking a version source "what is the newest version of this?".
 *
 * `unresolved` is a first-class outcome: a collector that cannot reach an upstream
 * source records that here and still emits the finding (REQ-ERR-030).
 */
export const LatestResolutionSchema = z
    .strictObject({
        status: z.enum(['resolved', 'unresolved', 'not-applicable']),
        version: z.string().nullable(),
        /** The configured source ref, e.g. `github-release:pulumi/pulumi`. */
        ref: z.string().nullable(),
        method: ProvenanceMethodSchema,
        confidence: ConfidenceSchema,
        retrievedAt: IsoDateTimeSchema.nullable(),
        /** Human-readable cause when the status is `unresolved`. */
        reason: z.string().nullable(),
    })
    .meta({ id: 'LatestResolution' });
export type LatestResolution = z.infer<typeof LatestResolutionSchema>;

export const VersionsSchema = z
    .strictObject({
        /** Literally what the file says: `^5.7.3`, `v4`, `bullseye`, `1.31`. */
        declared: z.string().nullable(),
        /** Normalised current version: `5.7.3`, `4.0.0`, `1.31.0`. */
        observed: z.string().nullable(),
        latest: z.string().nullable(),
        bump: SemverBumpSchema,
        majorsBehind: z.number().int().nonnegative().nullable(),
    })
    .meta({ id: 'Versions' });
export type Versions = z.infer<typeof VersionsSchema>;

export const AdvisorySchema = z
    .strictObject({
        id: z.string().min(1),
        source: z.enum(['npm-audit', 'github-advisory']),
        severity: z.enum(['critical', 'high', 'moderate', 'low', 'info']),
        /**
         * Carried as evidence for the human. Deliberately not a severity rule input:
         * the advisory severity already encodes it, and feeding both produces
         * contradictory ladders (REQ-SEV-055).
         */
        cvssScore: z.number().min(0).max(10).nullable(),
        cvssVector: z.string().nullable(),
        cwe: z.array(z.string()),
        title: z.string().min(1),
        url: z.url().nullable(),
        vulnerableRange: z.string().nullable(),
        isDirect: z.boolean(),
        fixAvailable: z.boolean(),
        fixedVersion: z.string().nullable(),
        fixIsSemverMajor: z.boolean().nullable(),
    })
    .meta({ id: 'Advisory' });
export type Advisory = z.infer<typeof AdvisorySchema>;

export const LifecycleSchema = z
    .strictObject({
        endOfStandardSupport: IsoDateSchema.nullable(),
        endOfExtendedSupport: IsoDateSchema.nullable(),
        /** Negative once support has lapsed. Computed against the injected clock. */
        daysUntilEndOfSupport: z.number().int().nullable(),
        deprecated: z.boolean(),
        deprecationMessage: z.string().nullable(),
        /** e.g. `maintenance.config.yaml#collectors.eks.supportCalendar`. */
        calendarSource: z.string().nullable(),
        calendarLastVerified: IsoDateSchema.nullable(),
    })
    .meta({ id: 'Lifecycle' });
export type Lifecycle = z.infer<typeof LifecycleSchema>;

/**
 * The audit trail for how severity was chosen.
 *
 * Records the rule that fired so a reader can disagree with the rule rather than with
 * the number (REQ-SEV-001).
 */
export const SeverityDecisionSchema = z
    .strictObject({
        severity: SeveritySchema,
        ruleId: z.string().min(1),
        ruleVersion: z.literal(SEVERITY_RULES_VERSION),
        /** Post-table adjustments applied in order, e.g. `['dev-scope-demotion']`. */
        modifiers: z.array(z.string()),
        source: z.enum(['rule-table', 'config-override']),
        reason: z.string().min(1),
    })
    .meta({ id: 'SeverityDecision' });
export type SeverityDecision = z.infer<typeof SeverityDecisionSchema>;

/**
 * A single observed maintenance fact.
 *
 * Strict by construction — see the module comment. Note the root report schema is
 * deliberately *not* given a `.meta({ id })`, but this one is, so consumers can
 * `$ref` it out of `$defs`.
 */
export const FindingSchema = z
    .strictObject({
        /** Human-readable stable slug, e.g. `npm/outdated/typescript`. */
        id: z.string().regex(/^[a-z0-9][a-z0-9/_.\-@]*$/),
        /** Identity. Stable while the subject exists, regardless of version movement. */
        fingerprint: ShortHashSchema,
        fingerprintVersion: z.literal(FINGERPRINT_VERSION),
        /** Mutable facts. Changes when versions, severity or resolution state change. */
        stateHash: ShortHashSchema,
        collector: CollectorIdSchema,
        kind: FindingKindSchema,
        subject: SubjectSchema,
        title: z.string().min(1).max(FINDING_TITLE_MAX_LENGTH),
        detail: z.string().min(1),
        versions: VersionsSchema,
        latestResolution: LatestResolutionSchema,
        severity: SeverityDecisionSchema,
        advisory: AdvisorySchema.nullable(),
        lifecycle: LifecycleSchema.nullable(),
        /** True when upstream truth could not be established. First-class state. */
        unresolved: z.boolean(),
        /** Mechanical next step only — a command or a file edit. No judgement. */
        remediationHint: z.string().nullable(),
        references: z.array(z.url()),
        evidence: z.array(EvidenceSchema).min(1),
        /** Extra identity axis folded into the fingerprint, e.g. a GHSA id. */
        discriminator: z.string().nullable(),
        tags: z.array(z.string()),
    })
    .meta({
        id: 'Finding',
        title: 'Finding',
        description:
            'An observed maintenance fact emitted by the collect stage. Contains no ' +
            'judgement, recommendation, assessment or issue linkage.',
    });
export type Finding = z.infer<typeof FindingSchema>;
