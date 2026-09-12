# Technical research — collect stage

**Status:** Current · **Last updated:** 2026-09-12
**Related:** [project-brief.md](./project-brief.md) · [requirements.md](./requirements.md) · [adr/](./adr/)

Every claim below is attributed to a probe run against this repository or to a
primary source. Nothing here is from recall. Probes were run on Node v22.22.2 /
npm 10.9.7 on Linux.

> **Correction of record.** An earlier probe, run with `node_modules` **absent**,
> reported that `npm outdated --json` returned only the six runtime
> dependencies and no `devDependencies`, and an early draft of the design
> treated that as a permanent property of the tool. Re-probing after `npm ci`
> shows that is **false** — see [1.1](#11-npm-outdated-is-a-diff-not-an-inventory).
> The design conclusion (`package.json` is authoritative for the declared set)
> survives, but for different and weaker reasons. Recorded here because the
> wrong reason was nearly baked into a collector.

---

## 1. npm tooling

### 1.1 `npm outdated` is a diff, not an inventory

With dependencies installed:

```
$ npm outdated --json ; echo "exit=$?"
exit=1
```

| Measure | Value |
| --- | --- |
| Declared in `package.json` | 6 runtime + 28 dev = 34 |
| Reported by `npm outdated --json` | 27 (4 runtime + 23 dev) |
| Declared but absent from the output | 7 — all of them already at latest |
| Reported by `npm outdated --all --json` | 420 (the transitive tree) |

So `npm outdated` **does** cover `devDependencies`. What it does not do:

1. **It reports only what is outdated.** A dependency at latest is simply
   absent, so the output can never tell you the declared set.
2. **Its contents depend on the installed tree, not the manifest.** With
   `node_modules` absent the same command returned a different, smaller set. A
   collector keyed off it would report differently depending on whether
   `npm ci` had run.
3. **`--all` is a different set again** — 420 transitive packages, not the 34
   declared ones.

**Verdict:** read the declared set from `package.json`; use `npm outdated`
purely as enrichment for the packages it does report. → [ADR-0001](./adr/0001-package-json-authoritative.md)

### 1.2 Exit codes

Both commands exit **1** when they find something, which is the normal case:

```
$ npm outdated --json ; echo exit=$?   → exit=1   (27 packages outdated)
$ npm audit --json    ; echo exit=$?   → exit=1   (40 vulnerabilities)
```

**Verdict:** the command runner must accept exit 0 and 1 as success for these
two commands and must not throw on non-zero. Only another status, or
unparseable output, is a failure. → REQ-NPM-011, REQ-NPM-012, REQ-NPM-013

### 1.3 `npm outdated --long` carries scope

`--long` adds `type` and `homepage`:

```json
{ "@eslint/eslintrc": {
    "current": "3.3.1", "wanted": "3.3.7", "latest": "3.3.7",
    "dependent": "typescript-starter",
    "location": "/…/node_modules/@eslint/eslintrc",
    "type": "devDependencies",
    "homepage": "https://github.com/eslint/eslintrc#readme" } }
```

`type` gives the runtime/dev scope that severity demotion needs — but only for
packages that appear at all, which is why `package.json` remains the source of
scope for everything else.

### 1.4 `npm audit --json` has two irregular shapes

40 vulnerabilities, 57,181 bytes of JSON, metadata
`{info:0, low:6, moderate:16, high:16, critical:2, total:40}`.

Per-package entry keys: `name, severity, isDirect, via, effects, range, nodes,
fixAvailable`.

Two traps confirmed by probe:

- **`via[]` is heterogeneous** — entries are `object` *or* `string`. Object
  entries are advisories; string entries name a package in a transitive chain.
  Minting an advisory from a string entry produces garbage ids.
- **`fixAvailable` is `boolean | object`.**

A real advisory object:

```json
{ "source": 1123528, "name": "@babel/core",
  "title": "@babel/core: Arbitrary File Read via sourceMappingURL Comment",
  "url": "https://github.com/advisories/GHSA-4x5r-pxfx-6jf8",
  "severity": "low", "cwe": ["CWE-22","CWE-200"],
  "cvss": { "score": 3.2, "vectorString": "CVSS:3.1/AV:L/AC:H/…" },
  "range": "<=7.29.0" }
```

**Verdict:** parse both with a Zod union rather than an interface cast, and set
an explicit `maxBuffer` — 57KB here is comfortable, but this is a small
repository. → REQ-NPM-016, REQ-NPM-020

---

## 2. Schema tooling

| Candidate | Evidence | Verdict |
| --- | --- | --- |
| `zod` 4.6.2 | Registry metadata shows CJS (`index.cjs`) plus `index.d.cts` and a `./v4` export path — compatible with this repo's `module: commonjs`. | **Adopt** |
| `zod-to-json-schema` | Zod 4 ships `z.toJSONSchema()` natively with `target`, `io`, `unrepresentable`, `cycles`, `reused` options. | **Reject** — a second source of truth that can disagree with the zod version defining the schema |
| `ajv` | Zod validates in-process; the emitted JSON Schema exists for the *downstream* consumer, not for us. | **Reject** — unused dependency |
| `class-validator` (already present) | Decorator-based, no clean JSON Schema export. | **Reject** for this subsystem |

`unrepresentable: 'throw'` is chosen deliberately so that adding a `z.date()`
or a `.transform()` to the report schema fails generation loudly rather than
silently emitting a schema the downstream stage cannot enforce.
→ [ADR-0004](./adr/0004-zod-single-source-of-truth.md), REQ-SCH-006

---

## 3. YAML parsing

| Candidate | Evidence | Verdict |
| --- | --- | --- |
| `yaml` 2.9.1 | Bundles its own types. `parseDocument()` exposes per-node `range: [start, valueEnd, nodeEnd]` character offsets, which convert to line/column. | **Adopt** |
| `js-yaml` | Returns plain JS objects with no node position information. | **Reject** |
| Regex scanning | Cannot survive block scalars, anchors, flow mappings or comments. | **Reject** |

Evidence requirements REQ-EVI-002, REQ-GHA-011, REQ-ARC-013 and REQ-IMG-018 all
demand real line numbers. Node ranges are the only honest way to get them, and
that single property decides the dependency.

---

## 4. Upstream registries — anonymous access

All probed directly.

| Registry | Auth flow | Result |
| --- | --- | --- |
| `registry.npmjs.org` | none | 200. `dist-tags.latest` and per-version `deprecated`. |
| `ghcr.io` | `GET /token?service=ghcr.io&scope=repository:<repo>:pull` → bearer → `/v2/<repo>/tags/list` | **Works anonymously.** For `actions/actions-runner-controller-charts/gha-runner-scale-set-controller`: 25 tags, all semver, newest **0.14.2**. |
| `docker.io` | `GET https://auth.docker.io/token?service=registry.docker.io&scope=repository:<repo>:pull` | Works anonymously. |
| `mcr.microsoft.com` | **none at all** — `/v2/<repo>/tags/list` directly | 200. For `devcontainers/base`: **1,985 tags**. |

### 4.1 Tag volume makes filtering mandatory

`devcontainers/base` returns 1,985 tags. Filtering to
`^\d+\.\d+\.\d+-(bullseye|bookworm|trixie)$` leaves 113. Without a filter, a
naive "sort and take the max" picks nonsense.

**Verdict:** every configured base image must declare a tag filter, and an
empty match set is a config bug that must surface as `unresolved` with a
reason — never as "no drift". → REQ-IMG-015, REQ-IMG-016

### 4.2 GitHub API rate limits

Unauthenticated: 60 requests/hour per IP. With a token: 1,000/hour for the
repository in Actions. A repository referencing many distinct actions will be
throttled part-way through an unauthenticated run.

**Verdict:** classify a rate-limit response as `rate-limited`/retryable, mark
affected findings `unresolved`, warn at startup when no token is present, and
memoise so each distinct reference is fetched once.
→ REQ-NET-023, REQ-NET-024, REQ-NET-025, REQ-ERR-032

---

## 5. EKS supported-version resolution

The hardest problem in the collect stage: **there is no unauthenticated public
API for the set of EKS-supported Kubernetes versions and their support dates.**

| Option | Evidence | Verdict |
| --- | --- | --- |
| `aws eks describe-cluster-versions` | Authoritative. Requires the AWS CLI and credentials — the scheduled GitHub-hosted job has neither without OIDC and an IAM role, and a developer running the CLI locally has neither either. Contradicts the "no live cloud calls" scope decision. | **Optional enrichment only** |
| Committed support calendar | Deterministic, offline-safe, no credentials, reviewable in a pull request, works on day one. Cost: hand-maintained, and can go stale silently. | **Adopt as primary** |
| `kubernetes/kubernetes` releases as a proxy | EKS trails upstream by months. Every scan would report the cluster several minors behind versions EKS does not offer. | **Reject** |

The rejection of the third option is the important one. A finding that can
never be actioned is worse than no finding: it trains people to skim past the
collector's output, which costs the findings that *are* real.

Staleness is handled rather than ignored: the calendar carries `lastVerified`
and `staleAfterDays`, and the collector raises a `config-stale` finding against
its own configuration when the window lapses. The tool nags about its own
inputs. → [ADR-0002](./adr/0002-eks-support-calendar.md), REQ-EKS-011, REQ-EKS-012, REQ-EKS-016

---

## 6. Day-one targets already in this repository

Verified by inspection — these produce real findings with no new infrastructure
files, which is how the collectors get exercised against reality rather than
only fixtures.

`.devcontainer/Dockerfile`:

| Line | Content | Expected finding |
| --- | --- | --- |
| 1 | `FROM mcr.microsoft.com/devcontainers/base:bullseye` | Debian 11; standard support ended **2026-08-31** → `image-distro-eol`, severity **critical** |
| 19 | `curl … deb.nodesource.com/setup_22.x` | Node major pin → `image-tool-outdated` |
| 21 | `npm install -g npm@latest` | Unpinned tool → tagged, `bump: unknown` |
| 35 | `curl … get.pulumi.com \| sh -s -- --version 3.178.0` | Pinned tool → `image-tool-outdated` |

`.github/workflows/ci.yml` — four `uses:` references on lines 13, 15, 34, 36,
all mutable major tags (`actions/checkout@v4`, `actions/setup-node@v4`), none
SHA-pinned → `action-unpinned` (first-party, so `low`) plus `action-outdated`
where a newer major exists.

`package.json` — 27 outdated packages and 40 advisories including 2 critical,
across both dependency scopes.

> Note for the sample ARC inventory: the current controller chart is **0.14.2**.
> Sample values should be pinned behind that (not at it) so the collector
> demonstrably produces a finding.

---

## 7. Environment and egress

Probed from the development sandbox:

| Host | Reachable | Needed by |
| --- | --- | --- |
| `registry.npmjs.org` | yes | npm collector |
| `api.github.com` | yes (token-gated per repository scope in this sandbox) | github-actions, arc, eks, images collectors |
| `ghcr.io` | yes | arc collector, runner images |
| `mcr.microsoft.com` | yes | devcontainer base image |
| `hub.docker.com` / `auth.docker.io` | yes | Docker Hub base images |
| `docs.aws.amazon.com` | **blocked** | not required — calendar is committed |
| `endoflife.date` | **blocked** | not required — distro calendar is committed |

The two blocked hosts are precisely the ones the committed-calendar design
avoids depending on, which is a point in its favour beyond determinism.

Egress policy differs between GitHub-hosted runners and a self-hosted EKS
fleet. The required host list belongs in `infra/README.md`, and offline mode
plus per-source `unresolved` handling is what keeps a restricted environment
honest rather than silently green. → REQ-NET-020, REQ-NET-021, REQ-NET-022

---

## 8. Repository constraints that shape the implementation

Verified against the working tree:

| Constraint | Consequence |
| --- | --- |
| `tsconfig.json`: `module: commonjs`, `include: ["src"]`, `outDir: "bin"` | `src/maintenance/cli.ts` compiles to `bin/maintenance/cli.js`. No config change needed. `tsc` copies no non-TS assets, so schemas and config stay at the repository root. |
| `eslint.config.mjs`: `tseslint.configs.recommended` | `no-explicit-any` is an error — external JSON must be `unknown` narrowed by a Zod parse. |
| `no-unused-vars` has no `argsIgnorePattern` | The deferred provider stub must consume its parameter; an `_`-prefix will not satisfy the linter. |
| `strict: true` | `useUnknownInCatchVariables` — a shared `toError(value: unknown): Error` helper avoids repeating the narrowing. |
| `eslint-plugin-prettier/recommended` | Formatting violations are lint errors; CI's `git diff --exit-code` then fails. Generated files must be Prettier-stable or ignored. |
| CI test matrix includes `windows-latest`; `.gitattributes` marks `*.yaml`/`*.json` as text | Fixtures check out CRLF on that leg only. Normalise line endings when reading, or line arithmetic breaks on one platform. |
| No `coverageThreshold` configured today | The >80% figure in `AGENTS.md` is unenforced; the new threshold must be added explicitly and scoped to the new code. |
| `AGENTS.md` and `.github/copilot-instructions.md` are identical **except lines 1–2** | Syncing by copy breaks the cross-reference in one direction. |
