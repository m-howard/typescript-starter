/**
 * Rendering Zod validation issues for humans.
 *
 * Three places need this — the config loader, the npm output parsers and the finding
 * builder — and each had grown its own copy. They are read by someone editing a YAML
 * file or debugging a collector, so the field path matters more than the stack, and all
 * three should agree on how a path is written.
 */

import { z } from 'zod';

/** One `path: message` line per issue, in the order Zod reported them. */
export function formatZodIssues(error: z.ZodError): string[] {
    return error.issues.map((issue) => `${describePath(issue.path)}: ${issue.message}`);
}

/** The first issue, for a message that has room for only one. */
export function firstZodIssue(error: z.ZodError): string {
    return formatZodIssues(error)[0];
}

/** A dotted field path, or `(root)` when the issue is about the value as a whole. */
function describePath(path: ReadonlyArray<PropertyKey>): string {
    return path.length === 0 ? '(root)' : path.join('.');
}
