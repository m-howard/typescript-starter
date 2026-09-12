/**
 * The one place a Finding is assembled.
 *
 * Composing a finding by hand is around forty lines, and there are five collectors with
 * several finding kinds each. Repeating that is where inconsistency hides: one collector
 * deriving `stateHash` from different fields than another, or marking a finding resolved
 * while `latest` is null. Everything that must be identical across collectors is derived
 * here, and collectors supply only what they actually observed.
 *
 * The result is validated against `FindingSchema` before it is returned, so a collector
 * bug surfaces at the collector rather than as a mysterious rejection at report assembly
 * (REQ-SCH-004).
 */

import {
    Advisory,
    CollectorId,
    Confidence,
    Evidence,
    Finding,
    FindingKind,
    FindingSchema,
    LatestResolution,
    Lifecycle,
    Subject,
} from '../schema';
import { FINGERPRINT_VERSION } from '../schema/finding';
import { buildFindingId, computeFingerprint, computeStateHash } from '../identity/fingerprint';
import { SeverityFacts } from '../severity/facts';
import { computeSeverity } from '../severity/rules';
import {
    ParsedVersion,
    VersionPrecision,
    compareVersions,
    parseVersionForComparison,
    truncateVersion,
} from '../version';
import { ProvenanceMethod, ResolvedVersion } from '../sources';
import { Clock } from '../clock';
import { InternalError } from '../errors';
import { formatZodIssues } from '../schema/issues';
import { CollectorContext } from '../types';

/** What a collector observed. Everything else on a Finding is derived from it. */
export interface BuildFindingInput {
    collector: CollectorId;
    kind: FindingKind;
    subject: Subject;
    title: string;
    detail: string;
    /** Literally what the file says: `^5.7.3`, `v4`, `bullseye`, `1.31`. */
    declared: string | null;
    /**
     * The current version, already parsed by the collector.
     *
     * Parsed by the caller rather than here because only the collector knows whether its
     * domain is strict (a registry tag) or loose (an EKS `1.31`), and choosing wrongly
     * produces a silently incorrect comparison rather than a visible failure.
     */
    observed: ParsedVersion | null;
    /**
     * Narrow the comparison to the components the declared reference actually states.
     *
     * `actions/checkout@v4` names the 4 line, not 4.0.0, so comparing it against the full
     * latest reports drift the moment a patch ships even though the tag already points
     * there. `versions.latest` still records the true latest — only `bump` and
     * `majorsBehind` are computed against the narrowed value.
     */
    comparePrecision?: VersionPrecision;
    /** The outcome of asking "what is newest?", including the case where nothing was asked. */
    latest: LatestResolution;
    evidence: Evidence[];
    advisory?: Advisory | null;
    lifecycle?: Lifecycle | null;
    /** Extra identity axis folded into the fingerprint, e.g. a GHSA id. */
    discriminator?: string | null;
    /** Mechanical next step only — a command or a file edit. No judgement. */
    remediationHint?: string | null;
    references?: readonly string[];
    tags?: readonly string[];
    /**
     * Whether an action is published by GitHub itself.
     *
     * The one severity input that cannot be derived from the rest of the finding, so it
     * is passed rather than guessed (REQ-SEV-056).
     */
    isFirstPartyAction?: boolean;
}

/**
 * Assemble, score and validate a Finding.
 *
 * @throws InternalError when the assembled finding does not satisfy the contract.
 */
