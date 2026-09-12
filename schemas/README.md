# JSON Schema artifacts

**Generated — do not hand-edit.** These files are emitted from the Zod schemas in
`src/maintenance/schema/` by `npm run schema:emit`, and CI regenerates them and fails
on any diff.

They exist so a consumer that is not TypeScript can validate a maintenance report.

| File | Contents |
| --- | --- |
| `maintenance-report.v1.json` | The collect-stage report, draft 2020-12 |

## Validating a report

`format` is annotation-only in JSON Schema unless a validator opts in, so Ajv needs its
formats add-on — otherwise it reports `unknown format "date-time" ignored`:

```bash
npx -p ajv-cli@5 -p ajv-formats@3 ajv validate --spec=draft2020 -c ajv-formats \
  -s schemas/maintenance-report.v1.json -d report.json
```

The schema validates under Ajv's **strict** mode, deliberately: it carries no custom
`x-` keywords, so no consumer has to relax their validator to use it. The report
schema version is expressed the standard way, as
`properties.schemaVersion.const`.

Findings are strict objects (`additionalProperties: false`), so the collect/assess
stage separation is enforced here too — a report whose findings carry an `assessment`
key is rejected by any conforming validator, not merely by the TypeScript.

See [docs/maintenance/schema-contract.md](../docs/maintenance/schema-contract.md) for
the field reference and the versioning policy — in particular what counts as an
additive change to `v1` and what forces a `v2`.
