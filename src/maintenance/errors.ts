/**
 * Error hierarchy for the maintenance collect stage.
 *
 * Every error carries a machine-readable {@link MaintenanceErrorCode}, an optional
 * target naming what could not be reached, and a retryable flag, so a collector can
 * report degraded state as structured data rather than as prose (REQ-ERR-036).
 */

/** Machine-readable classification for every failure the collect stage can record. */
export const MAINTENANCE_ERROR_CODES = [
    'offline',
    'network',
    'rate-limited',
    'timeout',
    'not-found',
    'parse-error',
    'command-failed',
    'config-error',
    'unsupported',
    'internal',
] as const;

export type MaintenanceErrorCode = (typeof MAINTENANCE_ERROR_CODES)[number];

/**
 * Whether a failure of each kind is worth retrying.
 *
 * Only transport-level failures are retryable. A parse error or a bad configuration
 * will fail identically on a second attempt, and retrying it wastes a rate-limit
 * budget that resolvable requests need (REQ-ERR-032, REQ-NET-027).
 */
const RETRYABLE_BY_CODE: Readonly<Record<MaintenanceErrorCode, boolean>> = Object.freeze({
    offline: false,
    network: true,
    'rate-limited': true,
    timeout: true,
    'not-found': false,
    'parse-error': false,
    'command-failed': false,
    'config-error': false,
    unsupported: false,
    internal: false,
});

export interface MaintenanceErrorOptions {
    /** What could not be reached: a source ref, a file path, an argv[0]. */
    target?: string | null;
    /** Overrides the default retryability for the code. */
    retryable?: boolean;
    /** The underlying failure, when this error wraps one. */
    cause?: unknown;
}

/**
 * Base class for every error raised inside the maintenance subsystem.
 *
 * Declares its own `cause` rather than using the ES2022 `Error` option, because this
 * project compiles against the ES2017 library.
 */
export class MaintenanceError extends Error {
    public readonly code: MaintenanceErrorCode;
    public readonly target: string | null;
    public readonly retryable: boolean;
    public readonly cause: unknown;

    constructor(
        code: MaintenanceErrorCode,
        message: string,
        options: MaintenanceErrorOptions = {},
    ) {
        super(message);
        this.name = new.target.name;
        this.code = code;
        this.target = options.target ?? null;
        this.retryable = options.retryable ?? RETRYABLE_BY_CODE[code];
        this.cause = options.cause;
    }
}

/** Offline mode is active and a network call was attempted (REQ-NET-020). */
export class OfflineError extends MaintenanceError {
    constructor(target: string, options: MaintenanceErrorOptions = {}) {
        super('offline', `Offline mode is active; refusing to request ${target}`, {
            ...options,
            target,
        });
    }
}

/** A request failed at the transport level. */
export class NetworkError extends MaintenanceError {
    constructor(message: string, options: MaintenanceErrorOptions = {}) {
        super('network', message, options);
    }
}

/** An upstream service reported that the rate limit is exhausted (REQ-ERR-032). */
export class RateLimitedError extends MaintenanceError {
    /** Milliseconds until the limit resets, when the response said so. */
    public readonly retryAfterMs: number | null;

    constructor(
        message: string,
        options: MaintenanceErrorOptions & { retryAfterMs?: number | null } = {},
    ) {
        super('rate-limited', message, options);
        this.retryAfterMs = options.retryAfterMs ?? null;
    }
}

/** A request or command exceeded its time budget (REQ-NET-026). */
export class TimeoutError extends MaintenanceError {
    constructor(message: string, options: MaintenanceErrorOptions = {}) {
        super('timeout', message, options);
    }
}

/** A file, package, tag or release does not exist upstream. */
export class NotFoundError extends MaintenanceError {
    constructor(message: string, options: MaintenanceErrorOptions = {}) {
        super('not-found', message, options);
    }
}