export function buildFinding(input: BuildFindingInput, ctx: CollectorContext): Finding {
    const identity = {
        collector: input.collector,
        subjectKind: input.subject.kind,
        subjectId: input.subject.id,
        kind: input.kind,
        discriminator: input.discriminator ?? null,
    };
    const fingerprint = computeFingerprint(identity);
    const id = buildFindingId(identity);

    const comparison = compareVersions(input.observed, comparableLatest(input));
    // Derived here rather than accepted from the caller: a collector that could set this
    // independently could contradict its own resolution, and "unresolved" drives both the
    // severity guard and the report's unresolved count (REQ-ERR-030).
    const unresolved = input.latest.status === 'unresolved';
    const advisory = input.advisory ?? null;
    const lifecycle = input.lifecycle ?? null;

    const facts: SeverityFacts = {
        kind: input.kind,
        unresolved,
        bump: comparison.bump,
        majorsBehind: comparison.majorsBehind,
        zeroMajor: comparison.zeroMajor,
        advisorySeverity: advisory?.severity ?? null,
        deprecated: lifecycle?.deprecated ?? false,
        endOfSupport: lifecycle?.endOfStandardSupport ?? null,
        scope: input.subject.scope,
        isFirstPartyAction: input.isFirstPartyAction ?? false,
    };
    const severity = computeSeverity(facts, {
        clock: ctx.clock,
        overrides: ctx.config.severity.overrides,
        findingId: id,
        fingerprint,
    });

    const finding: Finding = {
        id,
        fingerprint,
        fingerprintVersion: FINGERPRINT_VERSION,
        stateHash: computeStateHash({
            declared: input.declared,
            observed: input.observed?.version ?? null,
            latest: input.latest.version,
            bump: comparison.bump,
            severity: severity.severity,
            unresolved,
            advisoryFixedVersion: advisory?.fixedVersion ?? null,
        }),
        collector: input.collector,
        kind: input.kind,
        subject: input.subject,
        title: input.title,
        detail: input.detail,
        versions: {
            declared: input.declared,
            observed: input.observed?.version ?? null,
            latest: input.latest.version,
            bump: comparison.bump,
            majorsBehind: comparison.majorsBehind,
        },
        latestResolution: input.latest,
        severity,
        advisory,
        lifecycle,
        unresolved,
        remediationHint: input.remediationHint ?? null,
        references: [...(input.references ?? [])],
        evidence: input.evidence,
        discriminator: input.discriminator ?? null,
        tags: [...(input.tags ?? [])],
    };

    const result = FindingSchema.safeParse(finding);
    if (!result.success) {
        throw new InternalError(
            `The ${input.collector} collector built an invalid finding (${id}): ` +
                formatZodIssues(result.error).join('; '),
            { target: id, cause: result.error },
        );
    }
    return result.data;
}

/**
 * The latest version as the comparison should see it.
 *
 * Coercion is safe here and nowhere near tag selection: this value came from a source
 * that already vouched for it being a version. It exists for the loose domains the
 * comparison must still handle — an EKS `1.31`, an addon `v1.19.2-eksbuild.1` — where
 * strict parsing would report `bump: 'unknown'` against a version we plainly understand.
 */
function comparableLatest(input: BuildFindingInput): ParsedVersion | null {
    if (input.latest.version === null) {
        return null;
    }
    const parsed = parseVersionForComparison(input.latest.version);
    if (parsed === null || input.comparePrecision === undefined) {
        return parsed;
    }
    return truncateVersion(parsed, input.comparePrecision);
}

/** Record a source's answer, stamped with when it was obtained. */
export function resolutionFromSource(
    ref: string,
    resolved: ResolvedVersion,
    clock: Clock,
): LatestResolution {
    return {
        status: resolved.status,
        version: resolved.version,
        ref,
        method: resolved.method,
        confidence: resolved.confidence,
        retrievedAt: resolved.status === 'resolved' ? clock.nowIso() : null,
        reason: resolved.reason,
    };
}

/**
 * Record that there was no upstream question to ask.
 *
 * Distinct from `unresolved`, and the distinction matters: an unpinned action or a stale
 * calendar entry has no "latest version", but we are not failing to establish one.
 * Marking it unresolved would trip the pre-emptive severity guard and force every such
 * finding to `info` (REQ-SEV-004). Confidence is `high` because the outcome itself is
 * certain, not because a version was trusted.
 */
export function notApplicableResolution(
    method: ProvenanceMethod,
    reason: string,
): LatestResolution {
    return {
        status: 'not-applicable',
        version: null,
        ref: null,
        method,
        confidence: 'high',
        retrievedAt: null,
        reason,
    };
}

/**
 * Record a latest version taken from a committed table rather than from upstream.
 *
 * Used by the collectors backed by a support or distribution calendar, where the value
 * is only as fresh as the last human review — hence a caller-supplied confidence rather
 * than a fixed one (ADR-0002).
 */
export function calendarResolution(
    version: string | null,
    source: string,
    clock: Clock,
    confidence: Confidence = 'medium',
): LatestResolution {
    return {
        status: version === null ? 'unresolved' : 'resolved',
        version,
        ref: source,
        method: 'support-calendar',
        confidence,
        retrievedAt: version === null ? null : clock.nowIso(),
        reason: version === null ? `No entry in ${source}.` : null,
    };
}
