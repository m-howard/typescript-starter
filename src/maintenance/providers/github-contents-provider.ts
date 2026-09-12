/**
 * Reads declared files from another repository over the GitHub Contents API.
 *
 * **Deferred to pass 2.** The stub exists so the seam is present and typed, and so the
 * `repo`/`ref` fields already carried on file evidence have a consumer to be shaped
 * against. Because `FileProvider` forbids globbing, implementing this is a
 * single-file fetch rather than tree traversal with a rate-limit budget
 * (`docs/maintenance/adr/0005-no-globbing-in-file-provider.md`).
 */

import { NotImplementedError } from '../errors';
import { FileProvider, FileRef } from './file-provider';

export class GitHubContentsProvider implements FileProvider {
    public readonly kind = 'github' as const;

    public read(ref: FileRef): Promise<string> {
        // The parameter is consumed deliberately: the lint config sets no
        // argsIgnorePattern, so an underscore prefix would not satisfy no-unused-vars.
        return Promise.reject(
            new NotImplementedError(
                `GitHubContentsProvider cannot read ${describe(ref)} yet; it is deferred to pass 2`,
                { target: ref.path },
            ),
        );
    }

    public exists(ref: FileRef): Promise<boolean> {
        return Promise.reject(
            new NotImplementedError(
                `GitHubContentsProvider cannot check ${describe(ref)} yet; it is deferred to pass 2`,
                { target: ref.path },
            ),
        );
    }
}

/** Render a reference for an error message, including repo and ref when present. */
function describe(ref: FileRef): string {
    const repo = ref.repo === undefined ? '' : `${ref.repo}/`;
    const at = ref.ref === undefined ? '' : `@${ref.ref}`;
    return `${repo}${ref.path}${at}`;
}
