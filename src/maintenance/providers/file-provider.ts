/**
 * Reading declared input files.
 *
 * Where the infrastructure files ultimately live is undecided — they may end up in
 * other repositories — so every read goes through this seam. `LocalFsProvider` ships
 * now; `GitHubContentsProvider` is a stub with its shape locked.
 *
 * The interface is deliberately `read` and `exists` only, with **no globbing**: every
 * file a collector touches is named explicitly in `maintenance.config.yaml`. Listing
 * over the GitHub API would mean tree traversal, pagination and a rate-limit budget —
 * precisely the work being deferred
 * (`docs/maintenance/adr/0005-no-globbing-in-file-provider.md`, REQ-CFG-006).
 */

/** A file to read, resolved relative to the provider's root. */
export interface FileRef {
    /** Repository-relative path, e.g. `.github/workflows/ci.yml`. */
    path: string;
    /** `owner/name`. Only meaningful for a remote provider; ignored locally. */
    repo?: string;
    /** Branch, tag or commit. Only meaningful for a remote provider. */
    ref?: string;
}

export interface FileProvider {
    /** Human-readable identifier for the provider, recorded in errors. */
    readonly kind: 'local' | 'github';

    /**
     * Read a file as UTF-8 text with line endings normalised to LF.
     *
     * @throws NotFoundError when the file does not exist.
     */
    read(ref: FileRef): Promise<string>;

    /** Whether the file exists and is readable. Never throws for a missing file. */
    exists(ref: FileRef): Promise<boolean>;
}

/**
 * Normalise CRLF and lone CR to LF.
 *
 * `.gitattributes` marks YAML and JSON as text, so on the `windows-latest` CI leg
 * every fixture checks out with CRLF. Without this, line arithmetic and snippet
 * comparisons break on exactly one platform — the worst kind of flake. Doing it here,
 * at the single point where bytes enter the system, means no parser has to think
 * about it.
 */
export function normaliseLineEndings(contents: string): string {
    return contents.replace(/\r\n?/g, '\n');
}
