/**
 * Loading and validating the inventory of record.
 *
 * Reads through the `FileProvider` seam, parses YAML, validates against the config
 * schema, and records a digest so a report can be tied to the inventory that produced
 * it (REQ-CFG-001, REQ-CFG-002, REQ-CFG-005).
 *
 * A configuration that does not validate stops the run before any collector executes:
 * scanning against a half-understood inventory produces findings nobody can trust
 * (REQ-CFG-003).
 */

import { createHash } from 'crypto';
import { z } from 'zod';
import * as YAML from 'yaml';
import { ConfigError, ParseError, toError } from '../errors';
import { FileProvider } from '../providers/file-provider';
import { MaintenanceConfig, MaintenanceConfigSchema } from '../schema/config';

/** Where the config lives when the CLI is given no `--config`. */
export const DEFAULT_CONFIG_PATH = 'maintenance.config.yaml';

export interface LoadedConfig {
    config: MaintenanceConfig;
    /** Repository-relative path the config was read from. */
    path: string;
    /** SHA-256 of the file contents, after line-ending normalisation. */
    sha256: string;
}

/**
 * Read, parse and validate the configuration.
 *
 * The digest is taken over the normalised text the provider returned, so the same
 * committed file yields the same digest on every platform — a CRLF checkout on the
 * Windows CI leg must not produce a different report.
 */
export async function loadConfig(
    files: FileProvider,
    path: string = DEFAULT_CONFIG_PATH,
): Promise<LoadedConfig> {
    const contents = await files.read({ path });
    const parsed = parseYaml(contents, path);
    const result = MaintenanceConfigSchema.safeParse(parsed);
    if (!result.success) {
        throw new ConfigError(
            `${path} is not a valid maintenance configuration:\n${formatIssues(result.error)}`,
            {
                target: path,
                cause: result.error,
            },
        );
    }
    return { config: result.data, path, sha256: digest(contents) };
}

/** Parse YAML, turning a syntax error into a classified one that names the file. */
function parseYaml(contents: string, path: string): unknown {
    try {
        // Duplicate keys throw rather than silently taking the last value, which is what
        // we want for an inventory: two `npm:` blocks is a mistake, not a merge.
        return YAML.parse(contents, { version: '1.2' });
    } catch (error: unknown) {
        throw new ParseError(`${path} is not valid YAML: ${toError(error).message}`, {
            target: path,
            cause: error,
        });
    }
}

/**
 * Render validation issues as one message per line, each naming its path.
 *
 * A configuration error is read by a human editing a YAML file, so the path matters
 * more than the stack.
 */
function formatIssues(error: z.ZodError): string {
    return error.issues
        .map((issue) => {
            const location = issue.path.length === 0 ? '(root)' : issue.path.join('.');
            return `  - ${location}: ${issue.message}`;
        })
        .join('\n');
}

function digest(contents: string): string {
    return createHash('sha256').update(contents, 'utf8').digest('hex');
}
