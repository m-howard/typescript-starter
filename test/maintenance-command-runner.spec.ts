import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DEFAULT_MAX_BUFFER, ExecFileCommandRunner } from '../src/maintenance/exec/command-runner';
import { OfflineCommandRunner } from '../src/maintenance/exec/offline-command-runner';
import { CommandFailedError, OfflineError, TimeoutError } from '../src/maintenance/errors';
import { SystemClock } from '../src/maintenance/clock';
import { FakeCommandRunner } from './support/maintenance-fakes';

const runner = new ExecFileCommandRunner(new SystemClock());
const cwd = process.cwd();

/** Run a snippet of Node, so the spec needs no fixture binaries. */
function node(script: string): string[] {
    return [process.execPath, '-e', script];
}

describe('ExecFileCommandRunner', () => {
    describe('non-zero exits are results, not failures', () => {
        it('should resolve exit 1 with its stdout intact [REQ-NPM-011]', async () => {
            // The load-bearing case: npm outdated and npm audit both exit 1 in the
            // normal case, and their JSON is on stdout.
            const result = await runner.run({
                argv: node('process.stdout.write(JSON.stringify({a:1}));process.exit(1)'),
                cwd,
            });

            expect(result.exitCode).toBe(1);
            expect(JSON.parse(result.stdout)).toEqual({ a: 1 });
        });

        it('should resolve exit 2 as well, leaving the policy to the caller', async () => {
            const result = await runner.run({
                argv: node('process.stdout.write("partial");process.exit(2)'),
                cwd,
            });

            expect(result.exitCode).toBe(2);
            expect(result.stdout).toBe('partial');
        });

        it('should resolve a clean exit', async () => {
            const result = await runner.run({ argv: node('process.stdout.write("ok")'), cwd });

            expect(result.exitCode).toBe(0);
            expect(result.stdout).toBe('ok');
        });

        it('should capture stderr alongside stdout', async () => {
            const result = await runner.run({
                argv: node('process.stderr.write("warned");process.exit(1)'),
                cwd,
            });

            expect(result.stderr).toBe('warned');
        });

        it('should echo the argv and cwd for use as evidence [REQ-EVI-003]', async () => {
            const argv = node('process.stdout.write("x")');
            const result = await runner.run({ argv, cwd });

            expect(result.argv).toEqual(argv);
            expect(result.cwd).toBe(cwd);
            expect(result.durationMs).toBeGreaterThanOrEqual(0);
        });
    });

    describe('failures that produce no trustworthy output', () => {
        it('should reject a missing executable [REQ-NPM-019]', async () => {
            const promise = runner.run({ argv: ['definitely-not-a-real-binary'], cwd });

            await expect(promise).rejects.toBeInstanceOf(CommandFailedError);
            await expect(promise).rejects.toThrow(/not found/i);
        });

        it('should reject a truncated buffer rather than returning partial output', async () => {
            // stdout IS populated on overflow, but truncated. Returning it would hand a
            // parser a fragment of JSON, so this must be a hard failure.
            const promise = runner.run({
                argv: node('process.stdout.write("x".repeat(5000))'),
                cwd,
                maxBuffer: 100,
            });

            await expect(promise).rejects.toBeInstanceOf(CommandFailedError);
            await expect(promise).rejects.toThrow(/truncated/i);
        });

        it('should reject a timeout as retryable, not as an exit code', async () => {
            // A timeout reports code: null and killed: true, so `killed` must be
            // checked before the exit code or it reads as "no exit code".
            const promise = runner.run({
                argv: node('setTimeout(()=>{},5000)'),
                cwd,
                timeoutMs: 150,
            });

            await expect(promise).rejects.toBeInstanceOf(TimeoutError);
            await expect(promise).rejects.toMatchObject({ code: 'timeout', retryable: true });
        });

        it('should reject an empty argv', async () => {
            await expect(runner.run({ argv: [], cwd })).rejects.toBeInstanceOf(CommandFailedError);
        });

        it('should classify a synchronous argument rejection, not leak a raw TypeError', async () => {
            // execFile validates arguments synchronously and throws; without a guard
            // that escapes classification and breaks the runner's contract.
            const promise = runner.run({ argv: [`a${String.fromCharCode(0)}b`], cwd });

            await expect(promise).rejects.toBeInstanceOf(CommandFailedError);
            await expect(promise).rejects.toThrow(/could not start/i);
        });

        const describeOnPosix = process.platform === 'win32' ? describe.skip : describe;
        describeOnPosix('POSIX-only spawn failures', () => {
            // Windows has no execute bit, so EACCES on spawn is not reachable there.
            it('should classify a permission failure that is neither ENOENT nor a buffer overflow', async () => {
                const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'maintenance-noexec-'));
                const script = path.join(dir, 'noexec.sh');
                await fs.writeFile(script, '#!/bin/sh\necho hi\n', 'utf8');
                await fs.chmod(script, 0o644);

                const promise = runner.run({ argv: [script], cwd });

                await expect(promise).rejects.toBeInstanceOf(CommandFailedError);
                await expect(promise).rejects.toThrow(/command failed/i);

                await fs.rm(dir, { recursive: true, force: true });
            });
        });

        it('should classify a spawn failure as not retryable', async () => {
            await expect(
                runner.run({ argv: ['definitely-not-a-real-binary'], cwd }),
            ).rejects.toMatchObject({ code: 'command-failed', retryable: false });
        });
    });

    describe('invocation', () => {
        it('should pass arguments without a shell, so metacharacters are inert', async () => {
            const result = await runner.run({
                argv: [
                    process.execPath,
                    '-e',
                    'process.stdout.write(process.argv[1])',
                    '; rm -rf /',
                ],
                cwd,
            });

            expect(result.stdout).toBe('; rm -rf /');
        });

        it('should pass a supplied environment through', async () => {
            const result = await runner.run({
                argv: node('process.stdout.write(process.env.MAINTENANCE_PROBE ?? "unset")'),
                cwd,
                env: { ...process.env, MAINTENANCE_PROBE: 'set' },
            });

            expect(result.stdout).toBe('set');
        });

        it('should default the buffer generously enough for npm audit output', () => {
            expect(DEFAULT_MAX_BUFFER).toBeGreaterThanOrEqual(1024 * 1024);
        });
    });
});

