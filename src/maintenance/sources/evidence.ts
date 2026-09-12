/**
 * Turning source interactions into evidence records.
 *
 * Kept in one place so every source produces the same shape, and so a finding can
 * always say where its "latest" came from (REQ-EVI-004, REQ-EVI-005).
 */

import { Evidence } from '../schema';
import { HttpResponse } from '../http/http-client';
import { CommandResult } from '../exec/command-runner';
import { createHash } from 'crypto';

/** Record an HTTP interaction. The body is not stored — only its provenance. */
export function httpEvidence(response: HttpResponse, method: 'GET' | 'HEAD' = 'GET'): Evidence {
    return {
        type: 'http',
        url: response.url,
        method,
        status: response.status,
        retrievedAt: response.retrievedAt,
        etag: response.headers.etag ?? null,
        fromCache: response.fromCache,
    };
}

/** Record a command invocation, digesting stdout rather than embedding it. */
export function commandEvidence(result: CommandResult): Evidence {
    return {
        type: 'command',
        argv: [...result.argv],
        cwd: result.cwd,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        stdoutSha256: createHash('sha256').update(result.stdout, 'utf8').digest('hex'),
        stderrExcerpt: result.stderr.length === 0 ? null : result.stderr.slice(0, 2000),
    };
}
