import {
    CommandFailedError,
    ConfigError,
    InternalError,
    MAINTENANCE_ERROR_CODES,
    MaintenanceError,
    NetworkError,
    NotFoundError,
    NotImplementedError,
    OfflineError,
    ParseError,
    RateLimitedError,
    TimeoutError,
    UnsupportedError,
    toError,
    toMaintenanceError,
} from '../src/maintenance/errors';

describe('MaintenanceError', () => {
    describe('construction', () => {
        it('should carry a code, message and retryable flag [REQ-ERR-036]', () => {
            const error = new MaintenanceError('network', 'boom');

            expect(error.code).toBe('network');
            expect(error.message).toBe('boom');
            expect(typeof error.retryable).toBe('boolean');
        });

        it('should default target to null and expose it [REQ-ERR-036]', () => {
            expect(new MaintenanceError('internal', 'boom').target).toBeNull();
            expect(new MaintenanceError('internal', 'boom', { target: 'npm:zod' }).target).toBe(
                'npm:zod',
            );
        });

        it('should be an instance of Error and of its own subclass', () => {
            const error = new NotFoundError('missing');

            expect(error).toBeInstanceOf(Error);
            expect(error).toBeInstanceOf(MaintenanceError);
            expect(error).toBeInstanceOf(NotFoundError);
            expect(error.name).toBe('NotFoundError');
        });

        it('should allow the default retryability to be overridden', () => {
            expect(new NetworkError('boom').retryable).toBe(true);
            expect(new NetworkError('boom', { retryable: false }).retryable).toBe(false);
        });

        it('should preserve the cause when one is supplied', () => {
            const cause = new Error('underlying');

            expect(new InternalError('wrapped', { cause }).cause).toBe(cause);
        });
    });

    describe('retryability by code', () => {
        it.each([
            ['transport failures are retryable', new NetworkError('x'), true],
            ['rate limits are retryable [REQ-ERR-032]', new RateLimitedError('x'), true],
            ['timeouts are retryable', new TimeoutError('x'), true],
            ['offline is not retryable', new OfflineError('npm:zod'), false],
            ['missing resources are not retryable', new NotFoundError('x'), false],
            ['parse errors are not retryable', new ParseError('x'), false],
            ['config errors are not retryable', new ConfigError('x'), false],
            ['unsupported is not retryable', new UnsupportedError('x'), false],
            ['internal errors are not retryable', new InternalError('x'), false],
        ])('should classify %s', (_label, error: MaintenanceError, expected: boolean) => {
            expect(error.retryable).toBe(expected);
        });

        it('should assign every declared code a retryability default [REQ-ERR-036]', () => {
            for (const code of MAINTENANCE_ERROR_CODES) {
                expect(typeof new MaintenanceError(code, 'x').retryable).toBe('boolean');
            }
        });
    });

    describe('OfflineError', () => {
        it('should name the target it refused to request [REQ-NET-020]', () => {
            const error = new OfflineError('https://registry.npmjs.org/zod');

            expect(error.code).toBe('offline');
            expect(error.target).toBe('https://registry.npmjs.org/zod');
            expect(error.message).toContain('https://registry.npmjs.org/zod');
        });
    });

    describe('RateLimitedError', () => {
        it('should default retryAfterMs to null when the response did not say', () => {
            expect(new RateLimitedError('slow down').retryAfterMs).toBeNull();
        });

        it('should carry retryAfterMs when the response did say [REQ-NET-027]', () => {
            expect(new RateLimitedError('slow down', { retryAfterMs: 60_000 }).retryAfterMs).toBe(
                60_000,
            );
        });
    });

    describe('CommandFailedError', () => {
        it('should record the argv and exit code [REQ-NPM-013]', () => {
            const error = new CommandFailedError('npm outdated failed', ['npm', 'outdated'], 2);

            expect(error.code).toBe('command-failed');
            expect(error.argv).toEqual(['npm', 'outdated']);
            expect(error.exitCode).toBe(2);
        });

        it('should default its target to the executable', () => {
            expect(new CommandFailedError('x', ['npm', 'audit'], 2).target).toBe('npm');
        });

        it('should accept a null exit code when the process did not exit normally', () => {
            expect(new CommandFailedError('killed', ['npm'], null).exitCode).toBeNull();
        });

        it('should tolerate an empty argv rather than producing an undefined target', () => {
            expect(new CommandFailedError('no command', [], null).target).toBeNull();
        });
    });

    describe('NotImplementedError', () => {
        it('should be an unsupported error, for the deferred provider seam', () => {
            const error = new NotImplementedError('GitHubContentsProvider cannot read a.yml yet');

            expect(error).toBeInstanceOf(UnsupportedError);
            expect(error.code).toBe('unsupported');
            expect(error.retryable).toBe(false);
        });
    });
});

describe('toError', () => {
    it('should return an Error unchanged', () => {
        const error = new Error('original');

        expect(toError(error)).toBe(error);
    });

    it('should wrap a thrown string', () => {
        expect(toError('just a string').message).toBe('just a string');
    });

    it.each([
        ['an object', { code: 'ENOENT' }, '{"code":"ENOENT"}'],
        ['null', null, 'null'],
        ['undefined', undefined, 'undefined'],
        ['a number', 42, '42'],
    ])('should render %s without throwing', (_label, value: unknown, expected: string) => {
        expect(toError(value).message).toBe(expected);
    });

    it('should render a value JSON.stringify returns undefined for', () => {
        expect(toError(() => undefined).message).toContain('=>');
        expect(toError(Symbol('x')).message).toContain('Symbol');
    });

    it('should survive a value that cannot be serialised', () => {
        const circular: Record<string, unknown> = {};
        circular.self = circular;

        expect(() => toError(circular)).not.toThrow();
        expect(toError(circular)).toBeInstanceOf(Error);
    });
});

describe('toMaintenanceError', () => {
    it('should return a MaintenanceError unchanged', () => {
        const error = new NotFoundError('missing');

        expect(toMaintenanceError(error)).toBe(error);
    });

    it('should classify an unknown throw as internal and keep the cause [REQ-ERR-031]', () => {
        const cause = new Error('kaboom');
        const error = toMaintenanceError(cause, 'npm');

        expect(error).toBeInstanceOf(InternalError);
        expect(error.code).toBe('internal');
        expect(error.message).toBe('kaboom');
        expect(error.target).toBe('npm');
        expect(error.cause).toBe(cause);
    });

    it('should classify a non-Error throw so nothing escapes classification', () => {
        expect(toMaintenanceError('a bare string').code).toBe('internal');
    });
});

describe('toError across realms', () => {
    it('should keep the message of an error that fails instanceof', () => {
        // Node internals, workers and vm contexts all produce errors whose `instanceof
        // Error` is false in the calling realm. Rendering them as JSON loses the only
        // sentence worth reading, because `message` is not an own property.
        const foreign = { name: 'TypeError', message: "Unknown option '--offlien'" };
        const converted = toError(foreign);
        expect(converted).toBeInstanceOf(Error);
        expect(converted.message).toBe("Unknown option '--offlien'");
        expect(converted.name).toBe('TypeError');
    });

    it('should default the name when only a message is present', () => {
        expect(toError({ message: 'something went wrong' }).name).toBe('Error');
    });

    it('should still render an object carrying no message', () => {
        expect(toError({ code: 'ENOENT' }).message).toBe('{"code":"ENOENT"}');
    });
});
