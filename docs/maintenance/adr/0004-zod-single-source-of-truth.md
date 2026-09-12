# ADR-0004 — Zod is the single source of truth for the contract

**Status:** Accepted · **Date:** 2026-09-12 · **Relates to:** REQ-SCH-001, REQ-SCH-005, REQ-SCH-006, REQ-SCH-008

## Context

The report is consumed by a downstream stage that is not necessarily
TypeScript, so a JSON Schema artifact has to exist. Three ways to arrange that:

1. Hand-write JSON Schema, generate TypeScript types from it, validate at
   runtime with Ajv.
2. Define in Zod, infer TypeScript types, emit JSON Schema.
3. Use the repository's existing `class-validator` decorators.

## Decision

Option 2. Zod 4 defines the schema; TypeScript types come from `z.infer`; the
JSON Schema artifact is emitted by Zod's **native** `z.toJSONSchema()` and
committed.

No `zod-to-json-schema` package: Zod 4 does this itself, and a separate
generator is a second source of truth that can disagree with the Zod version
defining the schema.

Emission uses `unrepresentable: 'throw'` and `cycles: 'throw'`. Committed
output is byte-stable, and CI regenerates it and fails on any diff, reusing the
`git diff --exit-code` gate the repository already trusts.

## Consequences

- One definition drives runtime validation, static types and the published
  contract. They cannot drift.
- `unrepresentable: 'throw'` turns "someone added a `z.date()` or a
  `.transform()`" into a loud generation failure rather than a silently
  weakened published schema. This is why the report schema forbids defaults and
  transforms outright — those belong to the config schema.
- `z.strictObject` on `Finding` makes stage separation mechanical: a judgement
  key on a collector's output is a parse failure, not a review comment.
- A Zod patch release could reorder emitted output and turn CI red with a
  confusing diff. That is the check working; the fix is a regeneration commit.
- `class-validator` remains in the repository for the existing example code and
  is not used by this subsystem.

## What would reverse this

A consumer needing a JSON Schema dialect Zod cannot emit, or Zod's emitter
proving unstable enough that regeneration commits become routine noise rather
than rare.
