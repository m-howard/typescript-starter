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
import {
    ProvenanceMethod,
    ResolveRequest,
    ResolvedVersion,
    VersionSourceRegistry,
} from '../../src/maintenance/sources';
import { Confidence } from '../../src/maintenance/schema';
import { MaintenanceConfigSchema } from '../../src/maintenance/schema/config';
import { CollectorContext } from '../../src/maintenance/types';
import { FixedClock } from '../../src/maintenance/clock';
import { Logger, LogLevel } from '../../src/utils/logger';

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

/** Everything a caller may pass to `VersionSourceRegistry.resolve` besides the ref. */
type ResolveOptions = Omit<ResolveRequest, 'ref'>;

/** Severities in increasing order, matching winston's own ordering. */
const LEVEL_ORDER: LogLevel[] = [LogLevel.DEBUG, LogLevel.INFO, LogLevel.WARN, LogLevel.ERROR];

/**
 * A logger that records instead of writing, so a spec can assert what was reported.
 *
 * It honours {@link setLogLevel} rather than recording everything. That fidelity is
 * load-bearing for one guarantee in particular: the CLI drops to error-only when it
 * writes a report to standard output, and a fake that recorded anyway would let a
 * regression through while the assertion still passed (REQ-CLI-005).
 */
export class RecordingLogger extends Logger {
    public readonly lines: Array<{ level: LogLevel; message: string }> = [];

    private threshold: LogLevel = LogLevel.DEBUG;

    public setLogLevel(level: LogLevel): void {
        this.threshold = level;
    }

    public debug(message: string): void {
        this.record(LogLevel.DEBUG, message);
    }

    public info(message: string): void {
        this.record(LogLevel.INFO, message);
    }

    public warn(message: string): void {
        this.record(LogLevel.WARN, message);
    }

    public error(message: string): void {
        this.record(LogLevel.ERROR, message);
    }

    /** Every message logged at a level, for a single readable assertion. */
    public at(level: LogLevel | string): string[] {
        return this.lines.filter((line) => line.level === level).map((line) => line.message);
    }

    private record(level: LogLevel, message: string): void {
        if (LEVEL_ORDER.indexOf(level) >= LEVEL_ORDER.indexOf(this.threshold)) {
            this.lines.push({ level, message });
        }
    }
}

/**
 * A version source registry whose answers are declared per reference.
 *
 * Like the other fakes it throws on an unregistered reference: a collector that asks for
 * a source the spec did not set up is doing something the spec has not described.
 */
export class FakeSourceRegistry extends VersionSourceRegistry {
    /** References resolved during the test, in order. */
    public readonly asked: string[] = [];

    /** The full request behind each entry of {@link asked}, for asserting on options. */
    public readonly requests: Array<{ ref: string; options: ResolveOptions }> = [];

    private readonly answers = new Map<string, ResolvedVersion | Error>();

    constructor(answers: Record<string, ResolvedVersion | Error> = {}) {
        super();
        for (const [ref, answer] of Object.entries(answers)) {
            this.answers.set(ref, answer);
        }
    }

    public on(ref: string, answer: ResolvedVersion | Error): this {
        this.answers.set(ref, answer);
        return this;
    }

    public resolve(rawRef: string, options: ResolveOptions = {}): Promise<ResolvedVersion> {
        this.asked.push(rawRef);
        this.requests.push({ ref: rawRef, options });
        const answer = this.answers.get(rawRef);
        if (answer === undefined) {
            return Promise.reject(
                new Error(
                    `FakeSourceRegistry has no answer registered for ${rawRef}. ` +
                        'Register one, or the test is reaching for a real upstream.',
                ),
            );
        }
        return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
    }
}

/** A resolved answer, for readability at the call site. */
export function fakeResolved(
    version: string,
    method: ProvenanceMethod = 'github-release',
    confidence: Confidence = 'high',
    deprecated: boolean | null = null,
): ResolvedVersion {
    return {
        status: 'resolved',
        version,
        raw: version,
        method,
        confidence,
        reason: null,
        deprecated,
        evidence: [],
    };
}

/** An unresolved answer, for readability at the call site. */
export function fakeUnresolved(
    reason: string,
    method: ProvenanceMethod = 'not-attempted',
): ResolvedVersion {
    return {
        status: 'unresolved',
        version: null,
        raw: null,
        method,
        confidence: 'low',
        reason,
        deprecated: null,
        evidence: [],
    };
}

export interface FakeContextOverrides extends Partial<Omit<CollectorContext, 'config'>> {
    config?: unknown;
}

/**
 * Assemble a `CollectorContext` from fakes, filling in whatever a spec does not care
 * about.
 *
 * The config is parsed rather than cast, so a spec cannot accidentally hand a collector
 * a shape the loader would have rejected.
 */
export function fakeContext(overrides: FakeContextOverrides = {}): CollectorContext {
    const { config, ...rest } = overrides;
    return {
        config: MaintenanceConfigSchema.parse(config ?? { version: 1 }),
        files: new InMemoryFileProvider(),
        commands: new FakeCommandRunner(),
        sources: new FakeSourceRegistry(),
        logger: new RecordingLogger(),
        clock: new FixedClock(),
        offline: false,
        repoRoot: '/repo',
        configPath: 'maintenance.config.yaml',
        ...rest,
    };
}
