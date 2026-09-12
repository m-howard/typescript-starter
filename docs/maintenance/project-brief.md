# Project brief — agent-driven runner fleet maintenance

**Status:** Draft · **Owner:** Platform · **Last updated:** 2026-09-12
**Related:** [requirements.md](./requirements.md) · [technical-research.md](./technical-research.md) · [pipeline-overview.md](./pipeline-overview.md)

## Problem

A self-hosted GitHub Actions runner fleet built on Actions Runner Controller
(ARC) on EKS drifts across five independent surfaces:

| Surface | Drifts as | Consequence of ignoring it |
| --- | --- | --- |
| npm dependencies | releases, CVEs | Vulnerable builds; upgrade debt compounds |
| GitHub Actions pins | new majors, mutable tags | Supply-chain exposure; silent behaviour change |
| ARC controller / scale-set charts | upstream releases | Runners stop registering; controller/scale-set skew |
| EKS cluster + addons | version support calendar | Forced upgrade under time pressure; extended-support billing |
| Runner images + baked-in tools | base image EOL, tool releases | EOL distro with no security patches; stale kubectl/helm/aws |

Each surface has a different source of truth, a different release cadence and a
different failure mode. None of them has an owner who watches it. There is no
inventory that says what is currently deployed, so the first signal is usually
an outage, a failed deploy, or a security escalation.

Dependabot covers exactly one of the five, and only for repositories where it
is enabled. It also says nothing about *what an upgrade involves* — the
information a human actually needs to decide whether to do it now.

Concretely, in this repository today: `.devcontainer/Dockerfile` runs Debian 11
(`bullseye`), whose standard support ended **2026-08-31**, and pins Pulumi to
`3.178.0`. `.github/workflows/ci.yml` pins two actions to mutable major tags.
Nothing reported any of it.

## Why agent-driven

The work splits cleanly into two halves with opposite requirements:

- **What version is where** — cheap, mechanical, and must be *exact*. Getting
  this wrong silently is worse than not running at all. It belongs to
  deterministic tools with reproducible output.
- **What this upgrade involves** — expensive, requires reading changelogs,
  advisories, migration guides and vendor docs, and reasoning about this
  codebase and this cluster. It does not reduce to a rule.

Trying to do the first half with a model produces confident, unverifiable
version claims. Trying to do the second half with rules produces issues nobody
can act on. **The split is the design**: deterministic collectors establish the
facts and the evidence for them; the agent reasons only over facts it was
handed, and cites trusted sources for anything it adds.

## Solution

```
┌─ Stage 1: collect (deterministic) ────────────────────────────────┐
│  five collectors → Finding[] → MaintenanceReport (JSON Schema)    │
│  every value carries provenance: file+line, argv+exit, url+status │
└───────────────────────────────────────────────────────────────────┘
                              ↓
┌─ Stage 2: assess (GitHub Copilot) ────────────────────────────────┐
│  reads the report, verifies against trusted sources, adds an      │
│  Assessment: complexity, risk, blast radius, steps, verification  │
└───────────────────────────────────────────────────────────────────┘
                              ↓
┌─ Stage 3: publish ────────────────────────────────────────────────┐
│  GitHub issues, deduped by fingerprint, refreshed by stateHash    │
└───────────────────────────────────────────────────────────────────┘
```

Three properties make it trustworthy rather than merely automated:

1. **The stages cannot blur.** `Finding` is a strict schema — a judgement field
   on a collector's output is a parse failure, not a code-review comment.
2. **Severity is machine-computed** from an ordered rule table, with the
   matched rule id recorded on every finding. The agent may *propose* a
   different severity; it can never overwrite one.
3. **"We could not find out" is a first-class result.** A collector that
   cannot reach an upstream source emits the finding marked `unresolved` with
   a reason. It never drops it, because a missing finding reads as "healthy"
   and that is the failure mode that destroys trust in a maintenance bot.

## Scope

**Pass 1 (this change)** — the deterministic stage and the contract it hands
off: five collectors, the Zod-defined schema plus emitted JSON Schema, the
committed inventory of record, a scheduled collect-only workflow that uploads
the report as an artifact, and this documentation set.

**Pass 2** — the Copilot assessment stage and issue publication. The seams
exist in pass 1 (`EnrichedFinding` and `IssueLink` are defined and tested;
nothing produces them).

### Non-goals

| Not doing | Why |
| --- | --- |
| Auto-remediation / auto-opened upgrade PRs | Trust has to be earned by the reporting being right first. |
| Live AWS, `kubectl` or `helm list` calls | Pass 1 reads committed declarations; live access is credentials, blast radius and a different security review. |
| Replacing Dependabot or Renovate | Complementary. This covers the four surfaces they do not. |
| Historical trending / dashboards | Needs a store; the artifact is per-run. |
| Auto-discovery of infra files by globbing | Every input is declared explicitly, which is what keeps cross-repo support a small piece of later work. |

## Success criteria

| # | Criterion | How it is measured |
| --- | --- | --- |
| SC-1 | Every issue is traceable to primary evidence | Each finding carries ≥1 evidence record: file+line, argv+exit code, or url+status |
| SC-2 | No duplicate issues for an unchanged subject | `fingerprint` is stable across runs while the subject exists, regardless of version movement |
| SC-3 | No finding is silently dropped | Unreachable source ⇒ `unresolved: true` + reason; collector status `partial`; never an omitted finding |
| SC-4 | A triager can act without leaving the issue | Issue states observed version, latest version, provenance, severity with its rule id, and (pass 2) steps and verification |
| SC-5 | Reports are reproducible | Two runs over unchanged inputs differ only in `generatedAt` |
| SC-6 | The tool's own inputs cannot rot silently | Stale support calendars and expired severity overrides raise `config-stale` findings |
| SC-7 | Coverage of the five surfaces | Each collector returns findings against real declared inputs, not only fixtures |

A deliberately excluded metric is "number of issues closed". Optimising for it
rewards noisy findings; SC-2 and SC-3 are the honest proxies for usefulness.

## Operating model

- **Cadence** — scheduled weekly (Monday 06:00 UTC), plus `workflow_dispatch`
  for on-demand runs.
- **Output** — pass 1 uploads a JSON artifact and writes a job summary. The
  scan job goes red only when the *tool* breaks; findings never fail the job,
  because a red build for "there is maintenance work" trains people to ignore
  it.
- **Triage** — platform owns the queue. `critical` and `high` are triaged on
  the next working day; `medium` at sprint planning; `low`/`info` are
  backlog signal.
- **Escalation** — an EOL date inside 30 days or a critical advisory is an
  interrupt, not a backlog item. The severity table encodes this so it does not
  depend on someone reading carefully.
- **Keeping the tool honest** — the EKS and distro support calendars are
  hand-maintained and carry `lastVerified`. When they go stale the scan raises
  a `config-stale` finding against itself. Acting on those is part of the job.

## Risks

| Risk | Mitigation |
| --- | --- |
| Alert fatigue turns the queue into noise | Deterministic severity, dev-scope demotion, dedupe by fingerprint, no issue for `bump: none` |
| Committed support calendars go stale | `lastVerified` + `staleAfterDays` ⇒ self-reported `config-stale` finding |
| Unauthenticated GitHub API (60 req/hr) yields partial results | Classified as `rate-limited`, surfaced as `unresolved` + `partial`, never as "up to date" |
| Egress restrictions differ between GitHub-hosted and self-hosted runners | Required-egress allowlist documented in `infra/README.md`; offline mode degrades cleanly |
| The agent stage overstates confidence | It may only cite trusted sources, may only propose severity, and its output is a separate schema |
