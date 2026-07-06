# Docs-as-Code Knowledge Base — AWS Architecture

An enterprise RAG + reader portal built on the Pulumi layered-stack foundation. GitHub is the
control plane; AWS does CI offload, Bedrock RAG, a static reader portal, and a license-free
writer proxy. This document maps the corrected architecture onto the five deployment layers and
points at the code that implements each correction.

## Corrections encoded in this build

| #   | Correction                                                                                                       | Where it lives                                                         |
| --- | ---------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| 1   | **Authorization ≠ authentication.** Per-user metadata ACL filtering at retrieval, fail-closed.                   | `src/rag/acl-filter.ts`, `functions/chat-api/index.mjs`                |
| 2   | **Vector store cost.** Aurora pgvector (scale-to-zero) instead of the always-on OpenSearch Serverless OCU floor. | `src/components/bedrock`, `src/stacks/stateful-data.ts`                |
| 3   | **Deletions reconciled.** Versioned bucket + `aws s3 sync --delete` + data source `DELETE` policy.               | `src/stacks/stateful-data.ts`, `src/components/bedrock`                |
| 4   | **Ingestion is explicit.** `S3 event → Lambda → StartIngestionJob` (a put does not auto-reindex).                | `src/stacks/svc-platform.ts`, `functions/ingestion-trigger`            |
| 5   | **SSO is enforced, not assumed.** Cognito federation + edge SSO gate + JWT-authorized APIs.                      | `src/components/cognito`, `src/components/cdn`, `src/components/apigw` |
| 6   | **PR attribution.** SSO user stamped into the commit trailer and PR body by the writer proxy.                    | `functions/writer-proxy/index.mjs`                                     |
| 7   | **Guardrails + citations.** PII redaction, grounding/relevance thresholds, refuse-on-empty.                      | `src/components/bedrock`, `functions/chat-api`                         |
| 8   | **Data residency.** PrivateLink endpoints for Bedrock / Secrets / RDS-Data + S3 gateway endpoint.                | `src/stacks/net-foundation.ts`                                         |
| 9   | **Model naming hygiene.** Model + embedding referenced by family alias / config, not a frozen legacy version.    | `src/stacks/shared.ts`, `src/stacks/workloads.ts`                      |

## Layer mapping

| Layer (project)  | Scope   | Provisions                                                                                                                                             |
| ---------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `acct-baseline`  | Account | GitHub Actions OIDC provider + least-privilege CI deploy role (no static keys).                                                                        |
| `net-foundation` | Region  | VPC, private subnets, PrivateLink interface endpoints (Bedrock/Secrets/RDS-Data), S3 gateway endpoint.                                                 |
| `stateful-data`  | Region  | Versioned raw docs bucket (TLS-only), Aurora PostgreSQL Serverless v2 + pgvector (Data API, min ACU 0), credentials secret, pgvector schema bootstrap. |
| `svc-platform`   | Region  | Bedrock Knowledge Base (Aurora storage), Guardrail, S3-event ingestion trigger Lambda.                                                                 |
| `workload`       | Region  | Cognito SSO, reader portal (S3 + CloudFront + WAF + edge SSO), chat/retrieve API, writer proxy.                                                        |

Cross-layer values (bucket ARNs, cluster ARN, KB id, …) flow through Pulumi stack **config**: each
layer publishes its outputs and the next layer reads them, so a layer cleanly no-ops (with a
warning) until its upstream is deployed. This matches the Automation-API orchestration in
`src/index.ts`.

## The authorization model (the blocker — fixed)

SSO/WAF at the front door proves _who_ the caller is. It does nothing to stop the RAG engine from
retrieving a document that caller should not see. The fix has two halves that must agree on the
same metadata keys:

- **Ingestion side** (`src/rag/metadata.ts`) emits a `.metadata.json` sidecar per doc carrying
  `visibility_groups` (from repo permissions + front-matter) and a numeric `classification_level`.
  Bedrock stores these as filterable metadata on every chunk.
- **Retrieval side** (`src/rag/acl-filter.ts`) resolves the caller's IdP groups from the validated
  SSO token and builds a metadata filter — an OR of `listContains` clauses over the caller's
  groups (intersection semantics), optionally AND-ed with a `classification_level` ceiling. Every
  `RetrieveAndGenerate` call carries it, so restricted chunks never reach the model.

The filter is **fail-closed**: a caller with no resolvable groups can match only `public` docs, and
excluding public with no groups throws rather than returning a permissive filter.

## Deploy-ordering notes

- **pgvector schema first.** `CreateKnowledgeBase` validates that the extension, table, and vector
  index already exist. The `stateful-data` layer provisions them with a one-time Data-API bootstrap
  Lambda (`functions/pgvector-bootstrap`) before `svc-platform` creates the KB.
- **Global resources pin us-east-1.** CLOUDFRONT-scoped WAF WebACLs and CloudFront ACM certs must
  live in us-east-1; the CDN component creates the WebACL through an explicit us-east-1 provider so
  the workload layer deploys correctly from any region.

> **Stronger option:** because the vector store is Aurora PostgreSQL, tenants that need a hard
> guarantee can additionally enforce **row-level security** in the database (pgvector 0.8.0+ with
> HNSW iterative scans), making isolation a DB property rather than an application-layer filter.

## Cost posture

The vector store choice is the biggest lever. Aurora Serverless v2 with `minCapacity: 0`
scale-to-zero avoids the OpenSearch Serverless ~4-OCU (~$700/mo) always-on floor and the trap where
deleting a Knowledge Base leaves the OpenSearch collection billing indefinitely. Combined with
Haiku-class model routing, prompt caching on the stable system prompt, a reranker to send fewer
chunks, and `MaxTokens`/per-user throttling, the honest monthly figure is low single-digit
thousands — still an order of magnitude under per-seat licensing for the same reader population.

## Deployment

```bash
# Foundation first (account OIDC + regional network)
npm run deploy:foundation

# Data + platform (buckets, Aurora, Bedrock KB, ingestion)
npm run deploy:platform

# Everything, in dependency order
npm run deploy:dev
```

Each layer reads its upstream's published outputs from stack config; see the per-stack file headers
for the exact config keys.
