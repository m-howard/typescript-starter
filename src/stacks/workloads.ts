/**
 * Workload Stack - Deploys the user-facing surfaces of the knowledge base.
 *
 * Provisions three things and the SSO that ties them together:
 *  - **Reader portal** — a private S3 site behind CloudFront + WAF, gated at the edge by an SSO
 *    check (WAF filters traffic; it does not authenticate identity — this closes that gap).
 *  - **Chat / Retrieve API** — SSO-authorized + throttled, backed by the Lambda that enforces the
 *    per-user metadata ACL filter at retrieval.
 *  - **Writer proxy** — SSO-authorized + throttled, opening attributed GitHub PRs via an App.
 *
 * Depends on the service platform + stateful data stacks (their outputs arrive as config).
 *
 * @param env - The deployment environment (dev, val, prd)
 * @returns Pulumi outputs for the workload stack
 */
import * as fs from 'fs';
import * as pulumi from '@pulumi/pulumi';
import * as aws from '@pulumi/aws';
import { SsoUserPoolComponent } from '../components/cognito';
import { StaticSiteComponent } from '../components/cdn';
import { LambdaFunctionComponent } from '../components/lambda';
import { HttpApiComponent } from '../components/apigw';
import { parseStackName, standardTags } from './shared';

export interface StackOutputs {
    /** Informational message about the stack deployment. */
    message: pulumi.Output<string>;
    /** Public URL of the reader portal. */
    portalUrl: pulumi.Output<string>;
    /** Chat/Retrieve API endpoint, if created. */
    chatApiEndpoint?: pulumi.Output<string>;
    /** Writer proxy API endpoint, if created. */
    writerApiEndpoint?: pulumi.Output<string>;
}

/**
 * Creates the workload stack for the specified region/environment.
 *
 * @param env - The deployment stack name (`<region>-<env>`)
 * @returns Pulumi outputs for the workload stack
 */