/** Input could not be parsed: malformed YAML, JSON, or an unparseable tool output. */
export class ParseError extends MaintenanceError {
    constructor(message: string, options: MaintenanceErrorOptions = {}) {
        super('parse-error', message, options);
    }
}

/** A subprocess exited in a way the caller does not accept (REQ-NPM-013). */
export class CommandFailedError extends MaintenanceError {
    public readonly argv: readonly string[];
    public readonly exitCode: number | null;

    constructor(
        message: string,
        argv: readonly string[],
        exitCode: number | null,
        options: MaintenanceErrorOptions = {},
    ) {
        super('command-failed', message, { target: argv[0] ?? null, ...options });
        this.argv = argv;
        this.exitCode = exitCode;
    }
}

/** The configuration is invalid, or names something that does not resolve. */
export class ConfigError extends MaintenanceError {
    constructor(message: string, options: MaintenanceErrorOptions = {}) {
        super('config-error', message, options);
    }
}

/** The requested capability is not supported. */
export class UnsupportedError extends MaintenanceError {
    constructor(message: string, options: MaintenanceErrorOptions = {}) {
        super('unsupported', message, options);
    }
}

/**
 * A deliberately deferred capability was invoked.
 *
 * Used by the stub file provider so the seam is present and typed while its
 * implementation waits for pass 2.
 */
export class NotImplementedError extends UnsupportedError {}

/** An invariant inside the collect stage was violated. */
export class InternalError extends MaintenanceError {
    constructor(message: string, options: MaintenanceErrorOptions = {}) {
        super('internal', message, options);
    }
}

/**
 * Narrow an unknown caught value to an `Error`.
 *
 * `strict` implies `useUnknownInCatchVariables`, so every `catch` binding arrives as
 * `unknown`. This keeps that narrowing in one place instead of at each call site.
 *
 * The original value is not attached as a `cause`: that option is ES2022 and this
 * project compiles against the ES2017 library. Use {@link toMaintenanceError} when the
 * cause needs to survive.
 */
export function toError(value: unknown): Error {
    if (value instanceof Error) {
        return value;
    }
    if (typeof value === 'string') {
        return new Error(value);
    }
    if (isErrorLike(value)) {
        const error = new Error(value.message);
        error.name = typeof value.name === 'string' ? value.name : 'Error';
        return error;
    }
    return new Error(safeStringify(value));
}

/**
 * Something that carries an error message without passing `instanceof Error`.
 *
 * `instanceof` compares against the current realm's `Error`, so an error thrown by a
 * Node internal, a worker or a `vm` context fails the check even though it is one. The
 * consequence is not cosmetic: `util.parseArgs` rejects an unknown flag with the
 * message `Unknown option '--offlien'` and an own-property set of just `{ code }`, so
 * falling through to JSON rendering replaces the one useful sentence with
 * `{"code":"ERR_PARSE_ARGS_UNKNOWN_OPTION"}` — and REQ-CLI-004 requires naming the flag.
 */
function isErrorLike(value: unknown): value is { message: string; name?: unknown } {
    return (
        typeof value === 'object' &&
        value !== null &&
        typeof (value as { message?: unknown }).message === 'string'
    );
}

/**
 * Narrow an unknown caught value to a {@link MaintenanceError}.
 *
 * Anything that is not already one is wrapped as an {@link InternalError}, preserving
 * the original as the cause, so a thrown value can never escape classification.
 */
export function toMaintenanceError(value: unknown, target: string | null = null): MaintenanceError {
    if (value instanceof MaintenanceError) {
        return value;
    }
    const error = toError(value);
    return new InternalError(error.message, { target, cause: error });
}

/** Best-effort rendering of a non-Error thrown value, never throwing itself. */
function safeStringify(value: unknown): string {
    if (value === null || value === undefined) {
        return String(value);
    }
    try {
        const rendered = JSON.stringify(value);
        return rendered === undefined ? String(value) : rendered;
    } catch {
        return String(value);
    }
}
