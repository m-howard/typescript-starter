/**
 * JSON Schema emission.
 *
 * Pure so it is unit-testable and so the CI freshness check compares like with like;
 * `emit.ts` does the file I/O. The emitted artifact exists so a consumer that is not
 * TypeScript can validate a maintenance report (REQ-SCH-001, REQ-SCH-005).
 */

import { z } from 'zod';
import { MaintenanceReportSchema } from './report';

/** Canonical identifier for the report schema. Stable across patch releases. */
export const REPORT_SCHEMA_ID =
    'https://github.com/m-howard/typescript-starter/schemas/maintenance-report.v1.json';

/** Path of the committed artifact, relative to the repository root. */
export const REPORT_JSON_SCHEMA_PATH = 'schemas/maintenance-report.v1.json';

/**
 * Emission options shared by every artifact.
 *
 * `unrepresentable: 'throw'` is the canary: if someone adds a `z.date()` or a
 * `.transform()` to a report schema, generation fails loudly rather than silently
 * publishing a schema the downstream stage cannot enforce (REQ-SCH-006).
 *
 * `reused` is deliberately omitted. `.meta({ id })` is what produces a `$defs` entry;
 * `reused: 'ref'` additionally hoists *unnamed* reused subschemas under generated
 * `__schema0…N` names, which are unstable across zod versions and would churn a
 * published contract against the byte-stability check for no benefit.
 */
const EMIT_OPTIONS = {
    target: 'draft-2020-12',
    io: 'output',
    unrepresentable: 'throw',
    cycles: 'throw',
} as const;

/** A generated schema file: where it belongs and exactly what should be in it. */
export interface SchemaArtifact {
    /** Repository-relative path. */
    path: string;
    /** Full file contents, terminating newline included. */
    contents: string;
}

/**
 * Build the JSON Schema document for a maintenance report.
 *
 * Zod emits its own `$schema` key, so the document is rebuilt with a fixed key order
 * rather than spread over one — key order is part of byte stability.
 */
export function buildReportJsonSchema(): Record<string, unknown> {
    const { $schema, ...rest } = z.toJSONSchema(MaintenanceReportSchema, EMIT_OPTIONS) as Record<
        string,
        unknown
    >;
    // No custom `x-` keyword for the schema version: Ajv's strict mode rejects unknown
    // keywords, and `properties.schemaVersion.const` already carries it in standard
    // form. A published contract should validate without consumers relaxing their
    // validator.
    return {
        $schema,
        $id: REPORT_SCHEMA_ID,
        title: 'Maintenance report (collect stage)',
        description:
            'Deterministic inventory of maintenance drift across the self-hosted runner ' +
            'fleet. Produced by the collect stage; consumed by the assess stage.',
        ...rest,
    };
}

/** Serialise a schema document exactly as it is committed. */
export function serializeJsonSchema(document: Record<string, unknown>): string {
    return `${JSON.stringify(document, null, 4)}\n`;
}

/**
 * Every schema artifact this repository publishes.
 *
 * Returned as data so the emitter and the freshness check share one definition of what
 * "up to date" means, and so adding an artifact is a one-line change here.
 */
export function buildSchemaArtifacts(): SchemaArtifact[] {
    return [
        {
            path: REPORT_JSON_SCHEMA_PATH,
            contents: serializeJsonSchema(buildReportJsonSchema()),
        },
    ];
}