describe('FakeCommandRunner', () => {
    it('should return a registered result', async () => {
        const fake = new FakeCommandRunner({
            'npm outdated --json': { exitCode: 1, stdout: '{}' },
        });

        const result = await fake.run({ argv: ['npm', 'outdated', '--json'], cwd });

        expect(result.exitCode).toBe(1);
        expect(result.stdout).toBe('{}');
    });

    it('should throw for an unregistered command, so no spec runs a real one', async () => {
        await expect(new FakeCommandRunner().run({ argv: ['npm', 'audit'], cwd })).rejects.toThrow(
            /no result registered/i,
        );
    });

    it('should reject with a registered error', async () => {
        const fake = new FakeCommandRunner({ npm: new CommandFailedError('boom', ['npm'], null) });

        await expect(fake.run({ argv: ['npm'], cwd })).rejects.toBeInstanceOf(CommandFailedError);
    });

    it('should record the calls it received', async () => {
        const fake = new FakeCommandRunner().on('npm ls', { stdout: 'x' });

        await fake.run({ argv: ['npm', 'ls'], cwd });

        expect(fake.calls).toHaveLength(1);
        expect(fake.calls[0].argv).toEqual(['npm', 'ls']);
    });
});

describe('OfflineCommandRunner [REQ-NET-020]', () => {
    it('should refuse every command, naming it', async () => {
        // Every command this stage runs reaches the network, so offline has to stop them
        // as surely as it stops HTTP requests.
        await expect(
            new OfflineCommandRunner().run({ argv: ['npm', 'audit', '--json'], cwd: '/repo' }),
        ).rejects.toThrow(OfflineError);
        await expect(
            new OfflineCommandRunner().run({ argv: ['npm', 'audit', '--json'], cwd: '/repo' }),
        ).rejects.toThrow(/npm audit --json/);
    });

    it('should classify the refusal as not worth retrying', async () => {
        const error = await new OfflineCommandRunner()
            .run({ argv: ['aws', 'eks', 'describe-cluster-versions'], cwd: '/repo' })
            .catch((caught: unknown) => caught as OfflineError);
        expect(error).toMatchObject({ code: 'offline', retryable: false });
    });
});
