# JSON Schema artifacts

**Generated — do not hand-edit.** These files are emitted from the Zod schemas
in `src/maintenance/schema/` by `npm run schema:emit`, and CI fails if a
committed artifact is stale.

They exist so a consumer that is not TypeScript can validate a maintenance
report.

See [docs/maintenance/schema-contract.md](../docs/maintenance/schema-contract.md)
for the field reference and the versioning policy — in particular, what counts
as an additive change to `v1` and what forces a `v2`.
