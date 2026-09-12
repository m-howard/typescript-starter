# ADR-0003 — Two-hash finding identity; fingerprint excludes version

**Status:** Accepted · **Date:** 2026-09-12 · **Relates to:** REQ-ID-001 … REQ-ID-007, REQ-P2-005 … REQ-P2-008

## Context

The publish stage must decide, for each finding, whether to open an issue,
update one, or leave it alone. That needs a key it can match against existing
issues across runs.

The obvious key — a hash over the whole finding — fails. The scan runs weekly
and a package like `typescript` releases roughly monthly. If the latest version
is in the key, every release mints a new identity, no open issue matches, and
the stage files *another* "typescript is outdated". Within a quarter the
tracker is unusable and people mute the bot.

A single version-free hash also fails, for the opposite reason: the stage can
then find the existing issue but cannot tell whether anything has changed, so
it either rewrites every issue on every run or never refreshes a stale one.

## Decision

Two hashes with distinct jobs.

**`fingerprint`** — identity. Computed over the algorithm version, collector,
subject kind, subject id, finding kind, and discriminator. Deliberately
excludes observed and latest versions, severity, evidence line and column, and
all free text.

**`stateHash`** — mutable facts. Computed over declared/observed/latest
version, bump classification, severity, unresolved flag, and advisory fixed
version, from a field order fixed in source rather than runtime key
enumeration.

Security advisories are the one exception to version-independence: a new CVE
against the same package is genuinely new work, so the advisory id enters
identity through `discriminator`.

`subject.id` uses a global name where one exists (`typescript`,
`actions/checkout`) and is otherwise path-qualified but never line-qualified,
so reformatting a Dockerfile cannot orphan an issue.

## Consequences

- The publish stage's decision table is fully determined by the pair: no
  fingerprint match → create; match with equal state → leave alone; match with
  changed state → update and note what changed; fingerprint absent from a run
  → candidate for closure.
- Severity may escalate as an end-of-life date approaches without splitting the
  issue, which is correct — it is the same piece of work becoming more urgent.
- Moving a Dockerfile intentionally rotates the fingerprint. That is a
  deliberate trade: you are now maintaining a different thing.
- `fingerprintVersion` is recorded on every finding, so bumping the algorithm
  is an explicit, auditable act that orphans existing issues on purpose.

## What would reverse this

The publish stage gaining a reliable external identity for an issue — for
example a structured marker written into the issue body and queried back. That
would replace the fingerprint's matching role, though `stateHash` would still
be needed to decide whether to refresh.
