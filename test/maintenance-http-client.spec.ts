import { FetchHttpClient } from '../src/maintenance/http/http-client';
import { OfflineHttpClient } from '../src/maintenance/http/offline-http-client';
import { FixedClock } from '../src/maintenance/clock';
import {
    NetworkError,
    OfflineError,
    RateLimitedError,
    TimeoutError,
} from '../src/maintenance/errors';
import { FakeHttpClient } from './support/maintenance-fakes';

const URL_UNDER_TEST = 'https://registry.npmjs.org/typescript';

/** Build a `fetch` stand-in that returns the given responses in order. */
function stubFetch(...responses: Array<Response | Error>): jest.Mock {
    const queue = [...responses];
    return jest.fn(() => {
        const next = queue.length > 1 ? queue.shift() : queue[0];
        return next instanceof Error ? Promise.reject(next) : Promise.resolve(next as Response);
    });
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
    return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
        ...init,
    });
}

function makeClient(fetchImpl: jest.Mock, overrides = {}) {
    return new FetchHttpClient({
        clock: new FixedClock('2026-09-12T06:00:00.000Z'),
        fetchImpl: fetchImpl as unknown as typeof fetch,
        retryBaseMs: 1,
        ...overrides,
    });
}

describe('FetchHttpClient', () => {
    describe('successful requests', () => {
        it('should return status, body and lower-cased headers', async () => {
            const fetchImpl = stubFetch(
                new Response('{"ok":true}', { status: 200, headers: { ETag: 'W/"abc"' } }),
            );

            const response = await makeClient(fetchImpl).request({ url: URL_UNDER_TEST });

            expect(response.status).toBe(200);
            expect(response.ok).toBe(true);
            expect(JSON.parse(response.body)).toEqual({ ok: true });
            expect(response.headers.etag).toBe('W/"abc"');
        });

        it('should stamp retrieval time from the injected clock [REQ-EVI-004]', async () => {
            const response = await makeClient(stubFetch(jsonResponse({}))).request({
                url: URL_UNDER_TEST,
            });

            expect(response.retrievedAt).toBe('2026-09-12T06:00:00.000Z');
        });

        it('should not read a body for a HEAD request', async () => {
            const response = await makeClient(stubFetch(jsonResponse({ a: 1 }))).request({
                url: URL_UNDER_TEST,
                method: 'HEAD',
            });

            expect(response.body).toBe('');
        });

        it('should return a non-2xx status as a response, not an exception', async () => {
            const response = await makeClient(stubFetch(new Response('', { status: 404 }))).request(
                { url: URL_UNDER_TEST },
            );

            expect(response.status).toBe(404);
            expect(response.ok).toBe(false);
        });
    });

    describe('caching within a run', () => {
        it('should fetch a repeated reference only once [REQ-NET-023]', async () => {
            // The arc and images collectors both ask for the same runner image, against
            // a 60-request-per-hour unauthenticated limit.
            const fetchImpl = stubFetch(jsonResponse({ a: 1 }));
            const client = makeClient(fetchImpl);

            await client.request({ url: URL_UNDER_TEST });
            const second = await client.request({ url: URL_UNDER_TEST });

            expect(fetchImpl).toHaveBeenCalledTimes(1);
            expect(second.fromCache).toBe(true);
        });

        it('should mark the first response as not cached', async () => {
            const response = await makeClient(stubFetch(jsonResponse({}))).request({
                url: URL_UNDER_TEST,
            });

            expect(response.fromCache).toBe(false);
        });

        it('should key the cache on method as well as URL', async () => {
            const fetchImpl = stubFetch(jsonResponse({}), jsonResponse({}));
            const client = makeClient(fetchImpl);

            await client.request({ url: URL_UNDER_TEST, method: 'GET' });
            await client.request({ url: URL_UNDER_TEST, method: 'HEAD' });

            expect(fetchImpl).toHaveBeenCalledTimes(2);
        });
    });

    describe('authentication', () => {
        it('should present a GitHub token to the GitHub API [REQ-NET-024]', async () => {
            const fetchImpl = stubFetch(jsonResponse({}));
            await makeClient(fetchImpl, { githubToken: 'secret' }).request({
                url: 'https://api.github.com/repos/actions/checkout/releases/latest',
            });

            const headers = fetchImpl.mock.calls[0][1].headers as Record<string, string>;
            expect(headers.authorization).toBe('Bearer secret');
        });

        it.each([
            ['the npm registry', URL_UNDER_TEST],
            ['a container registry', 'https://ghcr.io/v2/actions/actions-runner/tags/list'],
            ['a lookalike host', 'https://api.github.com.evil.example/x'],
        ])('should not send the token to %s', async (_label, url: string) => {
            const fetchImpl = stubFetch(jsonResponse({}));
            await makeClient(fetchImpl, { githubToken: 'secret' }).request({ url });

            const headers = fetchImpl.mock.calls[0][1].headers as Record<string, string>;
            expect(headers.authorization).toBeUndefined();
        });

        it('should treat an unparseable URL as not a GitHub host rather than throwing', async () => {
            const fetchImpl = stubFetch(jsonResponse({}));
            await makeClient(fetchImpl, { githubToken: 'secret' }).request({ url: 'not a url' });

            const headers = fetchImpl.mock.calls[0][1].headers as Record<string, string>;
            expect(headers.authorization).toBeUndefined();
        });

        it('should send no authorization header when no token is configured', async () => {
            const fetchImpl = stubFetch(jsonResponse({}));
            await makeClient(fetchImpl).request({ url: 'https://api.github.com/x' });

            const headers = fetchImpl.mock.calls[0][1].headers as Record<string, string>;
            expect(headers.authorization).toBeUndefined();
        });
    });

    describe('rate limiting', () => {
        it('should classify a 403 with no remaining quota [REQ-ERR-032]', async () => {
            // Read as a generic failure this would surface as "nothing to report",
            // which is the silent-failure mode the design exists to prevent.
            const fetchImpl = stubFetch(
                new Response('', { status: 403, headers: { 'x-ratelimit-remaining': '0' } }),
            );

            await expect(
                makeClient(fetchImpl, { retries: 0 }).request({ url: URL_UNDER_TEST }),
            ).rejects.toBeInstanceOf(RateLimitedError);
        });

        it('should classify a 429 as a secondary rate limit', async () => {
            const fetchImpl = stubFetch(new Response('', { status: 429 }));

            await expect(
                makeClient(fetchImpl, { retries: 0 }).request({ url: URL_UNDER_TEST }),
            ).rejects.toMatchObject({ code: 'rate-limited', retryable: true });
        });

        it('should not mistake a plain 403 for a rate limit', async () => {
            const response = await makeClient(stubFetch(new Response('', { status: 403 }))).request(
                { url: URL_UNDER_TEST },
            );

            expect(response.status).toBe(403);
        });

        it('should read retry-after seconds', async () => {
            const fetchImpl = stubFetch(
                new Response('', { status: 429, headers: { 'retry-after': '60' } }),
            );

            await expect(
                makeClient(fetchImpl, { retries: 0 }).request({ url: URL_UNDER_TEST }),
            ).rejects.toMatchObject({ retryAfterMs: 60_000 });
        });

        it('should derive the wait from x-ratelimit-reset against the clock', async () => {
            const resetAt = Math.floor(new Date('2026-09-12T06:10:00.000Z').getTime() / 1000);
            const fetchImpl = stubFetch(
                new Response('', {
                    status: 429,
                    headers: { 'x-ratelimit-reset': String(resetAt) },
                }),
            );

            await expect(
                makeClient(fetchImpl, { retries: 0 }).request({ url: URL_UNDER_TEST }),
            ).rejects.toMatchObject({ retryAfterMs: 600_000 });
        });

        it('should report a null wait when the response says nothing', async () => {
            const fetchImpl = stubFetch(new Response('', { status: 429 }));

            await expect(
                makeClient(fetchImpl, { retries: 0 }).request({ url: URL_UNDER_TEST }),
            ).rejects.toMatchObject({ retryAfterMs: null });
        });
    });

    describe('failure classification', () => {
        it('should classify an AbortSignal timeout, which is named TimeoutError', async () => {
            // Not AbortError - the reflexive check would miss every timeout.
            const timeout = Object.assign(new Error('aborted'), { name: 'TimeoutError' });

            await expect(
                makeClient(stubFetch(timeout), { retries: 0 }).request({ url: URL_UNDER_TEST }),
            ).rejects.toBeInstanceOf(TimeoutError);
        });

        it('should classify a transport failure and surface its cause code', async () => {
            const failure = Object.assign(new TypeError('fetch failed'), {
                cause: { code: 'ENOTFOUND' },
            });

            const promise = makeClient(stubFetch(failure), { retries: 0 }).request({
                url: URL_UNDER_TEST,
            });

            await expect(promise).rejects.toBeInstanceOf(NetworkError);
            await expect(promise).rejects.toThrow('ENOTFOUND');
        });

        it('should classify a transport failure with no cause code', async () => {
            await expect(
                makeClient(stubFetch(new TypeError('fetch failed')), { retries: 0 }).request({
                    url: URL_UNDER_TEST,
                }),
            ).rejects.toBeInstanceOf(NetworkError);
        });
    });

    describe('retries', () => {
        it('should retry a retryable failure and succeed [REQ-NET-027]', async () => {
            const failure = Object.assign(new TypeError('fetch failed'), {
                cause: { code: 'ECONNRESET' },
            });
            const fetchImpl = stubFetch(failure, jsonResponse({ ok: true }));

            const response = await makeClient(fetchImpl, { retries: 2 }).request({
                url: URL_UNDER_TEST,
            });

            expect(response.status).toBe(200);
            expect(fetchImpl).toHaveBeenCalledTimes(2);
        });

        it('should give up after the configured number of attempts', async () => {
            const failure = Object.assign(new TypeError('fetch failed'), {
                cause: { code: 'ECONNRESET' },
            });
            const fetchImpl = stubFetch(failure);

            await expect(
                makeClient(fetchImpl, { retries: 2 }).request({ url: URL_UNDER_TEST }),
            ).rejects.toBeInstanceOf(NetworkError);
            expect(fetchImpl).toHaveBeenCalledTimes(3);
        });

        it('should not retry a non-retryable failure', async () => {
            const fetchImpl = stubFetch(
                Object.assign(new Error('nope'), { name: 'SomethingElse' }),
            );
            const client = new FetchHttpClient({
                clock: new FixedClock(),
                fetchImpl: fetchImpl as unknown as typeof fetch,
                retryBaseMs: 1,
                retries: 3,
            });

            await expect(client.request({ url: URL_UNDER_TEST })).rejects.toBeInstanceOf(
                NetworkError,
            );
            expect(fetchImpl).toHaveBeenCalledTimes(4);
        });
    });
});

