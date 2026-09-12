# Runner fleet maintenance automation

Documentation for the agent-driven maintenance pipeline that keeps the
ARC-on-EKS self-hosted runner fleet current.

## Start here

| Document | Read it when |
| --- | --- |
| [project-brief.md](./project-brief.md) | You want the problem, the scope and how success is measured |
| [pipeline-overview.md](./pipeline-overview.md) | You want the stages, what each may write, and how to read a report |
| [runbook.md](./runbook.md) | You are running a scan, triaging output, or extending the tool |

## Specification

| Document | Contents |
| --- | --- |
| [requirements.md](./requirements.md) | EARS requirements with stable ids, plus the traceability matrix |
| [schema-contract.md](./schema-contract.md) | Field reference for the report and the `v1` versioning policy |
| [pass-2-interface.md](./pass-2-interface.md) | The written target for the assess and publish stages |
| [technical-research.md](./technical-research.md) | Probe evidence and option evaluations behind the decisions |
| [adr/](./adr/README.md) | Seven decision records, each with what would reverse it |

## Status

**Pass 1 — collect stage:** in progress. Deterministic collectors, the schema,
the committed inventory, and a scheduled collect-only workflow.

**Pass 2 — assess and publish:** not started. Specified in
[pass-2-interface.md](./pass-2-interface.md); its schema is already defined and
tested so the collect stage cannot drift away from it.

## Conventions

- Requirements have stable ids (`REQ-<AREA>-<nnn>`) and are never renumbered.
  Specs cite the id in the test title so traceability is checkable by grep.
- Decisions that could have gone the other way get an ADR, not a code comment.
- Documents are written before the code they specify, and reconciled against it
  once it ships.