export async function createStack(env: string): Promise<StackOutputs> {
    pulumi.log.info(`[workloads] Deploying workloads stack for environment: ${env}`);

    const identity = parseStackName(env);
    const tags = standardTags('workload', identity);
    const config = new pulumi.Config();
    const region = identity.region ?? aws.config.region ?? 'us-east-1';

    // --- Corporate SSO (federated IdP → Cognito) fronting the portal and APIs ---
    const domainPrefix = config.get('cognitoDomainPrefix') ?? `kb-docs-${identity.env}`;
    const portalDomain = config.get('portalDomain');
    const callbackBase = portalDomain ? `https://${portalDomain}` : 'https://localhost';
    const sso = new SsoUserPoolComponent('portal-sso', {
        name: pulumi.interpolate`kb-docs-${identity.env}`,
        domainPrefix,
        callbackUrls: [`${callbackBase}/oauth2/idpresponse`],
        logoutUrls: [`${callbackBase}/logout`],
        idp: {
            name: config.get('idpName') ?? 'Entra',
            type: (config.get('idpType') as 'OIDC' | 'SAML') ?? 'OIDC',
            details: {
                client_id: config.get('idpClientId') ?? 'placeholder-client-id',
                client_secret: config.getSecret('idpClientSecret') ?? 'placeholder-secret',
                oidc_issuer:
                    config.get('idpIssuer') ?? 'https://login.microsoftonline.com/TENANT/v2.0',
                authorize_scopes: 'openid email profile',
            },
            groupsAttribute: config.get('idpGroupsClaim') ?? 'groups',
        },
        tags,
    });

    // --- Edge SSO gate: template the CloudFront Function with the pool's domain + client id ---
    const edgeTemplate = fs.readFileSync('./functions/edge-sso-check/index.js', 'utf8');
    const edgeCode = pulumi
        .all([sso.domain.domain, sso.userPoolClient.id])
        .apply(([cognitoDomain, clientId]) =>
            edgeTemplate
                .replace('__COGNITO_DOMAIN__', `${cognitoDomain}.auth.${region}.amazoncognito.com`)
                .replace('__CLIENT_ID__', clientId),
        );
    const edgeFn = new aws.cloudfront.Function('portal-sso-check', {
        name: `kb-portal-sso-check-${identity.env}`,
        runtime: 'cloudfront-js-2.0',
        publish: true,
        code: edgeCode,
    });

    // --- Reader portal: private S3 + CloudFront + WAF, gated by the edge SSO check ---
    const portal = new StaticSiteComponent('reader-portal', {
        name: pulumi.interpolate`kb-portal-${identity.env}`,
        viewerRequestFunctionArn: edgeFn.arn,
        aliases: portalDomain ? [portalDomain] : undefined,
        acmCertificateArn: config.get('portalCertificateArn'),
        tags,
    });

    const outputs: StackOutputs = {
        message: pulumi.output(`Workloads (portal + SSO) deployed for: ${env}`),
        portalUrl: portal.url,
    };

    // Chat + writer APIs require the knowledge base; they wait on the platform layer's outputs.
    const knowledgeBaseId = config.get('knowledgeBaseId');
    if (!knowledgeBaseId) {
        pulumi.log.warn('[workloads] Waiting on svc-platform knowledgeBaseId. APIs skipped.');
        return outputs;
    }

    const chatModelArn =
        config.get('chatModelArn') ??
        `arn:aws:bedrock:${region}::foundation-model/anthropic.claude-3-5-haiku-20241022-v1:0`;
    const guardrailId = config.get('guardrailId');
    const jwt = {
        issuer: sso.issuerUrl,
        audiences: [sso.userPoolClient.id],
    };

    // --- Chat / Retrieve API: the ACL-enforcing retrieval Lambda behind an SSO-gated route ---
    const chatFn = new LambdaFunctionComponent('chat-api', {
        name: pulumi.interpolate`kb-chat-api-${identity.env}`,
        code: new pulumi.asset.FileArchive('./functions/chat-api'),
        timeout: 60,
        memorySize: 512,
        environment: {
            KNOWLEDGE_BASE_ID: knowledgeBaseId,
            MODEL_ARN: chatModelArn,
            GUARDRAIL_ID: guardrailId ?? '',
            GUARDRAIL_VERSION: config.get('guardrailVersion') ?? 'DRAFT',
        },
        inlinePolicy: JSON.stringify({
            Version: '2012-10-17',
            Statement: [
                {
                    Sid: 'RetrieveAndGenerate',
                    Effect: 'Allow',
                    Action: [
                        'bedrock:RetrieveAndGenerate',
                        'bedrock:Retrieve',
                        'bedrock:InvokeModel',
                        'bedrock:ApplyGuardrail',
                    ],
                    Resource: '*',
                },
            ],
        }),
        tags,
    });
    const chatApi = new HttpApiComponent('chat-api', {
        name: pulumi.interpolate`kb-chat-api-${identity.env}`,
        lambdaArn: chatFn.arn,
        lambdaName: chatFn.function.name,
        jwt,
        routes: [{ routeKey: 'POST /chat' }],
        throttle: { rateLimit: 20, burstLimit: 40 },
        corsOrigins: portalDomain ? [`https://${portalDomain}`] : undefined,
        tags,
    });
    outputs.chatApiEndpoint = chatApi.endpoint;

    // --- Writer proxy: SSO-authorized contribution, attributed to the real user in the PR ---
    const githubSecret = new aws.secretsmanager.Secret('kb-github-app', {
        name: pulumi.interpolate`kb/github-app/${identity.env}`,
        description: 'GitHub App credentials for the docs writer proxy',
        tags,
    });
    const writerFn = new LambdaFunctionComponent('writer-proxy', {
        name: pulumi.interpolate`kb-writer-proxy-${identity.env}`,
        code: new pulumi.asset.FileArchive('./functions/writer-proxy'),
        timeout: 30,
        environment: {
            GITHUB_APP_SECRET_ARN: githubSecret.arn,
            DOCS_REPO: config.get('docsRepo') ?? 'm-howard/typescript-starter',
            DOCS_BRANCH: config.get('docsBranch') ?? 'main',
        },
        inlinePolicy: githubSecret.arn.apply((arn) =>
            JSON.stringify({
                Version: '2012-10-17',
                Statement: [
                    {
                        Sid: 'ReadGithubAppSecret',
                        Effect: 'Allow',
                        Action: ['secretsmanager:GetSecretValue'],
                        Resource: [arn],
                    },
                ],
            }),
        ),
        tags,
    });
    const writerApi = new HttpApiComponent('writer-proxy', {
        name: pulumi.interpolate`kb-writer-proxy-${identity.env}`,
        lambdaArn: writerFn.arn,
        lambdaName: writerFn.function.name,
        jwt,
        routes: [{ routeKey: 'POST /submit' }],
        // Tighter throttle: contribution is far lower volume than Q&A and a bigger abuse vector.
        throttle: { rateLimit: 2, burstLimit: 5 },
        corsOrigins: portalDomain ? [`https://${portalDomain}`] : undefined,
        tags,
    });
    outputs.writerApiEndpoint = writerApi.endpoint;

    outputs.message = pulumi.output(`Workloads (portal + chat + writer) deployed for: ${env}`);
    return outputs;
}
