/**
 * Outbound HTTP.
 *
 * Node 22's global `fetch` does the work; this seam exists so every unit test can run
 * without a network, and so failures are classified consistently rather than at each
 * call site.
 *
 * Failure shapes were probed on Node 22:
 * - `AbortSignal.timeout()` rejects with a `DOMException` named **`TimeoutError`**,
 *   not `AbortError` — the reflexive check would miss every timeout.
 * - A DNS or transport failure rejects with a `TypeError` carrying `cause.code`.
 * - An HTTP status is not an exception; the caller classifies it.
 */

import { NetworkError, RateLimitedError, TimeoutError, toError } from '../errors';
import { Clock } from '../clock';
import { delay } from '../../utils/helpers';

export interface HttpRequest {
    url: string;
    method?: 'GET' | 'HEAD';
    headers?: Record<string, string>;
    /** Overrides the client default. */
    timeoutMs?: number;
}

export interface HttpResponse {
    url: string;
    status: number;
    ok: boolean;
    body: string;
    headers: Record<string, string>;
    retrievedAt: string;
    /** True when served from this run's in-memory cache rather than the network. */
    fromCache: boolean;
}

export interface HttpClient {
    request(request: HttpRequest): Promise<HttpResponse>;
}

export interface FetchHttpClientOptions {
    clock: Clock;
    timeoutMs?: number;
    /** Attempts after the first, for retryable failures. */
    retries?: number;
    /** Base backoff, doubled per attempt. */
    retryBaseMs?: number;
    /** Injected for tests; defaults to the global. */
    fetchImpl?: typeof fetch;
    /** Sent as a bearer token to GitHub hosts only. */
    githubToken?: string | null;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_RETRIES = 2;
const DEFAULT_RETRY_BASE_MS = 250;

/** Hosts that receive the GitHub token. Never send a credential to an unrelated host. */
const GITHUB_HOSTS: ReadonlySet<string> = new Set(['api.github.com']);

export class FetchHttpClient implements HttpClient {
    private readonly clock: Clock;
    private readonly timeoutMs: number;
    private readonly retries: number;
    private readonly retryBaseMs: number;
    private readonly fetchImpl: typeof fetch;
    private readonly githubToken: string | null;

    /**
     * Responses already fetched during this run.
     *
     * The arc and images collectors both ask for the same runner image, and
     * unauthenticated GitHub allows 60 requests an hour — so each distinct reference is
     * fetched at most once (REQ-NET-023).
     */
    private readonly cache = new Map<string, HttpResponse>();

    constructor(options: FetchHttpClientOptions) {
        this.clock = options.clock;
        this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        this.retries = options.retries ?? DEFAULT_RETRIES;
        this.retryBaseMs = options.retryBaseMs ?? DEFAULT_RETRY_BASE_MS;
        this.fetchImpl = options.fetchImpl ?? fetch;
        this.githubToken = options.githubToken ?? null;
    }

    public async request(request: HttpRequest): Promise<HttpResponse> {
        const method = request.method ?? 'GET';
        const key = `${method} ${request.url}`;
        const cached = this.cache.get(key);
        if (cached !== undefined) {
            return { ...cached, fromCache: true };
        }

        const response = await this.attempt(request, method, 0);
        this.cache.set(key, response);
        return response;
    }

    /** One attempt, retrying retryable failures with exponential backoff. */
    private async attempt(
        request: HttpRequest,
        method: 'GET' | 'HEAD',
        attempt: number,
    ): Promise<HttpResponse> {
        try {
            const response = await this.send(request, method);
            const limited = this.detectRateLimit(response);
            if (limited !== null) {
                throw limited;
            }
            return response;
        } catch (error: unknown) {
            const classified = this.classify(error, request.url);
            const retryable =
                classified instanceof Error && 'retryable' in classified
                    ? (classified as { retryable: boolean }).retryable
                    : false;
            if (!retryable || attempt >= this.retries) {
                throw classified;
            }
            await delay(this.retryBaseMs * 2 ** attempt);
            return this.attempt(request, method, attempt + 1);
        }
    }

    private async send(request: HttpRequest, method: 'GET' | 'HEAD'): Promise<HttpResponse> {
        const response = await this.fetchImpl(request.url, {
            method,
            headers: this.buildHeaders(request),
            signal: AbortSignal.timeout(request.timeoutMs ?? this.timeoutMs),
        });
        const headers: Record<string, string> = {};
        response.headers.forEach((value, name) => {
            headers[name.toLowerCase()] = value;
        });
        return {
            url: request.url,
            status: response.status,
            ok: response.ok,
            body: method === 'HEAD' ? '' : await response.text(),
            headers,
            retrievedAt: this.clock.nowIso(),
            fromCache: false,
        };
    }

    private buildHeaders(request: HttpRequest): Record<string, string> {
        const headers: Record<string, string> = {
            accept: 'application/json',
            'user-agent': 'typescript-starter-maintenance-scan',
            ...request.headers,
        };
        if (this.githubToken !== null && isGitHubHost(request.url)) {
            headers.authorization = `Bearer ${this.githubToken}`;
        }
        return headers;
    }

    /**
     * Recognise an exhausted rate limit.
     *
     * GitHub reports a primary limit as 403 with `x-ratelimit-remaining: 0`, and a
     * secondary limit as 429. Classifying these as `rate-limited` rather than a generic
     * failure is what lets affected findings surface as unresolved instead of being
     * mistaken for "nothing to report" (REQ-ERR-032).
     */
    private detectRateLimit(response: HttpResponse): RateLimitedError | null {
        const remaining = response.headers['x-ratelimit-remaining'];
        const isPrimary = response.status === 403 && remaining === '0';
        if (!isPrimary && response.status !== 429) {
            return null;
        }
        return new RateLimitedError(`Rate limit exhausted for ${response.url}`, {
            target: response.url,
            retryAfterMs: this.retryAfterMs(response),
        });
    }

    /** Milliseconds until the limit resets, from `retry-after` or `x-ratelimit-reset`. */
    private retryAfterMs(response: HttpResponse): number | null {
        const retryAfter = Number(response.headers['retry-after']);
        if (Number.isFinite(retryAfter) && retryAfter >= 0) {
            return retryAfter * 1000;
        }
        const resetAtSeconds = Number(response.headers['x-ratelimit-reset']);
        if (!Number.isFinite(resetAtSeconds)) {
            return null;
        }
        return Math.max(0, resetAtSeconds * 1000 - this.clock.now().getTime());
    }

    /** Turn a thrown value into a classified maintenance error. */
    private classify(error: unknown, url: string): Error {
        if (error instanceof RateLimitedError || error instanceof TimeoutError) {
            return error;
        }
        if (error instanceof Error && error.name === 'TimeoutError') {
            return new TimeoutError(`Request timed out: ${url}`, { target: url });
        }
        const cause = (error as { cause?: { code?: string } }).cause;
        const detail = cause?.code === undefined ? toError(error).message : cause.code;
        return new NetworkError(`Request failed: ${url} (${detail})`, {
            target: url,
            cause: error,
        });
    }
}

function isGitHubHost(url: string): boolean {
    try {
        return GITHUB_HOSTS.has(new URL(url).hostname);
    } catch {
        return false;
    }
}
