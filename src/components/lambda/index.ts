/**
 * AWS Lambda Function Component - Creates a Lambda function with a least-privilege execution role,
 * an explicit CloudWatch log group with retention, and optional VPC attachment.
 * @example
 * const fn = new LambdaFunctionComponent('ingestion-trigger', {
 *   name: 'kb-ingestion-trigger',
 *   handler: 'index.handler',
 *   code: new pulumi.asset.FileArchive('./functions/ingestion-trigger'),
 *   environment: { KNOWLEDGE_BASE_ID: kbId },
 *   tags: { Environment: 'dev' },
 * });
 */

import * as pulumi from '@pulumi/pulumi';
import * as aws from '@pulumi/aws';

/**
 * Arguments for creating a Lambda function.
 */
export interface LambdaFunctionArgs {
    /** Name of the Lambda function */
    name: pulumi.Input<string>;
    /** Deployment package for the function */
    code: pulumi.Input<pulumi.asset.Archive>;
    /** Function entrypoint (default: "index.handler") */
    handler?: pulumi.Input<string>;
    /** Lambda runtime (default: "nodejs22.x") */
    runtime?: pulumi.Input<string>;
    /** Timeout in seconds (default: 30) */
    timeout?: pulumi.Input<number>;
    /** Memory in MB (default: 256) */
    memorySize?: pulumi.Input<number>;
    /** Reserved concurrency; caps blast radius and cost for a runaway function */
    reservedConcurrentExecutions?: pulumi.Input<number>;
    /** Environment variables exposed to the function */
    environment?: pulumi.Input<{ [key: string]: pulumi.Input<string> }>;
    /** Additional IAM policy ARNs to attach to the execution role */
    policyArns?: pulumi.Input<string>[];
    /** Inline least-privilege policy JSON attached to the execution role */
    inlinePolicy?: pulumi.Input<string>;
    /** VPC configuration for functions that must reach private endpoints (e.g. Aurora) */
    vpcConfig?: pulumi.Input<aws.types.input.lambda.FunctionVpcConfig>;
    /** CloudWatch log retention in days (default: 30) */
    logRetentionDays?: pulumi.Input<number>;
    /** Resource tags */
    tags?: pulumi.Input<{ [key: string]: pulumi.Input<string> }>;
}

/**
 * Lambda Function ComponentResource bundling function, execution role, and log group.
 */
export class LambdaFunctionComponent extends pulumi.ComponentResource {
    public readonly function: aws.lambda.Function;
    public readonly role: aws.iam.Role;
    public readonly logGroup: aws.cloudwatch.LogGroup;
    public readonly arn: pulumi.Output<string>;

    constructor(name: string, args: LambdaFunctionArgs, opts?: pulumi.ComponentResourceOptions) {
        super('aws:compute:LambdaFunctionComponent', name, {}, opts);

        if (!args.name) {
            throw new Error('Lambda function name is required.');
        }

        const defaultOpts = { parent: this };

        const defaultTags = { ManagedBy: 'Pulumi' };
        const mergedTags = args.tags
            ? pulumi.output(args.tags).apply((userTags) => ({ ...defaultTags, ...userTags }))
            : defaultTags;

        // --- Execution role (least privilege; policies attached explicitly) ---
        this.role = new aws.iam.Role(
            `${name}-role`,
            {
                assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal({
                    Service: 'lambda.amazonaws.com',
                }),
                tags: mergedTags,
            },
            defaultOpts,
        );

        // Baseline logging permissions; VPC functions also need ENI management.
        new aws.iam.RolePolicyAttachment(
            `${name}-basic-execution`,
            {
                role: this.role.name,
                policyArn: args.vpcConfig
                    ? 'arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole'
                    : 'arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole',
            },
            defaultOpts,
        );

        (args.policyArns ?? []).forEach((policyArn, index) => {
            new aws.iam.RolePolicyAttachment(
                `${name}-policy-${index}`,
                { role: this.role.name, policyArn },
                defaultOpts,
            );
        });

        if (args.inlinePolicy) {
            new aws.iam.RolePolicy(
                `${name}-inline`,
                { role: this.role.id, policy: args.inlinePolicy },
                defaultOpts,
            );
        }

        // --- Explicit log group so retention is managed (not the implicit never-expire one) ---
        this.logGroup = new aws.cloudwatch.LogGroup(
            `${name}-logs`,
            {
                name: pulumi.interpolate`/aws/lambda/${args.name}`,
                retentionInDays: args.logRetentionDays ?? 30,
                tags: mergedTags,
            },
            defaultOpts,
        );

        // --- Function ---
        this.function = new aws.lambda.Function(
            name,
            {
                name: args.name,
                role: this.role.arn,
                code: args.code,
                handler: args.handler ?? 'index.handler',
                runtime: args.runtime ?? 'nodejs22.x',
                timeout: args.timeout ?? 30,
                memorySize: args.memorySize ?? 256,
                reservedConcurrentExecutions: args.reservedConcurrentExecutions,
                architectures: ['arm64'],
                environment: args.environment ? { variables: args.environment } : undefined,
                vpcConfig: args.vpcConfig,
                tags: mergedTags,
            },
            { ...defaultOpts, dependsOn: [this.logGroup] },
        );

        this.arn = this.function.arn;

        this.registerOutputs({
            function: this.function,
            role: this.role,
            logGroup: this.logGroup,
            arn: this.arn,
        });
    }
}

export default LambdaFunctionComponent;
