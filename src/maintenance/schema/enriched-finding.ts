/**
 * The pass-2 contract.
 *
 * Defined now so the collect stage cannot drift away from it, but nothing in pass 1
 * produces one. See `docs/maintenance/pass-2-interface.md`.
 */

import { z } from 'zod';
import { FindingSchema } from './finding';
import { ConfidenceSchema, IsoDateTimeSchema, SeveritySchema } from './common';

/** A source the assess stage consulted, with how far it should be trusted. */
export const AssessmentSourceSchema = z.strictObject({
    url: z.url(),
    title: z.string().min(1),
    trust: z.enum(['official', 'vendor', 'community']),
    retrievedAt: IsoDateTimeSchema,
});

/** Model-authored judgement. Never produced by a collector. */
export const AssessmentSchema = z
    .strictObject({
        verdict: z.enum(['act-now', 'schedule', 'monitor', 'ignore']),
        rationale: z.string().min(1),
        riskNotes: z.string().nullable(),
        /**
         * A model may PROPOSE a different severity; it may never overwrite the computed
         * `severity` (REQ-P2-003). Severity stays machine-derived so it is reproducible
         * and explainable.
         */
        suggestedSeverity: SeveritySchema.nullable(),
        breakingChangeLikelihood: z.enum(['high', 'medium', 'low', 'unknown']),
        complexity: z.enum(['trivial', 'low', 'medium', 'high']),
        upgradeSteps: z.array(z.string()),
        verificationSteps: z.array(z.string()),
        blastRadius: z.array(z.string()),
        /** Every added claim is cited (REQ-P2-004). */
        sources: z.array(AssessmentSourceSchema),
        confidence: ConfidenceSchema,
        model: z.string().min(1),
        generatedAt: IsoDateTimeSchema,
    })
    .meta({ id: 'Assessment' });
export type Assessment = z.infer<typeof AssessmentSchema>;

export const IssueLinkSchema = z
    .strictObject({
        number: z.number().int().positive().nullable(),
        url: z.url().nullable(),
        state: z.enum(['open', 'closed', 'planned']),
        action: z.enum(['created', 'updated', 'reopened', 'unchanged', 'skipped']),
        labels: z.array(z.string()),
    })
    .meta({ id: 'IssueLink' });
export type IssueLink = z.infer<typeof IssueLinkSchema>;

/**
 * A Finding plus the judgement the assess stage added.
 *
 * Both added fields are **optional as well as nullable**, which is a deliberate
 * exception to this schema set's "nullable rather than optional" convention. A
 * collect-stage Finding has no `assessment` key at all, so requiring the key — even a
 * nullable one — would make `EnrichedFinding` reject every real collector finding and
 * break REQ-SCH-007. Absent and null both mean "not assessed".
 *
 * `.extend()` preserves strictness, so an undeclared key is still a parse failure here.
 */
export const EnrichedFindingSchema = FindingSchema.extend({
    assessment: AssessmentSchema.nullable().optional(),
    issue: IssueLinkSchema.nullable().optional(),
}).meta({
    id: 'EnrichedFinding',
    description:
        'A Finding carried through the assess stage unchanged, plus model-authored ' +
        'judgement and issue linkage.',
});
export type EnrichedFinding = z.infer<typeof EnrichedFindingSchema>;
