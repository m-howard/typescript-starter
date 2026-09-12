# ADR-0002 — EKS latest version from a committed support calendar

**Status:** Accepted · **Date:** 2026-09-12 · **Relates to:** REQ-EKS-011, REQ-EKS-012, REQ-EKS-014, REQ-EKS-016, REQ-EKS-040, REQ-EKS-041

## Context

The EKS collector must answer "is this cluster version still supported, and
what is available?". There is **no unauthenticated public API** for the set of
EKS-supported Kubernetes versions and their support dates. Three options:

1. **`aws eks describe-cluster-versions`** — authoritative, but requires the
   AWS CLI plus credentials. The scheduled GitHub-hosted job has neither
   without OIDC and an IAM role, and a developer running the CLI locally has
   neither either. It also contradicts the scope decision that pass 1 makes no
   live cloud calls.
2. **A committed support calendar** — deterministic, offline-safe, no
   credentials, reviewable in a pull request. Hand-maintained, so it can rot.
3. **`kubernetes/kubernetes` releases as a proxy** — EKS trails upstream by
   months, so every scan would report the cluster several minors behind
   versions EKS does not offer.

## Decision

The committed support calendar in `maintenance.config.yaml` is the **primary**
source, recording `confidence: medium` and `method: support-calendar`.

The AWS CLI is available as **opt-in enrichment**. When enabled and successful
it records `confidence: high` and `method: aws-cli`. When it fails, the
collector falls back to the calendar, records the downgraded method and
confidence, and marks the run `partial` — the downgrade is always visible and
never masquerades as authoritative.

Upstream Kubernetes releases are fetched only to populate a context line in the
finding's detail. They never set `versions.latest` and never feed severity.

Staleness is handled rather than hoped away: the calendar carries
`lastVerified` and `staleAfterDays`, and the collector emits a `config-stale`
finding against its own configuration when the window lapses.

## Consequences

- Works on day one, in CI, offline, and on a developer machine with no AWS
  access.
- Support dates are reviewable in a diff, which is a real advantage over an
  opaque API call — a human sees the dates change.
- The calendar is the weakest link in the design, and is deliberately visible
  as such. A rejected option (upstream Kubernetes) would have *looked*
  authoritative while being consistently wrong, which is worse.
- Rejecting the proxy matters most for trust: a finding that can never be
  actioned trains people to skim the collector's output, which costs the
  findings that are real.

## What would reverse this

AWS publishing an unauthenticated endpoint for supported versions and support
dates, or the fleet gaining an OIDC role that the scan job can assume as a
matter of course. In the second case the CLI strategy simply becomes the
default; the calendar stays as the offline fallback.
