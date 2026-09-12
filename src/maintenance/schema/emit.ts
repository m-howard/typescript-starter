/**
 * Writes the generated JSON Schema artifacts.
 *
 * Kept deliberately thin — everything worth testing lives in `json-schema.ts`. Run via
 * `npm run schema:emit`; CI regenerates and fails on any diff.
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import { SchemaArtifact, buildSchemaArtifacts } from './json-schema';

/** Writes each artifact under `rootDir`, creating directories as needed. */
export async function emitSchemas(
    rootDir: string,
    artifacts: SchemaArtifact[] = buildSchemaArtifacts(),
): Promise<string[]> {
    const written: string[] = [];
    for (const artifact of artifacts) {
        const target = path.join(rootDir, artifact.path);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, artifact.contents, 'utf8');
        written.push(artifact.path);
    }
    return written;
}

/* istanbul ignore next -- CLI entry point; emitSchemas carries the logic and the tests. */
if (require.main === module) {
    emitSchemas(process.cwd())
        .then((written) => {
            process.stdout.write(`Wrote ${written.join(', ')}\n`);
        })
        .catch((error: unknown) => {
            process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
            process.exitCode = 1;
        });
}
