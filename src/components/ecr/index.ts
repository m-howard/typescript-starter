/**
 * AWS ECR Component - Creates and manages an Elastic Container Registry repository.
 * @example
 * const ecr = new EcrComponent("my-app-ecr", {
 *   name: "my-app-repo",
 *   tags: { Environment: "dev" }
 * });
 */

import * as pulumi from '@pulumi/pulumi';
import * as aws from '@pulumi/aws';

/**
 * Arguments for creating an ECR repository.
 */
export interface EcrArgs {
    /** Name of the ECR repository */
    name: pulumi.Input<string>;
    /** Image tag mutability setting (default: "MUTABLE") */
    imageTagMutability?: pulumi.Input<'MUTABLE' | 'IMMUTABLE'>;
    /** KMS Key ID for encryption (optional) */
    encryptionKeyId?: pulumi.Input<string>;
    /** Repository policy JSON (optional) */
    policy?: pulumi.Input<string>;
    /** Resource tags */
    tags?: pulumi.Input<{ [key: string]: pulumi.Input<string> }>;
}

/**
 * ECR ComponentResource for managing AWS ECR repositories.
 */
export class EcrComponent extends pulumi.ComponentResource {
    public readonly repository: aws.ecr.Repository;
    public readonly repositoryPolicy?: aws.ecr.RepositoryPolicy;
    public readonly arn: pulumi.Output<string>;

    constructor(name: string, args: EcrArgs, opts?: pulumi.ComponentResourceOptions) {
        super('aws:container:EcrComponent', name, {}, opts);

        // Validate required input
        if (!args.name) {
            throw new Error('ECR repository name is required.');
        }

        const defaultOpts = { parent: this };

        // Determine encryption configuration
        const encryptionConfig = args.encryptionKeyId
            ? [{ encryptionType: 'KMS', kmsKey: args.encryptionKeyId }]
            : [{ encryptionType: 'AES256' }];

        // Merge tags with standard tags for cost tracking
        const defaultTags = { ManagedBy: 'Pulumi' };
        const mergedTags = args.tags
            ? pulumi.output(args.tags).apply((userTags) => ({ ...defaultTags, ...userTags }))
            : defaultTags;

        this.repository = new aws.ecr.Repository(
            name,
            {
                name: args.name,
                imageTagMutability: args.imageTagMutability ?? 'MUTABLE',
                encryptionConfigurations: encryptionConfig,
                tags: mergedTags,
            },
            defaultOpts,
        );

        if (args.policy) {
            this.repositoryPolicy = new aws.ecr.RepositoryPolicy(
                `${name}-policy`,
                {
                    repository: this.repository.name,
                    policy: args.policy,
                },
                defaultOpts,
            );
        }

        this.arn = this.repository.arn;

        this.registerOutputs({
            repository: this.repository,
            repositoryPolicy: this.repositoryPolicy,
            arn: this.arn,
        });
    }
}

export default EcrComponent;
