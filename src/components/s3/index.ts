/**
 * AWS S3 Bucket Component - Creates and manages an S3 bucket with best practices.
 * @example
 * const bucket = new S3BucketComponent("my-bucket", {
 *   name: "my-app-bucket",
 *   tags: { Environment: "dev" }
 * });
 */

import * as pulumi from '@pulumi/pulumi';
import * as aws from '@pulumi/aws';

/**
 * Arguments for creating an S3 bucket.
 */
export interface S3BucketArgs {
    /** Name of the S3 bucket */
    name: pulumi.Input<string>;
    /** Canned ACL to apply (default: "private") */
    acl?: pulumi.Input<string>;
    /** Lifecycle rules for objects in the bucket */
    lifecycleRules?: pulumi.Input<aws.types.input.s3.BucketLifecycleRule[]>;
    /** Intelligent tiering configuration */
    intelligentTiering?: pulumi.Input<aws.types.input.s3.BucketIntelligentTieringConfigurationTiering>[];
    /** Enable versioning (default: false) */
    versioning?: pulumi.Input<boolean>;
    /** KMS Key ID for encryption (optional) */
    kmsKeyId?: pulumi.Input<string>;
    /** CORS rules */
    cors?: pulumi.Input<aws.types.input.s3.BucketCorsConfigurationV2CorsRule[]>;
    /** Resource tags */
    tags?: pulumi.Input<{ [key: string]: pulumi.Input<string> }>;
}

/**
 * S3 Bucket ComponentResource for managing AWS S3 buckets.
 */
export class S3BucketComponent extends pulumi.ComponentResource {
    public readonly bucket: aws.s3.Bucket;
    public readonly bucketPolicy?: aws.s3.BucketPolicy;
    public readonly arn: pulumi.Output<string>;

    constructor(name: string, args: S3BucketArgs, opts?: pulumi.ComponentResourceOptions) {
        super('aws:storage:S3BucketComponent', name, {}, opts);

        if (!args.name) {
            throw new Error('S3 bucket name is required.');
        }

        const defaultOpts = { parent: this };

        // Versioning configuration
        const versioningConfig = { enabled: args.versioning ?? false };

        // Merge tags with standard tags for cost tracking
        const defaultTags = { ManagedBy: 'Pulumi' };
        const mergedTags = args.tags
            ? pulumi.output(args.tags).apply((userTags) => ({ ...defaultTags, ...userTags }))
            : defaultTags;

        // Server-side encryption configuration
        const serverSideEncryptionConfiguration = args.kmsKeyId
            ? {
                  rule: {
                      applyServerSideEncryptionByDefault: {
                          sseAlgorithm: 'aws:kms',
                          kmsMasterKeyId: args.kmsKeyId,
                      },
                  },
              }
            : {
                  rule: {
                      applyServerSideEncryptionByDefault: {
                          sseAlgorithm: 'AES256',
                      },
                  },
              };

        this.bucket = new aws.s3.Bucket(
            name,
            {
                bucket: args.name,
                acl: args.acl ?? 'private',
                lifecycleRules: args.lifecycleRules,
                versioning: versioningConfig,
                serverSideEncryptionConfiguration,
                corsRules: args.cors,
                tags: mergedTags,
            },
            defaultOpts,
        );

        this.arn = this.bucket.arn;

        new aws.s3.BucketOwnershipControls(
            `${name}-ownership-controls`,
            { bucket: this.bucket.id, rule: { objectOwnership: 'BucketOwnerEnforced' } },
            defaultOpts,
        );

        if (args.cors) {
            new aws.s3.BucketCorsConfigurationV2(
                `${name}-cors`,
                { bucket: this.bucket.id, corsRules: args.cors },
                defaultOpts,
            );
        }

        if (args.intelligentTiering) {
            new aws.s3.BucketIntelligentTieringConfiguration(
                `${name}-intelligent-tiering`,
                { bucket: this.bucket.id, tierings: args.intelligentTiering },
                defaultOpts,
            );
        }

        this.registerOutputs({
            bucket: this.bucket,
            bucketPolicy: this.bucketPolicy,
            arn: this.arn,
        });
    }
}

export default S3BucketComponent;
