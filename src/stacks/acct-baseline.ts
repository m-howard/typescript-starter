/**
 * Account Baseline Stack - Establishes foundational account-wide controls and guardrails.
 *
 * For the docs-as-code knowledge base this provisions the GitHub Actions OIDC trust: a federated
 * identity provider plus a least-privilege deployment role assumed via short-lived OIDC tokens
 * (no static keys). This is the correct pattern for CI offload to AWS and is the root of the
 * dependency graph — it must be deployed before all other stacks.
 *
 * @param env - The deployment environment (dev, val, prd)
 * @returns Pulumi outputs for the account baseline stack
 */
import * as pulumi from '@pulumi/pulumi';
import * as aws from '@pulumi/aws';
import { parseStackName, standardTags } from './shared';

export interface StackOutputs {
    /** Informational message about the stack deployment. */
    message: pulumi.Output<string>;
    /** ARN of the role GitHub Actions assumes via OIDC. */
    deployRoleArn: pulumi.Output<string>;
}

/**
 * Creates the account baseline stack for the specified environment.
 *
 * @param env - The deployment environment or stack name
 * @returns Pulumi outputs for the account baseline stack
 */
export async function createStack(env: string): Promise<StackOutputs> {
    pulumi.log.info(`[acct-baseline] Deploying account baseline stack for environment: ${env}`);

    const identity = parseStackName(env);
    const tags = standardTags('acct-baseline', identity);
    const config = new pulumi.Config();

    // GitHub org/repo permitted to assume the deploy role, and the ref condition.
    const githubRepo = config.get('githubRepo') ?? 'm-howard/typescript-starter';
    const githubRef = config.get('githubRef') ?? 'refs/heads/main';

    // GitHub's OIDC identity provider. AWS validates the thumbprint for this well-known host.
    const oidcProvider = new aws.iam.OpenIdConnectProvider('github-actions-oidc', {
        url: 'https://token.actions.githubusercontent.com',
        clientIdLists: ['sts.amazonaws.com'],
        thumbprintLists: ['6938fd4d98bab03faadb97b34396831e3780aea1'],
        tags,
    });

    // Deploy role: trusts only the configured repo + ref, exchanged for short-lived credentials.
    const deployRole = new aws.iam.Role('ci-deploy-role', {
        assumeRolePolicy: oidcProvider.arn.apply((providerArn) =>
            JSON.stringify({
                Version: '2012-10-17',
                Statement: [
                    {
                        Effect: 'Allow',
                        Principal: { Federated: providerArn },
                        Action: 'sts:AssumeRoleWithWebIdentity',
                        Condition: {
                            StringEquals: {
                                'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
                            },
                            StringLike: {
                                'token.actions.githubusercontent.com:sub': `repo:${githubRepo}:ref:${githubRef}`,
                            },
                        },
                    },
                ],
            }),
        ),
        tags,
    });

    // CI syncs docs to S3 and kicks ingestion; scope to exactly those actions. Broader infra
    // changes go through a separate, more privileged assumed role.
    new aws.iam.RolePolicy('ci-deploy-policy', {
        role: deployRole.id,
        policy: JSON.stringify({
            Version: '2012-10-17',
            Statement: [
                {
                    Sid: 'SyncDocsAndTriggerIngestion',
                    Effect: 'Allow',
                    Action: [
                        's3:PutObject',
                        's3:DeleteObject',
                        's3:ListBucket',
                        'bedrock:StartIngestionJob',
                        'bedrock:GetIngestionJob',
                    ],
                    Resource: '*',
                },
            ],
        }),
    });

    return {
        message: pulumi.output(`Account baseline (GitHub OIDC) deployed for environment: ${env}`),
        deployRoleArn: deployRole.arn,
    };
}
