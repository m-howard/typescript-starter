# Pass 2 interface — the assess and publish stages

**Status:** Current, and still the written target for work not yet built. The `EnrichedFinding` contract exists and is tested; nothing produces one
**Related:** [schema-contract.md](./schema-contract.md) · [requirements.md](./requirements.md) (REQ-P2-001 … REQ-P2-009) · [adr/0003](./adr/0003-two-hash-finding-identity.md) · [adr/0006](./adr/0006-deterministic-severity.md)

Pass 1 builds none of this. It is specified now so the collect-stage contract
is designed against a known consumer rather than guessed at.

## Input

A `MaintenanceReport` at `stage: "collect"`, validated against
`schemas/maintenance-report.v1.json`. The assess stage should validate on read
rather than trusting the producer.

## Output

An `EnrichedFinding` per input finding: every collect-stage field carried
through **unchanged**, plus `assessment` and `issue`.

## Rules the assess stage must obey

1. **Do not modify collect-stage fields.** Carrying a finding through with an
   edited version, severity or evidence value silently destroys the audit
   trail. (REQ-P2-002)
2. **Severity is read-only.** Disagreement is expressed through
   `assessment.suggestedSeverity`; `severity` is never overwritten.
   (REQ-P2-003, [ADR-0006](./adr/0006-deterministic-severity.md))
3. **Cite everything.** Every claim added carries a source URL, a title, a
   trust classification and a retrieval timestamp. An uncited claim is a bug.
   (REQ-P2-004)
4. **Do not open issues for unresolved findings.** They are operational signal
   about the scan, not maintenance work. (REQ-P2-009)
5. **Reason only over supplied facts.** The report is the evidence base. Where
   the stage needs more, it fetches it and cites it — it does not fill gaps
   from recall.

## Trust classification

| Class | Examples |
| --- | --- |
| `official` | The project's own release notes, changelog, migration guide, advisory database entry; AWS documentation for EKS |
| `vendor` | A vendor's blog or support article about their own product |
| `community` | Stack Overflow, third-party blogs, forum threads |

A `community` source alone should not support a claim about breaking changes.

## Publish stage decision table

Fully determined by the two hashes ([ADR-0003](./adr/0003-two-hash-finding-identity.md)):

| Fingerprint matches an open issue | `stateHash` matches | Action |
| --- | --- | --- |
| no | — | Create the issue |
| yes | yes | Leave it alone — no comment, no edit |
| yes | no | Update the body; comment noting what changed |
| fingerprint absent from this run, issue open | — | Candidate for closure |

The third row is why `stateHash` exists: without it the stage either rewrites
every issue every week or never refreshes a stale one.

## Issue content

An issue should let a triager act without leaving it (success criterion SC-4):
what is out of date and where (with the file and line from `evidence`), the
observed and latest versions with provenance, the severity and the rule that
set it, the assessment's complexity and risk, the upgrade steps, and how to
verify. Sources are linked, not summarised away.
