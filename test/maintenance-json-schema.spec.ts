import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { z } from 'zod';
import {
    REPORT_JSON_SCHEMA_PATH,
    REPORT_SCHEMA_ID,
    buildReportJsonSchema,
    buildSchemaArtifacts,
    serializeJsonSchema,
} from '../src/maintenance/schema/json-schema';
import { emitSchemas } from '../src/maintenance/schema/emit';
import { REPORT_SCHEMA_VERSION } from '../src/maintenance/schema';

const REPO_ROOT = path.join(__dirname, '..');

describe('buildReportJsonSchema', () => {
    const document = buildReportJsonSchema();

    it('should emit without throwing, which is the unrepresentable canary [REQ-SCH-006]', () => {
        expect(() => buildReportJsonSchema()).not.toThrow();
    });

    it('should throw when a schema contains a construct JSON Schema cannot express', () => {
        expect(() =>
            z.toJSONSchema(z.object({ when: z.date() }), { unrepresentable: 'throw' }),
        ).toThrow(/cannot be represented in JSON Schema/i);
    });

    it('should declare draft 2020-12 exactly once', () => {
        expect(document.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
        expect(Object.keys(document).filter((key) => key === '$schema')).toHaveLength(1);
    });

    it('should carry a stable identifier', () => {
        expect(document.$id).toBe(REPORT_SCHEMA_ID);
    });

    it('should express the schema version in standard form, not a custom keyword', () => {
        const properties = document.properties as Record<string, { const?: unknown }>;

        expect(properties.schemaVersion.const).toBe(REPORT_SCHEMA_VERSION);
        expect(Object.keys(document).filter((key) => key.startsWith('x-'))).toEqual([]);
    });

    it('should keep properties at the root rather than degenerating to a $ref', () => {
        expect(document.$ref).toBeUndefined();
        expect(document.type).toBe('object');
        expect(document.properties).toBeDefined();
        expect(document.additionalProperties).toBe(false);
    });

    it('should name every reused subschema, with no generated __schema names', () => {
        const defs = Object.keys(document.$defs as Record<string, unknown>);

        expect(defs.filter((name) => name.startsWith('__'))).toEqual([]);
        expect(defs).toEqual(expect.arrayContaining(['Finding', 'Evidence', 'Severity']));
    });

    it('should reference Finding out of $defs so consumers can address it', () => {
        const properties = document.properties as Record<string, { items?: unknown }>;

        expect(properties.findings.items).toEqual({ $ref: '#/$defs/Finding' });
    });
});

describe('serializeJsonSchema', () => {
    it('should be byte-identical across repeated generation [REQ-SCH-005]', () => {
        expect(serializeJsonSchema(buildReportJsonSchema())).toBe(
            serializeJsonSchema(buildReportJsonSchema()),
        );
    });

    it('should end with exactly one trailing newline', () => {
        const serialized = serializeJsonSchema(buildReportJsonSchema());

        expect(serialized.endsWith('}\n')).toBe(true);
        expect(serialized.endsWith('}\n\n')).toBe(false);
    });

    it('should produce parseable JSON', () => {
        expect(() => JSON.parse(serializeJsonSchema(buildReportJsonSchema()))).not.toThrow();
    });
});

describe('committed artifacts', () => {
    it('should match the schema generated from source [REQ-SCH-008]', async () => {
        for (const artifact of buildSchemaArtifacts()) {
            const committed = await fs.readFile(path.join(REPO_ROOT, artifact.path), 'utf8');

            expect(committed).toBe(artifact.contents);
        }
    });

    it('should include the report schema', () => {
        expect(buildSchemaArtifacts().map((artifact) => artifact.path)).toContain(
            REPORT_JSON_SCHEMA_PATH,
        );
    });
});

describe('emitSchemas', () => {
    let workDir: string;

    beforeEach(async () => {
        workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'maintenance-schema-'));
    });

    afterEach(async () => {
        await fs.rm(workDir, { recursive: true, force: true });
    });

    it('should write every artifact and report what it wrote', async () => {
        const written = await emitSchemas(workDir);

        expect(written).toEqual(buildSchemaArtifacts().map((artifact) => artifact.path));
        for (const artifact of buildSchemaArtifacts()) {
            await expect(fs.readFile(path.join(workDir, artifact.path), 'utf8')).resolves.toBe(
                artifact.contents,
            );
        }
    });

    it('should create missing directories rather than failing', async () => {
        const nested = path.join(workDir, 'a', 'b');

        await expect(emitSchemas(nested)).resolves.not.toHaveLength(0);
    });

    it('should overwrite a stale artifact', async () => {
        const target = path.join(workDir, REPORT_JSON_SCHEMA_PATH);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, 'stale', 'utf8');

        await emitSchemas(workDir);

        await expect(fs.readFile(target, 'utf8')).resolves.not.toBe('stale');
    });
});
