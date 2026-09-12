# ADR-0007 — Unresolved is a first-class finding state

**Status:** Accepted · **Date:** 2026-09-12 · **Relates to:** REQ-ERR-030 … REQ-ERR-037, REQ-NET-021, REQ-SEV-004

## Context

Collectors depend on upstream services that fail: rate limits, network
partitions, restricted egress, a registry returning nothing for a tag filter.

The default behaviour of most tooling is to log a warning and skip the item.
For a maintenance scanner this is the worst possible choice. **A missing
finding reads as "healthy."** Unauthenticated GitHub API access is 60 requests
per hour; a throttled run that silently drops half its findings produces a
report that looks like good news.

## Decision

A collector that cannot establish upstream truth **emits the finding anyway**,
with `unresolved: true`, `latest: null`, a resolution method of
`not-attempted`, and a non-null reason. It never omits it.

This is enforced structurally rather than by convention:

- `Collector.collect()` returns `{ findings, errors }` rather than a bare
  array, so a partly-working collector has somewhere to say so.
- `runCollector()` is the single place status is derived: errors with findings
  is `partial`; errors without findings is `failed`; a collector that throws is
  `failed` *and* contributes one synthetic finding recording the failure.
- Unresolved findings are counted separately in the report summary.
- An unresolved finding is forced to severity `info` before the rule table
  runs — if we could not establish the truth we have no basis to claim impact,
  but the finding still exists and is still counted.

## Consequences

- A degraded run is visibly degraded. `worstStatus` and `unresolvedCount` make
  it impossible to mistake a throttled scan for a clean one.
- Offline mode is not a special case but the same mechanism at full scale:
  everything unresolved, report still schema-valid, exit code still zero.
- Reports carry findings that state nothing actionable. That is the intended
  cost — "we do not know" is information, and suppressing it is what turns a
  scanner into a liability.
- The publish stage must not open issues for unresolved findings; they are
  operational signal about the scan, not maintenance work. Recorded as a pass-2
  constraint.

## What would reverse this

Nothing. If anything, the principle should extend: a collector that cannot read
its input file should emit a finding about the missing file rather than only an
error.
