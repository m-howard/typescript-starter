# ADR-0005 — `FileProvider` forbids globbing; every input is declared

**Status:** Accepted · **Date:** 2026-09-12 · **Relates to:** REQ-CFG-001, REQ-CFG-006

## Context

Collectors read workflow files, Helm values, Dockerfiles and manifests. The
convenient interface is `list(pattern)` — point the tool at `.github/workflows`
and let it find things.

But where the infrastructure files ultimately live is undecided. They may end
up in other repositories, which is why all reads go through a `FileProvider`
with a local implementation now and a GitHub Contents implementation later.

Globbing is what makes the second implementation expensive: listing over the
GitHub API means tree traversal, pagination and a rate-limit budget — precisely
the work being deferred.

## Decision

`FileProvider` exposes `read` and `exists` only. Every file a collector touches
is named explicitly in `maintenance.config.yaml`. No globbing, no directory
traversal, no auto-discovery.

## Consequences

- `GitHubContentsProvider` reduces to a single-file fetch, so the deferred work
  stays genuinely small.
- The configuration doubles as the inventory of record: what is scanned is
  visible in one reviewable file rather than implied by a pattern.
- A new workflow file is not scanned until someone adds it. This is a real
  cost. It is mitigated by the scan workflow listing itself, so the collector's
  own coverage is at least self-evident, and by the config being short enough
  to review.
- Scan cost is bounded and predictable, which matters against a 60 requests per
  hour unauthenticated API limit.

## What would reverse this

Enough files to make the config unwieldy, combined with a cheap listing
primitive. A middle path — globbing for the local provider only, with explicit
declaration required for remote sources — was considered and rejected for pass
1 because divergent behaviour between providers is a bug factory.
