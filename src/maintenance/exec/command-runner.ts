/**
 * Running external commands.
 *
 * The central design point: **a non-zero exit is not a failure.** Both npm commands the
 * collectors rely on exit 1 in the normal case — `npm outdated` when anything is
 * outdated, `npm audit` when anything is vulnerable — so the runner returns a result
 * and the caller declares which codes it accepts (REQ-NPM-011, REQ-NPM-013).
 *
 * Error classification follows the shapes probed on Node 22:
 *
 * | Case               | `code`                               | `killed` |
 * | ------------------ | ------------------------------------ | -------- |
 * | Normal exit        | number                               | `false`  |
 * | Missing binary     | `'ENOENT'`                           | —        |
 * | maxBuffer exceeded | `'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'` | —        |
 * | Timeout            | `null`                               | `true`   |
 */

import { execFile } from 'child_process';
import { CommandFailedError, TimeoutError, toError } from '../errors';
import { Clock } from '../clock';

/** 32 MiB. `npm audit` produced 57 KB for 40 advisories here; a monorepo produces more. */
export const DEFAULT_MAX_BUFFER = 32 * 1024 * 1024;

/** Three minutes. `npm audit` contacts the registry. */
export const DEFAULT_TIMEOUT_MS = 180_000;

export interface CommandRequest {
    /** Executable, then arguments. Passed to `execFile`, so no shell is involved. */
    argv: readonly string[];
    cwd: string;
    timeoutMs?: number;
    maxBuffer?: number;
    env?: NodeJS.ProcessEnv;
}

export interface CommandResult {
    argv: readonly string[];
    cwd: string;
    /** The process exit code. Never null: a killed process throws instead. */
    exitCode: number;
    stdout: string;
    stderr: string;
    durationMs: number;
}

export interface CommandRunner {
    /**
     * Run a command to completion.
     *
     * Resolves for any normal exit, whatever the code. Rejects only when no trustworthy
     * output exists: the binary is missing, output overflowed the buffer, or the
     * process was killed.
     */
    run(request: CommandRequest): Promise<CommandResult>;
}

interface ExecFileFailure extends Error {
    code?: number | string;
    killed?: boolean;
    signal?: NodeJS.Signals | null;
    stdout?: string;
    stderr?: string;
}

export class ExecFileCommandRunner implements CommandRunner {
    constructor(private readonly clock: Clock) {}

    public run(request: CommandRequest): Promise<CommandResult> {
        const [command, ...args] = request.argv;
        if (command === undefined) {
            return Promise.reject(
                new CommandFailedError('Cannot run an empty command', request.argv, null),
            );
        }
        const startedAt = this.clock.monotonicMs();
        const options = {
            cwd: request.cwd,
            timeout: request.timeoutMs ?? DEFAULT_TIMEOUT_MS,
            maxBuffer: request.maxBuffer ?? DEFAULT_MAX_BUFFER,
            env: request.env ?? process.env,
            encoding: 'utf8' as const,
        };

        return new Promise<CommandResult>((resolve, reject) => {
            // execFile validates its arguments synchronously and throws a raw TypeError
            // for an invalid command, which would otherwise escape classification and
            // break this method's contract of rejecting only with maintenance errors.
            try {
                execFile(command, args, options, (error, stdout, stderr) => {
                    const durationMs = Math.round(this.clock.monotonicMs() - startedAt);
                    if (error === null) {
                        resolve({ ...base(request, stdout, stderr, durationMs), exitCode: 0 });
                        return;
                    }
                    const failure = error as ExecFileFailure;

                    // Checked first: a timeout reports `code: null`, which would otherwise
                    // read as "no exit code" rather than as a kill.
                    if (failure.killed === true) {
                        reject(
                            new TimeoutError(
                                `Command timed out after ${options.timeout}ms: ${request.argv.join(' ')}`,
                                { target: command },
                            ),
                        );
                        return;
                    }

                    // A numeric code is a real exit status, so the command ran and its
                    // output is trustworthy. A string code is a spawn or stdio error.
                    if (typeof failure.code === 'number') {
                        resolve({
                            ...base(
                                request,
                                failure.stdout ?? stdout,
                                failure.stderr ?? stderr,
                                durationMs,
                            ),
                            exitCode: failure.code,
                        });
                        return;
                    }

                    reject(describeSpawnFailure(failure, request, command));
                });
            } catch (error: unknown) {
                reject(
                    new CommandFailedError(
                        `Could not start ${command}: ${toError(error).message}`,
                        request.argv,
                        null,
                        { target: command, cause: error },
                    ),
                );
            }
        });
    }
}

function base(
    request: CommandRequest,
    stdout: string,
    stderr: string,
    durationMs: number,
): Omit<CommandResult, 'exitCode'> {
    return { argv: request.argv, cwd: request.cwd, stdout, stderr, durationMs };
}

/**
 * Classify a failure that produced no trustworthy output.
 *
 * A buffer overflow leaves `stdout` **populated but truncated**, which is the trap
 * here: "we got stdout, so it worked" would hand a parser a fragment of JSON. It is a
 * hard failure, never a result.
 */
function describeSpawnFailure(
    failure: ExecFileFailure,
    request: CommandRequest,
    command: string,
): Error {
    if (failure.code === 'ENOENT') {
        return new CommandFailedError(`Executable not found: ${command}`, request.argv, null, {
            target: command,
        });
    }
    if (failure.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
        return new CommandFailedError(
            `Command output exceeded the ${request.maxBuffer ?? DEFAULT_MAX_BUFFER} byte buffer, ` +
                `so its output is truncated and cannot be parsed: ${request.argv.join(' ')}`,
            request.argv,
            null,
            { target: command },
        );
    }
    return new CommandFailedError(
        `Command failed: ${request.argv.join(' ')} — ${toError(failure).message}`,
        request.argv,
        null,
        { target: command, cause: failure },
    );
}
