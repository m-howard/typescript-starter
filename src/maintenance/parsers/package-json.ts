/**
 * The declared dependency set.
 *
 * `package.json` is authoritative here, not `npm outdated`: the latter reports only
 * what is outdated and its contents depend on the installed tree
 * (`docs/maintenance/adr/0001-package-json-authoritative.md`, REQ-NPM-010).
 *
 * Line numbers are found by locating the dependency **block** and searching only
 * within it, never by searching the whole document for the key. Measured against this
 * repository's own manifest, a bare substring search for `eslint` matches eight lines,
 * and even a quoted `"jest":` matches two — the devDependency and the top-level jest
 * config block. Evidence carrying a wrong line number is worse than evidence carrying
 * none, because it looks authoritative and sends a reviewer to the wrong place.
 */

import { ParseError, toError } from '../errors';
import { SubjectScope } from '../severity/facts';

/** One dependency as the manifest declares it. */
export interface DeclaredDependency {
    name: string;
    /** The range exactly as written, e.g. `^5.7.3`. */
    range: string;
    /** Which block it was found in. */
    scope: Extract<SubjectScope, 'runtime' | 'dev'>;
    /** One-based line of the declaration, or null when it could not be located. */
    line: number | null;
}

export interface ParsedManifest {
    name: string | null;
    version: string | null;
    dependencies: DeclaredDependency[];
}

/** The blocks read, and the scope each implies. */
const DEPENDENCY_BLOCKS: ReadonlyArray<{
    key: string;
    scope: Extract<SubjectScope, 'runtime' | 'dev'>;
}> = [
    { key: 'dependencies', scope: 'runtime' },
    { key: 'devDependencies', scope: 'dev' },
];

interface ManifestLike {
    name?: unknown;
    version?: unknown;
    dependencies?: unknown;
    devDependencies?: unknown;
}

/** Parse a manifest into its declared dependencies, with a line number for each. */
export function parsePackageJson(text: string, path = 'package.json'): ParsedManifest {
    let document: ManifestLike;
    try {
        document = JSON.parse(text) as ManifestLike;
    } catch (error: unknown) {
        throw new ParseError(`${path} is not valid JSON: ${toError(error).message}`, {
            target: path,
        });
    }

    const lines = text.split('\n');
    const dependencies: DeclaredDependency[] = [];

    for (const { key, scope } of DEPENDENCY_BLOCKS) {
        const declared = readBlock(document, key);
        if (declared === null) {
            continue;
        }
        const span = findBlockSpan(lines, key);
        for (const [name, range] of Object.entries(declared)) {
            dependencies.push({ name, range, scope, line: findKeyLine(lines, name, span) });
        }
    }

    return {
        name: typeof document.name === 'string' ? document.name : null,
        version: typeof document.version === 'string' ? document.version : null,
        dependencies,
    };
}

/** Read a dependency block, ignoring anything that is not a name-to-range mapping. */
function readBlock(document: ManifestLike, key: string): Record<string, string> | null {
    const value = (document as Record<string, unknown>)[key];
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return null;
    }
    const entries = Object.entries(value as Record<string, unknown>).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string',
    );
    return Object.fromEntries(entries);
}

/** One-based, inclusive line range of a top-level block, or null when not found. */
function findBlockSpan(lines: readonly string[], key: string): LineSpan | null {
    const opening = lines.findIndex((line) => line.trimStart().startsWith(`"${key}":`));
    if (opening === -1) {
        return null;
    }
    // Brace counting is safe inside a dependency block: neither a package name nor a
    // version range can contain a brace.
    let depth = 0;
    for (let i = opening; i < lines.length; i += 1) {
        depth += count(lines[i], '{') - count(lines[i], '}');
        if (depth <= 0 && i > opening) {
            return { start: opening + 1, end: i + 1 };
        }
        if (depth <= 0 && i === opening && lines[i].includes('}')) {
            return { start: opening + 1, end: opening + 1 };
        }
    }
    return { start: opening + 1, end: lines.length };
}

interface LineSpan {
    start: number;
    end: number;
}

/**
 * One-based line of a key, searched only within its block.
 *
 * The quoted form `"name":` is matched anywhere in the line rather than only at its
 * start, so a block written on one line works as well as a formatted one. Confining the
 * search to the block is what makes that safe: within a dependency block the quoted
 * form cannot collide (`"a":` does not occur inside `"data":`), and the cross-block
 * collision that motivated the span in the first place — `"jest":` appearing both as a
 * devDependency and as a config section — is already excluded.
 */
function findKeyLine(lines: readonly string[], name: string, span: LineSpan | null): number | null {
    if (span === null) {
        return null;
    }
    const needle = `"${name}":`;
    for (let i = span.start - 1; i < span.end && i < lines.length; i += 1) {
        if (lines[i].includes(needle)) {
            return i + 1;
        }
    }
    return null;
}

function count(value: string, character: string): number {
    let total = 0;
    for (const char of value) {
        if (char === character) {
            total += 1;
        }
    }
    return total;
}
