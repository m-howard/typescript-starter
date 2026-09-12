# Requirements — maintenance collect stage (pass 1)

**Status:** Draft · **Notation:** [EARS](https://alistairmavin.com/ears/) · **Last updated:** 2026-09-12
**Related:** [project-brief.md](./project-brief.md) · [schema-contract.md](./schema-contract.md) · [technical-research.md](./technical-research.md)

## How to read this document

Requirements use EARS (Easy Approach to Requirements Syntax). Every requirement
is one sentence in exactly one of five patterns:

| Pattern | Shape |
| --- | --- |
| Ubiquitous | The `<system>` shall `<response>`. |
| Event-driven | When `<trigger>`, the `<system>` shall `<response>`. |
| State-driven | While `<state>`, the `<system>` shall `<response>`. |
| Unwanted (unwanted behaviour) | If `<trigger>`, then the `<system>` shall `<response>`. |
| Optional (optional feature) | Where `<feature>`, the `<system>` shall `<response>`. |
| Complex | A combination of the above. |

Ids are `REQ-<AREA>-<nnn>` and are **stable** — never renumber. A retired
requirement is marked `WITHDRAWN` in place, keeping its id burned.

Each requirement names the spec that verifies it. Specs cite the id in the test
title, e.g. `it('should include devDependencies in the declared set [REQ-NPM-010]', …)`,
so [the traceability matrix](#traceability) is checkable by grep rather than by
hand.

**Terms.** *Collect stage* — the deterministic tooling in `src/maintenance/`.
*Assess stage* — the pass-2 Copilot step. *Finding* — one observed maintenance
fact. *Source* — an upstream service consulted for a latest version.
*Observed* — the version currently declared in a repository file.

---

## SCH — Schema and stage separation

| Id | Pattern | Requirement |
| --- | --- | --- |
| **REQ-SCH-001** | Ubiquitous | The collect stage shall emit a report conforming to `schemas/maintenance-report.v1.json`. |
| **REQ-SCH-002** | Ubiquitous | The collect stage shall not emit an `assessment`, `recommendation`, `issue`, or any other judgement field on a Finding. |
| **REQ-SCH-003** | Unwanted | If a Finding object carries a property not declared in the Finding schema, then parsing shall fail and the report shall not be written. |
| **REQ-SCH-004** | Ubiquitous | The report shall declare `schemaVersion` and `stage`, with `stage` fixed to `collect`. |
| **REQ-SCH-005** | Ubiquitous | The JSON Schema artifact shall be generated from the Zod schema, committed to the repository, and byte-identical across repeated generation. |
| **REQ-SCH-006** | Unwanted | If the Zod report schema contains a construct that cannot be represented in JSON Schema, then generation shall fail with an error naming the construct. |
| **REQ-SCH-007** | Ubiquitous | The `EnrichedFinding` schema shall accept every value that the `Finding` schema accepts. |
| **REQ-SCH-008** | Event-driven | When the committed JSON Schema differs from the schema generated from source, the test suite shall fail. |
| **REQ-SCH-009** | Ubiquitous | A Finding shall be emitted only when the condition its `kind` names holds; a subject already at its latest version shall produce no drift Finding. |
| **REQ-SCH-010** | Ubiquitous | Every Finding shall be assembled, scored and validated against the Finding schema by a single shared builder, so identity and severity cannot differ between collectors. |

## EVI — Evidence and provenance

| Id | Pattern | Requirement |
| --- | --- | --- |
| **REQ-EVI-001** | Ubiquitous | Every Finding shall carry at least one Evidence record. |
| **REQ-EVI-002** | Event-driven | When a Finding is derived from a file, the Evidence shall record the file path and, where the parser can determine it, the line number. |
| **REQ-EVI-003** | Event-driven | When a Finding is derived from a command, the Evidence shall record the argv, the working directory and the exit code. |
| **REQ-EVI-004** | Event-driven | When a Finding is derived from an HTTP response, the Evidence shall record the URL, the status code and the retrieval timestamp. |
| **REQ-EVI-005** | Ubiquitous | Every resolved latest version shall record the resolution method and a confidence level. |
| **REQ-EVI-006** | Ubiquitous | Evidence shall record observed facts only and shall not contain inferred or summarised content. |

## ID — Finding identity

| Id | Pattern | Requirement |
| --- | --- | --- |
| **REQ-ID-001** | Ubiquitous | A Finding's `fingerprint` shall be identical across runs while its subject and kind are unchanged, regardless of observed or latest version. |
| **REQ-ID-002** | Ubiquitous | A Finding's `fingerprint` shall be independent of line numbers, severity, and free-text title or detail. |
| **REQ-ID-003** | Event-driven | When two Findings concern the same package but different security advisories, the collect stage shall assign them different fingerprints. |
| **REQ-ID-004** | Ubiquitous | A Finding's `stateHash` shall change when any of observed version, latest version, bump classification, severity, unresolved state, or advisory fixed version changes. |
| **REQ-ID-005** | Ubiquitous | The `fingerprint` and `stateHash` shall be computed from a field order fixed in source and shall not depend on runtime key enumeration. |
| **REQ-ID-006** | Ubiquitous | Every Finding shall carry a human-readable `id` derived from the same inputs as its fingerprint. |
| **REQ-ID-007** | Ubiquitous | Every Finding shall record the fingerprint algorithm version under which it was computed. |

## SEV — Severity

| Id | Pattern | Requirement |
| --- | --- | --- |
| **REQ-SEV-001** | Ubiquitous | A Finding's severity shall be derived solely from the ordered rule table, and the matched rule id shall be recorded on the Finding. |
| **REQ-SEV-002** | Ubiquitous | The rule table shall be ordered by non-increasing severity tier. |
| **REQ-SEV-003** | Ubiquitous | Severity evaluation shall select the first matching rule and shall evaluate no further rules. |
| **REQ-SEV-004** | Event-driven | When a Finding is marked unresolved, the collect stage shall assign it severity `info` before evaluating the rule table. |
| **REQ-SEV-005** | Ubiquitous | Severity evaluation shall be a pure function of its declared inputs, performing no I/O and reading the current date only from the injected clock. |
| **REQ-SEV-050** | Complex | When a Finding's subject scope is `dev` and the matched rule is not an end-of-life rule and the resulting severity is above `low`, the collect stage shall reduce the severity by exactly one tier and record `dev-scope-demotion` in `modifiers`. |
| **REQ-SEV-051** | Ubiquitous | Scope demotion shall not reduce a severity below `low`. |
| **REQ-SEV-052** | Optional | Where a severity override matches a Finding by fingerprint or id and has not expired, the collect stage shall apply the override severity and record the source as `config-override`. |
| **REQ-SEV-053** | Ubiquitous | A severity override shall require both a reason and an expiry date. |
| **REQ-SEV-054** | Unwanted | If a severity override's expiry date is in the past, then the override shall be ignored and a `config-stale` Finding shall be emitted naming it. |
| **REQ-SEV-055** | Ubiquitous | CVSS scores shall not be an input to severity selection. |
| **REQ-SEV-056** | Event-driven | When an action pin is unpinned and its owner is not `actions` or `github`, the collect stage shall assign a higher severity than for an equivalent first-party action. |

## CFG — Configuration

| Id | Pattern | Requirement |
| --- | --- | --- |
| **REQ-CFG-001** | Ubiquitous | The collect stage shall read its inventory from a single declarative configuration file. |
| **REQ-CFG-002** | Ubiquitous | The configuration shall be validated against a schema before any collector runs. |
| **REQ-CFG-003** | Unwanted | If the configuration fails validation, then the collect stage shall exit with a non-zero status and shall not write a report. |
| **REQ-CFG-004** | Unwanted | If the configuration contains a property not declared in its schema, then validation shall fail. |
| **REQ-CFG-005** | Ubiquitous | The report shall record the configuration file path and a digest of its contents. |
| **REQ-CFG-006** | Ubiquitous | Every file read by a collector shall be named explicitly in the configuration; the collect stage shall not discover input files by globbing or directory traversal. |
| **REQ-CFG-007** | Optional | Where a collector is disabled in configuration, the runner shall record its status as `skipped` with a reason and shall not execute it. |

## NET — Network and offline behaviour

| Id | Pattern | Requirement |
| --- | --- | --- |
| **REQ-NET-020** | State-driven | While offline mode is active, the collect stage shall make no outbound network request. |
| **REQ-NET-021** | State-driven | While offline mode is active, every Finding requiring upstream resolution shall have `unresolved` set to true and a resolution method of `not-attempted`. |
| **REQ-NET-022** | State-driven | While offline mode is active, the collect stage shall still write a schema-valid report and exit zero. |
| **REQ-NET-023** | Ubiquitous | The collect stage shall request each distinct upstream reference at most once per run. |
| **REQ-NET-024** | Optional | Where a GitHub API token is available in the environment, the collect stage shall present it on requests to the GitHub API. |
| **REQ-NET-025** | Event-driven | When no GitHub API token is available, the collect stage shall log a warning at startup stating that results may be incomplete. |
| **REQ-NET-026** | Ubiquitous | Every outbound request shall be bounded by a timeout. |
| **REQ-NET-027** | Unwanted | If a request fails with a transient error, then the collect stage shall retry it a bounded number of times before classifying it as unresolved. |

## ERR — Errors, degradation and unresolved state

| Id | Pattern | Requirement |
| --- | --- | --- |
| **REQ-ERR-030** | Unwanted | If an upstream source cannot be reached, then the collector shall emit the Finding with `unresolved` true and a non-null reason, and shall not omit the Finding. |
| **REQ-ERR-031** | Unwanted | If a collector throws, then the runner shall record its status as `failed` and emit one synthetic Finding recording the failure. |
| **REQ-ERR-032** | Unwanted | If an upstream response indicates rate limiting, then the error shall be classified as `rate-limited` and marked retryable. |
| **REQ-ERR-033** | Event-driven | When a collector produces both Findings and errors, the runner shall record its status as `partial`. |
| **REQ-ERR-034** | Event-driven | When a collector produces errors and no Findings, the runner shall record its status as `failed`. |
| **REQ-ERR-035** | Event-driven | When a collector produces no errors, the runner shall record its status as `ok`. |
| **REQ-ERR-036** | Ubiquitous | Every recorded error shall carry a machine-readable code, a message, and a retryable flag. |
| **REQ-ERR-037** | Ubiquitous | A collector failure shall not prevent other collectors from running or the report from being written. |

## RPT — Report assembly

| Id | Pattern | Requirement |
| --- | --- | --- |
| **REQ-RPT-001** | Ubiquitous | The report shall contain one collector run record for every configured collector, including skipped ones. |
| **REQ-RPT-002** | Ubiquitous | Findings shall be ordered by descending severity, then collector, then id. |
| **REQ-RPT-003** | Ubiquitous | The report summary counts shall equal the counts derived from the Findings array. |
| **REQ-RPT-004** | Ubiquitous | Two runs over unchanged inputs shall produce reports differing only in timestamp fields. |
| **REQ-RPT-005** | Ubiquitous | Elapsed durations shall be derived from the injected clock. |
| **REQ-RPT-006** | Ubiquitous | The report shall record the runtime environment, including Node version, platform and whether the run was offline. |
| **REQ-RPT-007** | Event-driven | When report assembly completes, the collect stage shall validate the report against its schema before writing it. |

## CLI — Command line

| Id | Pattern | Requirement |
| --- | --- | --- |
| **REQ-CLI-001** | Ubiquitous | The CLI shall accept flags for configuration path, output path, collector selection, offline mode, log level, and a severity threshold for the exit code. |
| **REQ-CLI-002** | Ubiquitous | The CLI shall exit zero when collection completes, regardless of how many Findings were produced. |
| **REQ-CLI-003** | Optional | Where a severity threshold is supplied, the CLI shall exit non-zero when any Finding meets or exceeds it. |
| **REQ-CLI-004** | Unwanted | If an unrecognised flag is supplied, then the CLI shall exit non-zero with a message naming the flag. |
| **REQ-CLI-005** | Optional | Where the report is written to standard output, the CLI shall suppress all non-error log output so the stream remains valid JSON. |
| **REQ-CLI-006** | Optional | Where a collector subset is selected, the runner shall record the unselected collectors as `skipped` with a reason. |
| **REQ-CLI-007** | Ubiquitous | The CLI shall write diagnostics through the project logger and shall not write directly to the console. |

## NPM — npm collector

| Id | Pattern | Requirement |
| --- | --- | --- |
| **REQ-NPM-010** | Event-driven | When the npm collector runs, it shall derive the declared dependency set from `package.json`, including `devDependencies`. |
| **REQ-NPM-011** | Event-driven | When `npm outdated` exits with status 0 or 1 and emits parseable JSON, the collector shall treat the invocation as successful. |
| **REQ-NPM-012** | Event-driven | When `npm audit` exits with status 0 or 1 and emits parseable JSON, the collector shall treat the invocation as successful. |
| **REQ-NPM-013** | Unwanted | If either npm command exits with a status other than 0 or 1, or emits unparseable output, then the collector shall record a `command-failed` error and continue using the remaining inputs. |
| **REQ-NPM-014** | Event-driven | When a declared dependency is absent from the `npm outdated` output, the collector shall resolve its latest version from the registry. |
| **REQ-NPM-015** | Ubiquitous | The collector shall emit one Finding per package and advisory pair. |
| **REQ-NPM-016** | Event-driven | When an advisory chain entry is a plain string rather than an advisory object, the collector shall not create an advisory from it. |
| **REQ-NPM-017** | Event-driven | When the registry reports a package version as deprecated, the collector shall emit a deprecation Finding. |
| **REQ-NPM-018** | Ubiquitous | Each dependency Finding shall record whether the dependency is a runtime or development dependency. |
| **REQ-NPM-019** | Unwanted | If the npm executable is unavailable, then the collector shall emit Findings derived from the manifest and registry alone and record its status as `partial`. |
| **REQ-NPM-020** | Ubiquitous | Command output buffering shall be bounded by an explicit limit. |

## GHA — GitHub Actions collector

| Id | Pattern | Requirement |
| --- | --- | --- |
| **REQ-GHA-010** | Event-driven | When a workflow step's action reference is not a 40-character commit SHA and SHA pinning is required, the collector shall emit an unpinned-action Finding. |
| **REQ-GHA-011** | Ubiquitous | The collector shall report the line number of each action reference as it appears in the workflow file. |
| **REQ-GHA-012** | Ubiquitous | The collector shall examine both job step references and reusable workflow references. |
| **REQ-GHA-013** | Event-driven | When an action reference names a subdirectory within a repository, the collector shall resolve the version against the containing repository. |
| **REQ-GHA-014** | Event-driven | When an action reference is a local path, the collector shall skip it without emitting a Finding or an error. |
| **REQ-GHA-015** | Unwanted | If the latest version of a referenced action cannot be resolved, then the collector shall emit the Finding as unresolved rather than omitting it. |
| **REQ-GHA-016** | Unwanted | If a workflow file cannot be parsed, then the collector shall record a `parse-error` naming the file and continue with the remaining files. |
| **REQ-GHA-017** | Event-driven | When an action reference states fewer version components than the resolved latest version, the collector shall compare only the components the reference states, and shall still record the full latest version. |
| **REQ-GHA-018** | Ubiquitous | The collector shall emit at most one Finding of each kind per referenced repository, carrying every occurrence of that repository as evidence. |
| **REQ-GHA-019** | Event-driven | When an action is pinned by commit SHA, the collector shall read its version from a trailing version comment, and where none is present shall report that the version could not be determined. |

## ARC — Actions Runner Controller collector

| Id | Pattern | Requirement |
| --- | --- | --- |
| **REQ-ARC-010** | Event-driven | When the ARC collector runs, it shall read the controller chart version, the scale-set chart version and the runner image reference from the declared values files. |
| **REQ-ARC-011** | Ubiquitous | The collector shall resolve chart versions from the published OCI chart repositories. |
| **REQ-ARC-012** | Event-driven | When the declared controller chart version and scale-set chart version differ, the collector shall emit a version-skew Finding naming both. |
| **REQ-ARC-013** | Ubiquitous | The collector shall report the line number of each declared version as it appears in its values file. |
| **REQ-ARC-014** | Unwanted | If a declared values file is missing, then the collector shall record a `not-found` error naming the file and continue with the remaining targets. |
| **REQ-ARC-015** | Unwanted | If the configured path within a values file does not resolve, then the collector shall record a `config-error` naming the path. |

## EKS — EKS collector

| Id | Pattern | Requirement |
| --- | --- | --- |
| **REQ-EKS-010** | Event-driven | When the EKS collector runs, it shall read the cluster version and addon versions from the declared inventory file. |
| **REQ-EKS-011** | Ubiquitous | The collector shall resolve supported cluster versions and their support dates from the committed support calendar by default. |
| **REQ-EKS-012** | Event-driven | When the support calendar's last-verified date is older than its configured staleness window, the collector shall emit a `config-stale` Finding. |
| **REQ-EKS-013** | Event-driven | When a declared cluster version has passed or is approaching its end of standard support, the collector shall emit a Finding carrying the support dates and the remaining days. |
| **REQ-EKS-014** | Unwanted | If the declared cluster version has no entry in the support calendar, then the collector shall emit an unresolved Finding and record a `config-error`. |
| **REQ-EKS-015** | Ubiquitous | The collector shall compare addon versions on their semantic version core while recording the full declared string. |
| **REQ-EKS-016** | Ubiquitous | Upstream Kubernetes release information shall not determine the latest cluster version and shall not influence severity. |
| **REQ-EKS-040** | Optional | Where the latest-version strategy includes the AWS CLI, the collector shall invoke `aws eks describe-cluster-versions` and record a confidence of `high` on success. |
| **REQ-EKS-041** | Optional | Where the AWS CLI invocation fails, the collector shall fall back to the support calendar, record the downgraded method and confidence, and record a non-fatal error. |

## IMG — Container image collector

| Id | Pattern | Requirement |
| --- | --- | --- |
| **REQ-IMG-010** | Event-driven | When the image collector runs, it shall extract base image references and declared tool versions from each configured Dockerfile. |
| **REQ-IMG-011** | Event-driven | When a base image reference names a preceding build stage, the collector shall not treat it as a registry reference. |
| **REQ-IMG-012** | Event-driven | When a base image tag is composed from build arguments with in-file defaults, the collector shall resolve the substitution. |
| **REQ-IMG-013** | Unwanted | If a build argument used in a base image reference cannot be resolved, then the collector shall emit the Finding as unresolved with a reason. |
| **REQ-IMG-014** | Event-driven | When a base image tag corresponds to a distribution codename, the collector shall resolve its support dates from the distribution calendar and emit an end-of-life Finding when support has lapsed or is approaching. |
| **REQ-IMG-015** | Ubiquitous | Every configured base image shall declare a tag filter, and candidate tags shall be restricted to those matching it before version comparison. |
| **REQ-IMG-016** | Unwanted | If no candidate tag matches the configured filter, then the collector shall emit the Finding as unresolved with a reason naming the filter. |
| **REQ-IMG-017** | Event-driven | When a base image is pinned by digest, the collector shall record the pin and shall not report it as drift. |
| **REQ-IMG-018** | Ubiquitous | The collector shall report the line number of each base image reference and tool pin. |
| **REQ-IMG-019** | Event-driven | When a configured tool pin pattern matches no line in a Dockerfile, the collector shall emit no Finding for that pin and shall not error. |
| **REQ-IMG-020** | Unwanted | If a Dockerfile declares a base image that the configuration does not, then the collector shall emit a `config-stale` Finding naming the image rather than passing over it. |
| **REQ-IMG-021** | Event-driven | When the distribution calendar's `lastVerified` is older than `staleAfterDays`, the collector shall emit a `config-stale` Finding naming the calendar. |
| **REQ-IMG-022** | Unwanted | If a base image tag is read as a distribution codename and the calendar has no entry for it, then the collector shall emit a `config-stale` Finding naming the codename. |

## WFL — Scheduled workflow

| Id | Pattern | Requirement |
| --- | --- | --- |
| **REQ-WFL-001** | Ubiquitous | The scan workflow shall run on a schedule and shall be manually dispatchable. |
| **REQ-WFL-002** | Ubiquitous | The scan workflow shall request no repository permission beyond reading contents. |
| **REQ-WFL-003** | Ubiquitous | The scan workflow shall upload the report as an artifact even when the run degrades or fails. |
| **REQ-WFL-004** | Ubiquitous | The scan workflow shall pin every action it uses to a full commit SHA. |
| **REQ-WFL-005** | Ubiquitous | The scan workflow shall be included in the set of workflows the collector scans. |
| **REQ-WFL-006** | Ubiquitous | The scan workflow shall fail only when the tooling fails, and not because Findings were produced. |

## P2 — Assess and publish stages

All `DEFERRED` to pass 2. Recorded here so the pass-1 contract is built against
a known target.

| Id | Pattern | Requirement | Status |
| --- | --- | --- | --- |
| **REQ-P2-001** | Ubiquitous | The assess stage shall emit `EnrichedFinding` objects conforming to the enriched schema. | DEFERRED |
| **REQ-P2-002** | Ubiquitous | The assess stage shall not modify any field produced by the collect stage. | DEFERRED |
| **REQ-P2-003** | Ubiquitous | The assess stage shall express any severity disagreement as a proposal and shall not overwrite the computed severity. | DEFERRED |
| **REQ-P2-004** | Ubiquitous | Every claim added by the assess stage shall cite a source URL with a trust classification and a retrieval timestamp. | DEFERRED |
| **REQ-P2-005** | Event-driven | When no open issue matches a Finding's fingerprint, the publish stage shall create one. | DEFERRED |
| **REQ-P2-006** | Event-driven | When an open issue matches a Finding's fingerprint and its state hash is unchanged, the publish stage shall make no modification. | DEFERRED |
| **REQ-P2-007** | Event-driven | When an open issue matches a Finding's fingerprint and its state hash has changed, the publish stage shall update the issue body and record what changed. | DEFERRED |
| **REQ-P2-008** | Event-driven | When an open issue's fingerprint is absent from the current run, the publish stage shall mark it as a candidate for closure. | DEFERRED |
| **REQ-P2-009** | Ubiquitous | The publish stage shall not create issues for unresolved Findings, which are operational signal about the scan rather than maintenance work. | DEFERRED |

---

## Traceability

Completed at implementation step 13. Every row must resolve in both directions:
a requirement with no verifying spec is untested, and a spec citing an id that
no longer exists is stale. Verified by grepping ids across `src/maintenance/`
and `test/`.

| Requirement | Implemented in | Verified by |
| --- | --- | --- |
| REQ-SCH-001…010 | `schema/report.ts`, `schema/json-schema.ts`, `collectors/build-finding.ts` | `test/maintenance-schema.spec.ts`, `test/maintenance-json-schema.spec.ts`, `test/maintenance-build-finding.spec.ts` |
| REQ-EVI-001…006 | `schema/common.ts`, all collectors | `test/maintenance-schema.spec.ts`, per-collector specs |
| REQ-ID-001…007 | `identity/fingerprint.ts` | `test/maintenance-fingerprint.spec.ts` |
| REQ-SEV-001…056 | `severity/rules.ts`, `severity/facts.ts` | `test/maintenance-severity.spec.ts` |
| REQ-CFG-001…007 | `schema/config.ts`, `config/load-config.ts` | `test/maintenance-config.spec.ts` |
| REQ-NET-020…027 | `http/http-client.ts`, `http/offline-http-client.ts`, `sources/source-registry.ts` | `test/maintenance-http-client.spec.ts`, `test/maintenance-sources.spec.ts` |
| REQ-ERR-030…037 | `collectors/collector.ts`, `errors.ts` | `test/maintenance-runner.spec.ts` |
| REQ-RPT-001…007 | `runner.ts` | `test/maintenance-runner.spec.ts` |
| REQ-CLI-001…007 | `cli.ts` | `test/maintenance-cli.spec.ts` |
| REQ-NPM-010…020 | `collectors/npm.ts`, `parsers/npm-*.ts`, `exec/command-runner.ts` | `test/maintenance-collector-npm.spec.ts`, `test/maintenance-command-runner.spec.ts` |
| REQ-GHA-010…019 | `collectors/github-actions.ts`, `parsers/workflow-yaml.ts` | `test/maintenance-collector-github-actions.spec.ts` |
| REQ-ARC-010…015 | `collectors/arc.ts` | `test/maintenance-collector-arc.spec.ts` |
| REQ-EKS-010…041 | `collectors/eks.ts`, `sources/eks-source.ts` | `test/maintenance-collector-eks.spec.ts` |
| REQ-IMG-010…022 | `collectors/images.ts`, `parsers/dockerfile.ts`, `parsers/tool-pins.ts` | `test/maintenance-collector-images.spec.ts` |
| REQ-WFL-001…006 | `.github/workflows/maintenance-scan.yml` | Reviewed at step 12; REQ-WFL-005 verified by `test/maintenance.e2e.spec.ts` |
| REQ-P2-001…008 | — | DEFERRED to pass 2 |
