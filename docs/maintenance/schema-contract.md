# Schema contract

**Status:** Draft — reconciled against the emitted JSON Schema at implementation step 13
**Artifact:** `schemas/maintenance-report.v1.json` · **Source of truth:** `src/maintenance/schema/`
**Related:** [pipeline-overview.md](./pipeline-overview.md) · [adr/0004](./adr/0004-zod-single-source-of-truth.md)

The schema is defined in Zod and the JSON Schema artifact is generated from it,
committed, and checked for freshness in CI. Never hand-edit the JSON file.

## Top level — `MaintenanceReport`

| Field | Notes |
| --- | --- |
| `schemaVersion` | Literal. Bumped only per the policy below. |
| `stage` | Literal `collect` for pass-1 output. |
| `generatedAt` | The **only** field expected to differ between two runs over unchanged inputs. |
| `repository` | Name, owner, commit SHA, ref. |
| `runtime` | Node version, npm version, platform, whether the run was offline. |
| `config` | Path and digest of the configuration, so a report can be tied to the inventory that produced it. |
| `collectorRuns[]` | One per configured collector, including skipped ones. |
| `findings[]` | Sorted by descending severity, then collector, then id. |
| `summary` | Totals by severity and collector, unresolved count, worst status. |

## `Finding`

Strict: an undeclared property is a parse error, which is what keeps the assess
stage's fields out of collector output.

| Group | Fields | Notes |
| --- | --- | --- |
| Identity | `id`, `fingerprint`, `fingerprintVersion`, `stateHash` | See [ADR-0003](./adr/0003-two-hash-finding-identity.md). `fingerprint` is version-independent; `stateHash` is not. |
| Classification | `collector`, `kind`, `subject`, `title`, `detail`, `tags`, `discriminator` | `subject.id` is a global name where one exists, otherwise path-qualified but never line-qualified. |
| Versions | `versions.declared` / `.observed` / `.latest` / `.bump` / `.majorsBehind` | `declared` is literally what the file says (`^5.7.3`, `v4`, `bullseye`); `observed` is normalised. |
| Provenance | `latestResolution` | `status`, `version`, `ref`, `method`, `confidence`, `retrievedAt`, `reason`. |
| Risk | `severity`, `advisory`, `lifecycle` | `severity` carries the matched rule id, rule version, modifiers, source and reason. |
| State | `unresolved` | True when upstream truth could not be established. |
| Support | `remediationHint`, `references`, `evidence` | `remediationHint` is mechanical only. `evidence` has at least one entry. |

## `Evidence`

A discriminated union on `type`:

- **`file`** — `path`, `line`, `column`, `snippet`, `contentSha256`, plus
  `repo`/`ref`, which stay null until the GitHub Contents provider ships.
- **`command`** — `argv`, `cwd`, `exitCode`, `durationMs`, `stdoutSha256`,
  `stderrExcerpt`.
- **`http`** — `url`, `method`, `status`, `retrievedAt`, `etag`, `fromCache`.

Evidence records observed facts only. Nothing inferred or summarised belongs
here.

## `EnrichedFinding`

`Finding` extended with `assessment` and `issue`, both nullable. Produced only
by the assess stage. Every value accepted by `Finding` is accepted by
`EnrichedFinding` — asserted by a test, because a downstream stage that cannot
read collector output is a broken contract.

## Versioning policy

The JSON Schema is a published contract. Once a consumer validates against it:

| Change | Classification | Action |
| --- | --- | --- |
| Add an optional field | Minor | Stays in `v1`; bump `schemaVersion` minor |
| Add a value to an enum | Minor | Stays in `v1`; consumers must tolerate unknown values |
| Add a required field | **Breaking** | New `v2` artifact |
| Rename or remove a field | **Breaking** | New `v2` artifact |
| Narrow a type or tighten a constraint | **Breaking** | New `v2` artifact |
| Change severity rule outcomes | Not a schema change | Bump the rule table version instead |
| Change fingerprint inputs | Not a schema change | Bump `fingerprintVersion` — orphans existing issues on purpose |

A `v2` is a new file alongside `v1`, not a replacement. The producer declares
which version it emits; consumers pin.

## Deliberate constraints

- **No defaults, transforms or date objects in the report schema.** They do not
  survive JSON Schema emission cleanly. Defaults belong to the config schema.
  Emission runs with `unrepresentable: 'throw'` so a violation fails loudly.
- **Nullable rather than optional** for absent values, so the shape is stable
  and consumers need not distinguish "missing" from "not applicable".
- **Byte-stable output.** Regeneration produces an identical file; CI diffs it.
