/**
 * Versions of tools baked into an image.
 *
 * There is no general way to know that `--version 3.178.0` inside a `RUN` is a Pulumi
 * pin, so the pattern comes from configuration. Each declared pin is a regex with one
 * capture group; the collector supplies the upstream reference to compare against.
 */

import { LineIndex } from '../text/line-index';
import { ConfigError } from '../errors';

/** One occurrence of a configured tool pin. */
export interface ToolPinMatch {
    /** The configured pin id, e.g. `pulumi`. */
    id: string;
    /** The captured version, exactly as written. */
    version: string;
    line: number;
    snippet: string;
}

export interface ToolPinDefinition {
    id: string;
    /** Regex source with exactly one capture group holding the version. */
    pattern: string;
}

/**
 * Find every occurrence of each configured pin.
 *
 * A tool can be pinned more than once — a multi-stage build often installs the same
 * binary in two stages — and each occurrence is separately maintainable, so all are
 * returned rather than only the first.
 *
 * A pin that matches nothing yields no result and no error: the Dockerfile simply does
 * not install that tool (REQ-IMG-019). A malformed pattern, by contrast, is a
 * configuration error and is raised as one.
 */
export function findToolPins(
    text: string,
    definitions: readonly ToolPinDefinition[],
): ToolPinMatch[] {
    const index = new LineIndex(text);
    const matches: ToolPinMatch[] = [];

    for (const definition of definitions) {
        const pattern = compile(definition);
        // One pass: matching each line once removes the possibility of the line search
        // and the capture disagreeing, and with it a branch that could never be reached.
        for (let line = 1; line <= index.lineCount; line += 1) {
            pattern.lastIndex = 0;
            const captured = pattern.exec(index.lineAt(line))?.[1];
            if (captured !== undefined) {
                matches.push({
                    id: definition.id,
                    version: captured,
                    line,
                    snippet: index.snippetAt(line),
                });
            }
        }
    }
    return matches;
}

/** Compile a configured pattern, rejecting one that cannot yield a version. */
function compile(definition: ToolPinDefinition): RegExp {
    let pattern: RegExp;
    try {
        pattern = new RegExp(definition.pattern);
    } catch {
        throw new ConfigError(
            `Tool pin "${definition.id}" has an invalid pattern: ${definition.pattern}`,
            { target: definition.id },
        );
    }
    // Without a capture group there is nothing to read the version from, which is a
    // configuration mistake rather than an absent tool.
    if (!hasCaptureGroup(definition.pattern)) {
        throw new ConfigError(
            `Tool pin "${definition.id}" needs one capture group for the version: ${definition.pattern}`,
            { target: definition.id },
        );
    }
    return pattern;
}

/** A capturing group is `(` not preceded by a backslash and not followed by `?:`. */
function hasCaptureGroup(source: string): boolean {
    return /(^|[^\\])\((?!\?[:=!<])/.test(source);
}
