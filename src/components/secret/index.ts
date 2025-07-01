/**
 * AWS Managed Secret Component - Manages AWS Secrets Manager secrets with automated and manual values.
 * @example
 * const secret = new ManagedSecret('my-secret', {
 *   secretId: 'my-app/secret',
 *   automatedValues: { password: 'auto-generated' },
 *   manualValues: { username: 'admin' },
 * });
 */

import * as pulumi from '@pulumi/pulumi';
import * as aws from '@pulumi/aws';
import * as SecretManager from '@aws-sdk/client-secrets-manager';

/**
 * Arguments for ManagedSecret.
 */
export interface ManagedSecretArgs {
    /** The name of the secret */
    secretId: string;
    /** Optional description for the secret */
    description?: string;
    /** Optional KMS Key ID for encryption */
    kmsKeyId?: string;
    /** Automated values to be stored in the secret */
    automatedValues: Record<string, unknown>;
    /** Manual values to be merged into the secret */
    manualValues?: Record<string, unknown>;
}

/**
 * Inputs for the dynamic provider.
 */
type ManagedSecretInputs = ManagedSecretArgs;

/**
 * Outputs for the dynamic provider.
 */
interface ManagedSecretOutputs extends ManagedSecretInputs {
    arn: string;
    secretValues: Record<string, unknown>;
}

/**
 * Custom error for infrastructure failures.
 */
class InfrastructureError extends Error {
    constructor(resource: string, operation: string, cause?: Error) {
        super(`Failed to ${operation} ${resource}: ${cause?.message || 'Unknown error'}`);
        this.name = 'InfrastructureError';
    }
}

/**
 * Dynamic provider for managing AWS Secrets Manager secrets.
 */
class ManagedSecretProvider implements pulumi.dynamic.ResourceProvider {
    private getSecretsManagerClient(region?: string) {
        return new SecretManager.SecretsManager({
            region: region || aws.config.region || 'us-east-1',
        });
    }

    async check(
        _olds: ManagedSecretInputs,
        news: ManagedSecretInputs,
    ): Promise<pulumi.dynamic.CheckResult> {
        const failures: pulumi.dynamic.CheckFailure[] = [];
        if (!news.secretId || typeof news.secretId !== 'string') {
            failures.push({
                property: 'secretId',
                reason: 'secretId is required and must be a non-empty string.',
            });
        }

        if (news.automatedValues && typeof news.automatedValues !== 'object') {
            failures.push({
                property: 'automatedValues',
                reason: 'automatedValues must be a non-null object.',
            });
        }
        return { inputs: news, failures };
    }

    async create(inputs: ManagedSecretInputs): Promise<pulumi.dynamic.CreateResult> {
        const sm = this.getSecretsManagerClient();
        const { secretId, description, kmsKeyId, automatedValues, manualValues } = inputs;
        const secretValues = { ...automatedValues, ...(manualValues ?? {}) };

        try {
            // Create the secret in AWS Secrets Manager
            const result = await sm.createSecret({
                Name: secretId,
                Description: description,
                KmsKeyId: kmsKeyId,
                SecretString: JSON.stringify(secretValues, null, 4),
            });

            return {
                id: result.ARN ?? '',
                outs: {
                    ...inputs,
                    arn: result.ARN ?? '',
                    secretValues,
                },
            };
        } catch (error) {
            throw new InfrastructureError('Secret', 'create', error as Error);
        }
    }

    async diff(
        _id: string,
        olds: ManagedSecretOutputs,
        news: ManagedSecretInputs,
    ): Promise<pulumi.dynamic.DiffResult> {
        // Only automatedValues changes trigger replacement
        const changes =
            JSON.stringify(olds.automatedValues) !== JSON.stringify(news.automatedValues);
        const replaces = changes ? ['automatedValues'] : [];
        return {
            changes,
            replaces,
            stables: ['arn', 'secretId'],
        };
    }

    async update(
        id: string,
        olds: ManagedSecretOutputs,
        news: ManagedSecretInputs,
    ): Promise<pulumi.dynamic.UpdateResult> {
        const sm = this.getSecretsManagerClient();
        const updatedValues = { ...olds.secretValues, ...news.automatedValues };

        try {
            await sm.updateSecret({
                SecretId: id,
                SecretString: JSON.stringify(updatedValues, null, 4),
                Description: news.description,
                KmsKeyId: news.kmsKeyId,
            });

            return {
                outs: {
                    ...news,
                    arn: olds.arn,
                    secretValues: updatedValues,
                },
            };
        } catch (error) {
            throw new InfrastructureError('Secret', 'update', error as Error);
        }
    }

    async delete(id: string): Promise<void> {
        const sm = this.getSecretsManagerClient();
        try {
            await sm.deleteSecret({
                SecretId: id,
                ForceDeleteWithoutRecovery: true,
            });
        } catch (error) {
            throw new InfrastructureError('Secret', 'delete', error as Error);
        }
    }

    async read(id: string, props: ManagedSecretOutputs): Promise<pulumi.dynamic.ReadResult> {
        const sm = this.getSecretsManagerClient();
        try {
            const result = await sm.describeSecret({ SecretId: id });
            const secretValue = await sm.getSecretValue({ SecretId: id });
            const currentValues = JSON.parse(secretValue.SecretString ?? '{}');
            return {
                id: result.ARN,
                props: {
                    ...props,
                    arn: result.ARN ?? '',
                    secretValues: currentValues,
                },
            };
        } catch (error) {
            throw new InfrastructureError('Secret', 'read', error as Error);
        }
    }
}

/**
 * Pulumi resource for managing AWS Secrets Manager secrets.
 *
 * Note: To access the secret values output, use Pulumi's standard output mechanisms (e.g., resourceInstance.getOutput('secretValues')).
 */
export class ManagedSecret extends pulumi.dynamic.Resource {
    /** The ARN of the secret */
    public readonly arn: pulumi.Output<string>;
    // The secretValues output is available via Pulumi's output mechanisms.

    constructor(name: string, args: ManagedSecretArgs, opts?: pulumi.CustomResourceOptions) {
        super(new ManagedSecretProvider(), `custom:aws:ManagedSecret:${name}`, args, opts);
        this.arn = pulumi.output(this.id);
    }

    /**
     * Grants full access to the specified secrets for a given IAM role.
     * @param policyName Name of the IAM policy
     * @param roleArn ARN of the IAM role
     * @param secrets List of secret ARNs
     */
    static grantFullAccessToSecrets(
        policyName: string,
        roleArn: string,
        secrets: pulumi.Input<string[]>,
    ) {
        const policy = new aws.iam.Policy(policyName, {
            description: 'Grant full access to specific secrets',
            policy: JSON.stringify({
                Version: '2012-10-17',
                Statement: [
                    {
                        Effect: 'Allow',
                        Action: [
                            'secretsmanager:GetSecretValue',
                            'secretsmanager:DescribeSecret',
                            'secretsmanager:ListSecrets',
                            'secretsmanager:PutSecretValue',
                            'secretsmanager:DeleteSecret',
                        ],
                        Resource: secrets,
                    },
                ],
            }),
        });

        new aws.iam.RolePolicyAttachment(`${policyName}-attachment`, {
            role: roleArn,
            policyArn: policy.arn,
        });
    }
}
