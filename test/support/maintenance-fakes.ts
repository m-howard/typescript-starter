/**
 * Test doubles for the maintenance seams.
 *
 * Every fake **throws on an unregistered interaction** rather than returning a benign
 * default. A spec that accidentally reaches for the network, the shell or a file it
 * did not set up fails loudly instead of silently depending on the environment — which
 * is the difference between a hermetic suite and one that passes on a laptop and fails
 * on the Windows CI leg.
 */

import { NotFoundError } from '../../src/maintenance/errors';
import {
    FileProvider,
    FileRef,
    normaliseLineEndings,
} from '../../src/maintenance/providers/file-provider';
import {
    CommandRequest,
    CommandResult,
    CommandRunner,
} from '../../src/maintenance/exec/command-runner';
import { HttpClient, HttpRequest, HttpResponse } from '../../src/maintenance/http/http-client';

/** A file provider backed by an in-memory map. */
export class InMemoryFileProvider implements FileProvider {
    public readonly kind = 'local' as const;

    /** Paths read during the test, in order, so a spec can assert what was touched. */
    public readonly reads: string[] = [];

    private readonly files: Map<string, string>;

    constructor(files: Record<string, string> = {}) {
        this.files = new Map(Object.entries(files));
    }

    public set(path: string, contents: string): this {
        this.files.set(path, contents);
        return this;
    }

    public read(ref: FileRef): Promise<string> {
        this.reads.push(ref.path);
        const contents = this.files.get(ref.path);
        if (contents === undefined) {
            return Promise.reject(
                new NotFoundError(`File not found: ${ref.path}`, { target: ref.path }),
            );
        }
        // Mirrors LocalFsProvider, so a fixture written with CRLF behaves the same way.
        return Promise.resolve(normaliseLineEndings(contents));
    }

    public exists(ref: FileRef): Promise<boolean> {
        return Promise.resolve(this.files.has(ref.path));
    }
}

/** What a fake HTTP client should do for a given URL. */
export type FakeHttpEntry = Partial<HttpResponse> | Error;

/** An HTTP client backed by a registered map of URLs. */
export class FakeHttpClient implements HttpClient {
    /** Requests made during the test, in order. */
    public readonly requests: HttpRequest[] = [];

    private readonly responses = new Map<string, FakeHttpEntry>();

    constructor(responses: Record<string, FakeHttpEntry> = {}) {
        for (const [url, entry] of Object.entries(responses)) {
            this.responses.set(url, entry);
        }
    }

    public on(url: string, entry: FakeHttpEntry): this {
        this.responses.set(url, entry);
        return this;
    }

    public request(request: HttpRequest): Promise<HttpResponse> {
        this.requests.push(request);
        const entry = this.responses.get(request.url);
        if (entry === undefined) {
            // Deliberately fatal: an unregistered URL means the spec would otherwise
            // have hit the real network.
            return Promise.reject(
                new Error(
                    `FakeHttpClient has no response registered for ${request.url}. ` +
                        'Register one, or the test is reaching for the real network.',
                ),
            );
        }
        if (entry instanceof Error) {
            return Promise.reject(entry);
        }
        return Promise.resolve({
            url: request.url,
            status: 200,
            ok: true,
            body: '',
            headers: {},
            retrievedAt: '2026-09-12T06:00:00.000Z',
            fromCache: false,
            ...entry,
        });
    }
}

/** What a fake command runner should do for a given argv. */
export type FakeCommandEntry = Partial<CommandResult> | Error;

/** A command runner backed by a registered map keyed on the joined argv. */
export class FakeCommandRunner implements CommandRunner {
    /** Commands run during the test, in order. */
    public readonly calls: CommandRequest[] = [];

    private readonly results = new Map<string, FakeCommandEntry>();

    constructor(results: Record<string, FakeCommandEntry> = {}) {
        for (const [argv, entry] of Object.entries(results)) {
            this.results.set(argv, entry);
        }
    }

    public on(argv: string, entry: FakeCommandEntry): this {
        this.results.set(argv, entry);
        return this;
    }

    public run(request: CommandRequest): Promise<CommandResult> {
        this.calls.push(request);
        const key = request.argv.join(' ');
        const entry = this.results.get(key);
        if (entry === undefined) {
            return Promise.reject(
                new Error(
                    `FakeCommandRunner has no result registered for "${key}". ` +
                        'Register one, or the test is running a real command.',
                ),
            );
        }
        if (entry instanceof Error) {
            return Promise.reject(entry);
        }
        return Promise.resolve({
            argv: request.argv,
            cwd: request.cwd,
            exitCode: 0,
            stdout: '',
            stderr: '',
            durationMs: 10,
            ...entry,
        });
    }
}
