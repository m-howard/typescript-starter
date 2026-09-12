/**
 * Action references in a workflow file.
 *
 * Uses `parseDocument` and each value node's character range rather than a regex, so a
 * finding points at the line that actually declares the reference (REQ-GHA-011).
 * Offsets become line numbers through `LineIndex`, which already exists and is already
 * CRLF-safe — yaml's own `LineCounter` was verified to give identical results, so there
 * is no reason to carry two mechanisms.
 */

import * as YAML from 'yaml';
import { ParseError } from '../errors';
import { LineIndex } from '../text/line-index';

/** How an action reference is pinned. */
export type ActionPinKind = 'sha' | 'tag' | 'branch' | 'none';

export interface ActionReference {
    /** The whole `uses:` value, e.g. `actions/checkout@v4`. */
    raw: string;
    /** `owner/repo`, with any subdirectory removed. */
    repository: string;
    /** A subdirectory within the repository, when the reference names one. */
    subdirectory: string | null;
    /** Everything after the `@`, or null when the reference is unpinned. */
    ref: string | null;
    pin: ActionPinKind;
    /** A version parsed from a trailing comment on a SHA pin, e.g. `# v4.2.2`. */
    commentVersion: string | null;
    line: number;
    column: number;
    snippet: string;
}

/** References the collector deliberately ignores, recorded so nothing is silently lost. */
export interface SkippedReference {
    raw: string;
    reason: 'local-path' | 'docker-image';
    line: number;
}

export interface ParsedWorkflow {
    actions: ActionReference[];
    skipped: SkippedReference[];
}

const FORTY_HEX = /^[0-9a-f]{40}$/i;
const VERSION_COMMENT = /#\s*(v?\d[\w.\-+]*)/;

/**
 * Extract every action reference from a workflow.
 *
 * Covers both `jobs.*.steps[].uses` and the `jobs.*.uses` form for a reusable workflow;
 * rather than walking those paths explicitly, every `uses:` pair is collected, which
 * also picks up composite actions and any future placement.
 */
export function parseWorkflow(text: string, path: string): ParsedWorkflow {
    // parseDocument collects errors rather than throwing - verified against malformed
    // input, tab indentation, bad tags and an unknown directive - so `errors` is the
    // only real failure path and a try/catch here would be dead code.
    const document = YAML.parseDocument(text, { version: '1.2' });
    if (document.errors.length > 0) {
        throw new ParseError(`${path} is not valid YAML: ${document.errors[0].message}`, {
            target: path,
        });
    }

    const index = new LineIndex(text);
    const actions: ActionReference[] = [];
    const skipped: SkippedReference[] = [];

    YAML.visit(document, {
        Pair(_key, pair) {
            const keyNode = pair.key;
            const valueNode = pair.value;
            if (!isScalarNamed(keyNode, 'uses') || !isStringScalar(valueNode)) {
                return;
            }
            const raw = valueNode.value.trim();
            const offset = valueNode.range?.[0];
            const { line, column } =
                offset === undefined ? { line: 1, column: 1 } : index.offsetToLineCol(offset);

            if (raw.startsWith('./') || raw.startsWith('../')) {
                // A local action lives in this repository; there is no upstream to
                // compare it against (REQ-GHA-014).
                skipped.push({ raw, reason: 'local-path', line });
                return;
            }
            if (raw.startsWith('docker://')) {
                // A container reference is the images collector's subject, not this one.
                skipped.push({ raw, reason: 'docker-image', line });
                return;
            }

            const parsed = parseActionReference(raw);
            if (parsed === null) {
                return;
            }
            actions.push({
                ...parsed,
                line,
                column,
                snippet: index.snippetAt(line),
            });
        },
    });

    return { actions, skipped };
}

/** Split `owner/repo/path@ref` into its parts. */
export function parseActionReference(
    raw: string,
): Omit<ActionReference, 'line' | 'column' | 'snippet'> | null {
    const [target, ...refParts] = raw.split('@');
    const ref = refParts.length === 0 ? null : refParts.join('@');
    const segments = target.split('/');
    if (segments.length < 2 || segments[0].length === 0 || segments[1].length === 0) {
        return null;
    }
    return {
        raw,
        repository: `${segments[0]}/${segments[1]}`,
        subdirectory: segments.length > 2 ? segments.slice(2).join('/') : null,
        ref,
        pin: classifyPin(ref),
        commentVersion: null,
    };
}

/**
 * Whether the owner is GitHub itself.
 *
 * An unpinned `actions/checkout@v4` is a different risk from an unpinned third-party
 * action: GitHub controls the former's tag (REQ-SEV-056).
 */
export function isFirstPartyAction(repository: string): boolean {
    const owner = repository.split('/')[0].toLowerCase();
    return owner === 'actions' || owner === 'github';
}

/**
 * Read a version from a trailing comment on a SHA pin.
 *
 * The convention `uses: actions/checkout@<sha> # v4.2.2` is how a SHA-pinned workflow
 * stays readable, and it is the only way to know which version a SHA denotes without
 * spending an API call.
 */
export function readVersionComment(lineText: string): string | null {
    return VERSION_COMMENT.exec(lineText)?.[1] ?? null;
}

function classifyPin(ref: string | null): ActionPinKind {
    if (ref === null || ref.length === 0) {
        return 'none';
    }
    if (FORTY_HEX.test(ref)) {
        return 'sha';
    }
    // Anything else is a mutable ref. Distinguishing a tag from a branch would need an
    // API call, and both are mutable, so both are treated the same for pinning policy.
    return /^v?\d/.test(ref) ? 'tag' : 'branch';
}

function isScalarNamed(node: unknown, name: string): boolean {
    return YAML.isScalar(node) && node.value === name;
}

function isStringScalar(node: unknown): node is YAML.Scalar<string> {
    return YAML.isScalar(node) && typeof node.value === 'string';
}
