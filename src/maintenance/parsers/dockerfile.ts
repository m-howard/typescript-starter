/**
 * Base images and build arguments in a Dockerfile.
 *
 * A line scanner rather than a full BuildKit parser: the collectors need `FROM`, `ARG`
 * and `ENV`, and a dependency for that would be more surface than it saves. What it
 * does handle is the part that produces wrong answers if ignored — line continuations,
 * build-argument substitution, and stage aliases.
 */

import { LineIndex } from '../text/line-index';

/** A `FROM` reference, after substitution. */
export interface BaseImageReference {
    /** The reference as written, before substitution. */
    raw: string;
    /** Registry and repository, e.g. `mcr.microsoft.com/devcontainers/base`. */
    image: string;
    /** The tag, or null when the reference is pinned by digest or bare. */
    tag: string | null;
    /** The digest when pinned by one. A digest pin is deliberate, not drift. */
    digest: string | null;
    /** The `AS <name>` alias, when the stage has one. */
    stage: string | null;
    /** True when the reference could not be fully substituted. */
    unresolved: boolean;
    line: number;
    snippet: string;
}

/** A build argument or environment variable with a literal default. */
export interface DeclaredArg {
    name: string;
    value: string;
    line: number;
}

export interface ParsedDockerfile {
    baseImages: BaseImageReference[];
    args: DeclaredArg[];
    /** Stage aliases declared by `AS`, which are not registry references. */
    stages: string[];
}

const INSTRUCTION = /^\s*(FROM|ARG|ENV)\s+(.*)$/i;
const SUBSTITUTION = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}|\$([A-Za-z_][A-Za-z0-9_]*)/g;

/** Parse the instructions the collectors care about. */
export function parseDockerfile(text: string): ParsedDockerfile {
    const index = new LineIndex(text);
    const logical = joinContinuations(text);
    const args = new Map<string, string>();
    const stages = new Set<string>();
    const declaredArgs: DeclaredArg[] = [];
    const baseImages: BaseImageReference[] = [];

    for (const { content, line } of logical) {
        const match = INSTRUCTION.exec(content);
        if (match === null) {
            continue;
        }
        const instruction = match[1].toUpperCase();
        const rest = match[2].trim();

        if (instruction === 'ARG' || instruction === 'ENV') {
            for (const declared of parseAssignments(rest, line)) {
                args.set(declared.name, declared.value);
                declaredArgs.push(declared);
            }
            continue;
        }

        const reference = parseFrom(rest, args, stages, line, index);
        if (reference !== null) {
            baseImages.push(reference);
        }
    }

    return { baseImages, args: declaredArgs, stages: [...stages] };
}

/**
 * Collapse backslash continuations into logical lines.
 *
 * The line number reported is the one the instruction *starts* on, which is where a
 * reviewer looks.
 */
function joinContinuations(text: string): Array<{ content: string; line: number }> {
    const raw = text.split('\n');
    const logical: Array<{ content: string; line: number }> = [];
    let buffer: string | null = null;
    let start = 1;

    for (let i = 0; i < raw.length; i += 1) {
        const current = raw[i].replace(/\r$/, '');
        const continues = /\\\s*$/.test(current);
        const cleaned = current.replace(/\\\s*$/, '');
        if (buffer === null) {
            buffer = cleaned;
            start = i + 1;
        } else {
            buffer += ` ${cleaned.trim()}`;
        }
        if (!continues) {
            logical.push({ content: buffer, line: start });
            buffer = null;
        }
    }
    if (buffer !== null) {
        logical.push({ content: buffer, line: start });
    }
    return logical;
}

/** Parse `NAME=value` pairs, or the two-token `ARG NAME value` form. */
function parseAssignments(rest: string, line: number): DeclaredArg[] {
    const declared: DeclaredArg[] = [];
    const pairs = rest.match(/[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)/g);
    if (pairs !== null) {
        for (const pair of pairs) {
            const separator = pair.indexOf('=');
            declared.push({
                name: pair.slice(0, separator),
                value: unquote(pair.slice(separator + 1)),
                line,
            });
        }
        return declared;
    }
    const tokens = rest.split(/\s+/).filter((token) => token.length > 0);
    if (tokens.length >= 2) {
        declared.push({ name: tokens[0], value: unquote(tokens.slice(1).join(' ')), line });
    }
    return declared;
}

/** Parse a `FROM` instruction, resolving arguments and recognising stage aliases. */
function parseFrom(
    rest: string,
    args: ReadonlyMap<string, string>,
    stages: Set<string>,
    line: number,
    index: LineIndex,
): BaseImageReference | null {
    // Drop flags such as `--platform=linux/amd64`.
    const tokens = rest.split(/\s+/).filter((token) => token.length > 0 && !token.startsWith('--'));
    if (tokens.length === 0) {
        return null;
    }
    const raw = tokens[0];
    const asIndex = tokens.findIndex((token) => token.toUpperCase() === 'AS');
    const stage = asIndex !== -1 && tokens[asIndex + 1] !== undefined ? tokens[asIndex + 1] : null;
    if (stage !== null) {
        stages.add(stage);
    }

    // `FROM builder` names a preceding stage, not a registry reference (REQ-IMG-011).
    if (stages.has(raw) || args.has(raw)) {
        return null;
    }

    const { value: substituted, unresolved } = substitute(raw, args);
    // A reference that is still a bare name after substitution is a stage or a
    // scratch-like target, not something with an upstream to compare against.
    if (!unresolved && !substituted.includes('/') && !substituted.includes(':')) {
        return null;
    }

    const parts = splitImageReference(substituted);
    return {
        raw,
        image: parts.image,
        tag: parts.tag,
        digest: parts.digest,
        stage,
        unresolved,
        line,
        snippet: index.snippetAt(line),
    };
}

/**
 * Substitute `${NAME}`, `${NAME:-default}` and `$NAME`.
 *
 * An unresolvable reference is reported rather than left to look like a literal, so the
 * collector can emit the finding as unresolved with a reason (REQ-IMG-013).
 */
export function substitute(
    value: string,
    args: ReadonlyMap<string, string>,
): { value: string; unresolved: boolean } {
    let unresolved = false;
    const substituted = value.replace(SUBSTITUTION, (_match, braced, fallback, bare) => {
        const name = (braced ?? bare) as string;
        const declared = args.get(name);
        if (declared !== undefined) {
            return declared;
        }
        if (typeof fallback === 'string') {
            return fallback;
        }
        unresolved = true;
        return _match as string;
    });
    return { value: substituted, unresolved };
}

/** Split `registry/repo:tag` or `registry/repo@sha256:…` into its parts. */
export function splitImageReference(reference: string): {
    image: string;
    tag: string | null;
    digest: string | null;
} {
    const atIndex = reference.indexOf('@');
    if (atIndex !== -1) {
        return {
            image: reference.slice(0, atIndex),
            tag: null,
            digest: reference.slice(atIndex + 1),
        };
    }
    // A colon before the last slash is a registry port, not a tag separator.
    const colonIndex = reference.lastIndexOf(':');
    const slashIndex = reference.lastIndexOf('/');
    if (colonIndex === -1 || colonIndex < slashIndex) {
        return { image: reference, tag: null, digest: null };
    }
    return {
        image: reference.slice(0, colonIndex),
        tag: reference.slice(colonIndex + 1),
        digest: null,
    };
}

function unquote(value: string): string {
    const trimmed = value.trim();
    const quoted = /^(["'])(.*)\1$/.exec(trimmed);
    return quoted === null ? trimmed : quoted[2];
}
