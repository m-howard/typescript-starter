/**
 * The offline implementation: every request is refused.
 *
 * Offline mode is not a special case bolted onto the collectors — it is the same
 * "unresolved" mechanism at full scale. Each refused request becomes a finding marked
 * unresolved with a reason, so an offline run still produces a schema-valid report and
 * still exits zero (REQ-NET-020, REQ-NET-021, REQ-NET-022).
 *
 * It is also the default double in tests, so a spec that reaches for the network fails
 * loudly rather than silently depending on it.
 */

import { OfflineError } from '../errors';
import { HttpClient, HttpRequest, HttpResponse } from './http-client';

export class OfflineHttpClient implements HttpClient {
    public request(request: HttpRequest): Promise<HttpResponse> {
        return Promise.reject(new OfflineError(request.url));
    }
}
