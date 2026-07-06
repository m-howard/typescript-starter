/**
 * Writer proxy - License-free contribution via a GitHub App, with SSO attribution.
 *
 * Lets any SSO-authenticated reader submit a doc edit without a GitHub seat. Two corrections are
 * enforced here:
 *  - The route is SSO-authorized (JWT authorizer) and throttled at the gateway, so this is not an
 *    open PR-spam endpoint.
 *  - The SSO user is stamped into the commit trailer and PR body. The App bot authors the commit,
 *    but attribution and auditability are preserved by embedding the real user identity.
 *
 * The maintainer pool reviews via branch protection + CODEOWNERS before merge.
 *
 * Env: GITHUB_APP_SECRET_ARN, DOCS_REPO (owner/repo), DOCS_BRANCH
 */
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { createSign } from 'node:crypto';

const secrets = new SecretsManagerClient({});

export const handler = async (event) => {
    const claims = event.requestContext?.authorizer?.jwt?.claims ?? {};
    const ssoUser = claims.email ?? claims['cognito:username'] ?? claims.sub;
    if (!ssoUser) {
        return json(401, { error: 'Unable to resolve caller identity from SSO token.' });
    }

    let body;
    try {
        body = JSON.parse(event.body ?? '{}');
    } catch {
        return json(400, { error: 'Invalid JSON body.' });
    }
    const { path, content, summary } = body;
    if (!path || !content || !summary) {
        return json(400, { error: 'Fields "path", "content" and "summary" are required.' });
    }

    const appCreds = await getAppCredentials();
    const branch = `contrib/${sanitize(ssoUser)}-${Date.now()}`;

    // Attribution: the App bot authors the commit, but the SSO user is recorded in the trailer
    // and PR body so the audit trail ties the change back to a real person.
    const commitMessage = `docs: ${summary}\n\nSubmitted-by: ${ssoUser}\nCo-authored-by: ${ssoUser} <${ssoUser}>`;
    const prBody = [
        `Documentation edit submitted via the reader portal.`,
        ``,
        `**Submitted by:** ${ssoUser}`,
        `**Path:** \`${path}\``,
        ``,
        summary,
    ].join('\n');

    const pr = await createPullRequest({
        creds: appCreds,
        repo: process.env.DOCS_REPO,
        baseBranch: process.env.DOCS_BRANCH ?? 'main',
        headBranch: branch,
        path,
        content,
        commitMessage,
        prTitle: `docs: ${summary}`,
        prBody,
    });

    return json(201, { pullRequestUrl: pr.html_url, submittedBy: ssoUser });
};

async function getAppCredentials() {
    const arn = process.env.GITHUB_APP_SECRET_ARN;
    const res = await secrets.send(new GetSecretValueCommand({ SecretId: arn }));
    return JSON.parse(res.SecretString ?? '{}');
}

/**
 * Create the branch, commit the file, and open the PR through the GitHub App installation.
 * Uses the REST API directly to avoid pulling an SDK into the Lambda bundle.
 */
async function createPullRequest(opts) {
    const token = await mintInstallationToken(opts.creds);
    const api = `https://api.github.com/repos/${opts.repo}`;
    const headers = {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'user-agent': 'docs-writer-proxy',
    };

    // Encode each path segment but keep the `/` separators (GitHub treats %2F as a literal, not a
    // separator, so a single encodeURIComponent would target the wrong object for nested docs).
    const encodedPath = opts.path.split('/').map(encodeURIComponent).join('/');

    const base = await gh(`${api}/git/ref/heads/${opts.baseBranch}`, { headers });
    await gh(`${api}/git/refs`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ ref: `refs/heads/${opts.headBranch}`, sha: base.object.sha }),
    });

    let existingSha;
    try {
        const existing = await gh(`${api}/contents/${encodedPath}?ref=${opts.headBranch}`, {
            headers,
        });
        existingSha = existing.sha;
    } catch {
        /* new file */
    }

    await gh(`${api}/contents/${encodedPath}`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({
            message: opts.commitMessage,
            content: Buffer.from(opts.content, 'utf8').toString('base64'),
            branch: opts.headBranch,
            sha: existingSha,
        }),
    });

    return gh(`${api}/pulls`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
            title: opts.prTitle,
            body: opts.prBody,
            head: opts.headBranch,
            base: opts.baseBranch,
        }),
    });
}

async function mintInstallationToken(creds) {
    // Exchange the App JWT for a short-lived installation token scoped to the docs repo only.
    const appJwt = createAppJwt(creds.appId, creds.privateKey);
    const res = await gh(
        `https://api.github.com/app/installations/${creds.installationId}/access_tokens`,
        {
            method: 'POST',
            headers: {
                authorization: `Bearer ${appJwt}`,
                accept: 'application/vnd.github+json',
                'user-agent': 'docs-writer-proxy',
            },
        },
    );
    return res.token;
}

function createAppJwt(appId, privateKey) {
    const now = Math.floor(Date.now() / 1000);
    const header = { alg: 'RS256', typ: 'JWT' };
    const payload = { iat: now - 60, exp: now + 540, iss: appId };
    const enc = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
    const signingInput = `${enc(header)}.${enc(payload)}`;
    const signature = createSign('RSA-SHA256').update(signingInput).sign(privateKey, 'base64url');
    return `${signingInput}.${signature}`;
}

async function gh(url, init) {
    const res = await fetch(url, init);
    if (!res.ok) {
        throw new Error(`GitHub API ${res.status}: ${await res.text()}`);
    }
    return res.json();
}

function sanitize(value) {
    return String(value)
        .replace(/[^a-zA-Z0-9]+/g, '-')
        .toLowerCase()
        .slice(0, 40);
}

function json(statusCode, payload) {
    return {
        statusCode,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
    };
}
