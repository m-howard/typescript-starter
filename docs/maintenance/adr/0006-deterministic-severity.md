# ADR-0006 — Severity is a deterministic rule table

**Status:** Accepted · **Date:** 2026-09-12 · **Relates to:** REQ-SEV-001 … REQ-SEV-056, REQ-P2-003

## Context

Every finding needs a severity so the queue can be triaged. The tempting option
is to let the assess stage decide it — the model has the most context.

Three problems with that. Severity would vary between runs over identical
facts. It could not be explained to the person triaging. And it would be the
one number people act on, produced by the least auditable part of the system.

## Decision

Severity is computed by a **pure, ordered, first-match-wins rule table** over
facts the collectors established. The table is ordered by non-increasing
severity tier, and that ordering is itself asserted by a test — it prevents the
classic bug where a "moderate advisory" rule shadows "three majors behind".

Every finding records the matched rule id, the rule table version, any
modifiers applied, and the reason. The number is arguable rather than magic.

Two post-table modifiers: development-scope findings step down one tier
(floored at `low`, and exempt for end-of-life rules, because an end-of-life
build image bites you regardless of dependency scope); and a configured
override may replace the severity, but only with a reason and an expiry.

CVSS score is not an input — the advisory severity already encodes it, and
mixing the two produces contradictory ladders. CVSS rides along as evidence.

The assess stage may **propose** a different severity via
`assessment.suggestedSeverity`. It may never overwrite the computed one.

## Consequences

- Identical facts always yield an identical severity, which is what makes
  report diffing meaningful.
- Anyone can read the rule that fired and disagree with the rule rather than
  with the tool.
- The table needs deliberate maintenance as new finding kinds appear. A test
  asserts every rule is exercised by at least one case, so dead rules surface.
- Overrides expire by construction. A permanent override is how these systems
  silently go blind; an expired one is ignored *and* raises a `config-stale`
  finding naming itself.

## What would reverse this

Nothing foreseeable for the severity field itself. If model judgement proves
consistently better, the right move is to feed it back into the rule table as a
reviewed change — not to let the assess stage write the field directly.