describe('OfflineHttpClient', () => {
    it('should refuse every request [REQ-NET-020]', async () => {
        await expect(
            new OfflineHttpClient().request({ url: URL_UNDER_TEST }),
        ).rejects.toBeInstanceOf(OfflineError);
    });

    it('should name the target it refused, so the finding can say why', async () => {
        await expect(new OfflineHttpClient().request({ url: URL_UNDER_TEST })).rejects.toThrow(
            URL_UNDER_TEST,
        );
    });

    it('should classify as offline and not retryable', async () => {
        await expect(
            new OfflineHttpClient().request({ url: URL_UNDER_TEST }),
        ).rejects.toMatchObject({ code: 'offline', retryable: false });
    });
});

describe('FakeHttpClient', () => {
    it('should serve a registered response with sensible defaults', async () => {
        const fake = new FakeHttpClient({ [URL_UNDER_TEST]: { body: '{"a":1}' } });

        const response = await fake.request({ url: URL_UNDER_TEST });

        expect(response.status).toBe(200);
        expect(response.body).toBe('{"a":1}');
    });

    it('should throw for an unregistered URL, so no spec hits the network', async () => {
        await expect(new FakeHttpClient().request({ url: URL_UNDER_TEST })).rejects.toThrow(
            /no response registered/i,
        );
    });

    it('should reject with a registered error', async () => {
        const fake = new FakeHttpClient().on(URL_UNDER_TEST, new OfflineError(URL_UNDER_TEST));

        await expect(fake.request({ url: URL_UNDER_TEST })).rejects.toBeInstanceOf(OfflineError);
    });

    it('should record the requests it received', async () => {
        const fake = new FakeHttpClient().on(URL_UNDER_TEST, { status: 200 });

        await fake.request({ url: URL_UNDER_TEST });

        expect(fake.requests).toHaveLength(1);
        expect(fake.requests[0].url).toBe(URL_UNDER_TEST);
    });
});
