# Runbook — maintenance scan

**Status:** Current. Every command below was run against this repository
**Related:** [pipeline-overview.md](./pipeline-overview.md) · [requirements.md](./requirements.md)

## Run a scan locally

```bash
npm ci
npm run maintenance:collect                      # all collectors, default config
npm run maintenance:collect -- --collectors npm,images
npm run maintenance:collect -- --offline         # no network; nothing resolved upstream
npm run maintenance:collect -- --stdout          # report to stdout instead of a file
npm run maintenance:collect -- --out build/report.json
npm run maintenance:collect -- --fail-on high    # exit non-zero on a high or worse
npm run maintenance:collect -- --help
```

The report lands in `.maintenance/report.json`, which is gitignored. The command
**exits zero however many findings it produces** — a non-zero exit means the tool
broke. `--fail-on` is there for a caller who wants a gate anyway.

Offline is not a degraded special case: it is the same `unresolved` mechanism at
full scale. Both the HTTP client and the command runner refuse, so `npm outdated`
and `npm audit` do not run either. The support calendars still answer, so an
offline scan on this repository still reports the EKS and Debian end-of-life
findings — those are the ones that need no network to be true.

Set `GITHUB_TOKEN` first. Without it the GitHub API allows 60 requests per hour
and a run will be throttled part-way through — the CLI warns at startup, and
affected findings come back `unresolved` rather than silently absent.

```bash
export GITHUB_TOKEN=$(gh auth token)   # or any token with public read scope
```

## Triage a report

Read in this order:

1. `summary.worstStatus` — if it is not `ok`, the scan degraded and missing
   findings prove nothing.
2. `summary.unresolvedCount` — how much the scan could not determine.
3. `collectorRuns[].errors` — why.
4. `findings[]` — already sorted worst-first.

For each finding: `severity.ruleId` says why it has that level, `evidence[]`
says where the fact came from, and `latestResolution.confidence` says how much
to trust "latest". A `medium` confidence with method `support-calendar` is a
committed table, not a live lookup.

Priorities follow the [operating model](./project-brief.md#operating-model):
`critical` and `high` next working day, `medium` at sprint planning, `low` and
`info` as backlog signal.

## Refresh the support calendars

Two hand-maintained tables in `maintenance.config.yaml` raise a `config-stale`
finding against themselves when they age past their window. When one fires:

**EKS** — `collectors.eks.supportCalendar`. Check the [Amazon EKS Kubernetes
versions](https://docs.aws.amazon.com/eks/latest/userguide/kubernetes-versions.html)
page. Update `versions[]`, `defaultVersion`, and set `lastVerified` to today.

**Distributions** — `collectors.images.distroCalendar`. Check the distribution's
own release page. Add codenames before they are needed, not after.

Both are reviewed in a pull request, which is the point — a human sees the
dates change.

## Clear an expired severity override

An expired override is ignored and raises a `config-stale` finding naming it.
Either delete it, or renew it with a fresh `expiresAt` and a reason that still
holds. Renewing without re-reading the reason is how a queue goes blind.

## Add a collector

1. Add the id to the collector enum in `src/maintenance/schema/collector-run.ts`
   and to the report summary shape.
2. Add its configuration block to `src/maintenance/schema/config.ts`.
3. Implement `Collector` in `src/maintenance/collectors/`, returning
   `{ findings, errors }` — never a bare array, or degraded state has nowhere
   to go.
4. Register it with the runner.
5. Add requirements to [requirements.md](./requirements.md) with a new area
   prefix, cite the ids in test titles, and extend the traceability matrix.
6. Regenerate the schema: `npm run schema:emit`.

## Add a version source

Implement `VersionSource` in `src/maintenance/sources/`, register the scheme in
the registry, and add fixtures. Return a resolution with an explicit `method`
and `confidence` — a source that cannot say how confident it is does not belong
in the report.

## Change the schema

Read the [versioning policy](./schema-contract.md#versioning-policy) first.
Additive changes stay in `v1`. Then `npm run schema:emit` and commit the
regenerated artifact; CI fails if it is stale.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| Everything `unresolved`, status `partial` | Offline mode, or no egress | Check `runtime.offline`; check the egress allowlist in `infra/README.md` |
| Many `rate-limited` errors | No `GITHUB_TOKEN` | Set one; 60/hr becomes 1000/hr |
| A base image finding says "no tags matched pattern" | The configured `tagPattern` is wrong | Fix the pattern — this is a config bug reported honestly, not an absence of drift |
| CI fails on `git diff --exit-code` after a schema change | The committed artifact is stale | `npm run schema:emit`, commit the result |
| A collector reports `failed` with `NPM_NOT_INSTALLED` | No `node_modules` | `npm ci` — though the declared set still comes from `package.json` |
