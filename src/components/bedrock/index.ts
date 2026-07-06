/**
 * AWS Bedrock Knowledge Base Component - Provisions a RAG knowledge base with an S3 data source,
 * an Aurora PostgreSQL + pgvector vector store, and a companion Guardrail.
 *
 * Two deliberate choices from the corrected architecture are baked in:
 *  - **Aurora pgvector** as the vector store (the "hard isolation" option) rather than
 *    OpenSearch Serverless, whose always-on OCU floor dominates cost for a docs corpus.
 *  - A **data source that carries filterable metadata**, so the `visibility_groups` /
 *    `classification_level` sidecars survive ingestion and can be filtered at retrieval.
 *
 * @example
 * const kb = new KnowledgeBaseComponent('docs-kb', {
 *   name: 'docs-kb',
 *   sourceBucketArn: rawBucket.arn,
 *   embeddingModelArn: 'arn:aws:bedrock:us-east-1::foundation-model/amazon.titan-embed-text-v2:0',
 *   auroraClusterArn: cluster.arn,
 *   auroraSecretArn: secret.arn,
 *   databaseName: 'kb',
 *   tags: { Environment: 'dev' },
 * });
 */

import * as pulumi from '@pulumi/pulumi';
import * as aws from '@pulumi/aws';

/**
 * Arguments for creating a Bedrock Knowledge Base backed by Aurora pgvector.
 */
export interface KnowledgeBaseArgs {
    /** Name of the knowledge base */
    name: pulumi.Input<string>;
    /** ARN of the S3 bucket holding markdown docs and their `.metadata.json` sidecars */
    sourceBucketArn: pulumi.Input<string>;
    /** ARN of the embedding model used to vectorise chunks */
    embeddingModelArn: pulumi.Input<string>;
    /** ARN of the Aurora PostgreSQL cluster that stores vectors */
    auroraClusterArn: pulumi.Input<string>;
    /** ARN of the Secrets Manager secret holding Aurora credentials */
    auroraSecretArn: pulumi.Input<string>;
    /** Name of the Aurora database */
    databaseName: pulumi.Input<string>;
    /** Vector table name (default: "bedrock_kb") */
    tableName?: pulumi.Input<string>;
    /** S3 prefixes to include; omit to ingest the whole bucket */
    inclusionPrefixes?: pulumi.Input<string>[];
    /** Fixed chunk token size (default: 500) */
    chunkTokenSize?: number;
    /** Chunk overlap percentage (default: 20) */
    chunkOverlapPercentage?: number;
    /** Resource tags */
    tags?: pulumi.Input<{ [key: string]: pulumi.Input<string> }>;
}

/**
 * Bedrock Knowledge Base ComponentResource: KB, S3 data source, service role, and Guardrail.
 */
export class KnowledgeBaseComponent extends pulumi.ComponentResource {
    public readonly knowledgeBase: aws.bedrock.AgentKnowledgeBase;
    public readonly dataSource: aws.bedrock.AgentDataSource;
    public readonly role: aws.iam.Role;
    public readonly guardrail: aws.bedrock.Guardrail;
    public readonly knowledgeBaseId: pulumi.Output<string>;
    public readonly guardrailId: pulumi.Output<string>;

    constructor(name: string, args: KnowledgeBaseArgs, opts?: pulumi.ComponentResourceOptions) {
        super('aws:ai:KnowledgeBaseComponent', name, {}, opts);

        if (!args.name) {
            throw new Error('Knowledge base name is required.');
        }

        const defaultOpts = { parent: this };

        const defaultTags = { ManagedBy: 'Pulumi' };
        const mergedTags = args.tags
            ? pulumi.output(args.tags).apply((userTags) => ({ ...defaultTags, ...userTags }))
            : defaultTags;

        // --- Service role: least privilege to embed, read docs, and reach the vector store ---
        this.role = new aws.iam.Role(
            `${name}-role`,
            {
                assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal({
                    Service: 'bedrock.amazonaws.com',
                }),
                tags: mergedTags,
            },
            defaultOpts,
        );

        new aws.iam.RolePolicy(
            `${name}-policy`,
            {
                role: this.role.id,
                policy: pulumi
                    .all([
                        args.embeddingModelArn,
                        args.sourceBucketArn,
                        args.auroraClusterArn,
                        args.auroraSecretArn,
                    ])
                    .apply(([modelArn, bucketArn, clusterArn, secretArn]) =>
                        JSON.stringify({
                            Version: '2012-10-17',
                            Statement: [
                                {
                                    Sid: 'InvokeEmbeddingModel',
                                    Effect: 'Allow',
                                    Action: ['bedrock:InvokeModel'],
                                    Resource: [modelArn],
                                },
                                {
                                    Sid: 'ReadSourceDocs',
                                    Effect: 'Allow',
                                    Action: ['s3:GetObject', 's3:ListBucket'],
                                    Resource: [bucketArn, `${bucketArn}/*`],
                                },
                                {
                                    Sid: 'AuroraDataApi',
                                    Effect: 'Allow',
                                    Action: [
                                        'rds-data:ExecuteStatement',
                                        'rds-data:BatchExecuteStatement',
                                    ],
                                    Resource: [clusterArn],
                                },
                                {
                                    Sid: 'ReadVectorStoreSecret',
                                    Effect: 'Allow',
                                    Action: ['secretsmanager:GetSecretValue'],
                                    Resource: [secretArn],
                                },
                            ],
                        }),
                    ),
            },
            defaultOpts,
        );

        // --- Knowledge base backed by Aurora pgvector (hard tenant isolation via DB) ---
        this.knowledgeBase = new aws.bedrock.AgentKnowledgeBase(
            name,
            {
                name: args.name,
                roleArn: this.role.arn,
                knowledgeBaseConfiguration: {
                    type: 'VECTOR',
                    vectorKnowledgeBaseConfiguration: {
                        embeddingModelArn: args.embeddingModelArn,
                    },
                },
                storageConfiguration: {
                    type: 'RDS',
                    rdsConfiguration: {
                        resourceArn: args.auroraClusterArn,
                        credentialsSecretArn: args.auroraSecretArn,
                        databaseName: args.databaseName,
                        tableName: args.tableName ?? 'bedrock_kb',
                        fieldMapping: {
                            primaryKeyField: 'id',
                            textField: 'chunks',
                            vectorField: 'embedding',
                            metadataField: 'metadata',
                        },
                    },
                },
                tags: mergedTags,
            },
            defaultOpts,
        );
        this.knowledgeBaseId = this.knowledgeBase.id;

        // --- S3 data source: keep metadata, and delete vectors when docs are removed ---
        this.dataSource = new aws.bedrock.AgentDataSource(
            `${name}-source`,
            {
                name: pulumi.interpolate`${args.name}-s3`,
                knowledgeBaseId: this.knowledgeBase.id,
                // Reconcile deletions: dropping a doc from S3 must drop its vectors too.
                dataDeletionPolicy: 'DELETE',
                dataSourceConfiguration: {
                    type: 'S3',
                    s3Configuration: {
                        bucketArn: args.sourceBucketArn,
                        inclusionPrefixes: args.inclusionPrefixes,
                    },
                },
                vectorIngestionConfiguration: {
                    chunkingConfiguration: {
                        chunkingStrategy: 'FIXED_SIZE',
                        fixedSizeChunkingConfiguration: {
                            maxTokens: args.chunkTokenSize ?? 500,
                            overlapPercentage: args.chunkOverlapPercentage ?? 20,
                        },
                    },
                },
            },
            defaultOpts,
        );

        // --- Guardrail: PII redaction, grounding/relevance checks, safe refusals ---
        this.guardrail = new aws.bedrock.Guardrail(
            `${name}-guardrail`,
            {
                name: pulumi.interpolate`${args.name}-guardrail`,
                blockedInputMessaging:
                    'This request was blocked by the knowledge base safety guardrail.',
                blockedOutputsMessaging:
                    'The response was withheld because it could not be grounded in authorized sources.',
                contentPolicyConfig: {
                    filtersConfigs: [
                        { type: 'PROMPT_ATTACK', inputStrength: 'HIGH', outputStrength: 'NONE' },
                        { type: 'HATE', inputStrength: 'HIGH', outputStrength: 'HIGH' },
                        { type: 'INSULTS', inputStrength: 'MEDIUM', outputStrength: 'MEDIUM' },
                    ],
                },
                // Enforce grounding + relevance so the model refuses rather than fabricates.
                contextualGroundingPolicyConfig: {
                    filtersConfigs: [
                        { type: 'GROUNDING', threshold: 0.75 },
                        { type: 'RELEVANCE', threshold: 0.75 },
                    ],
                },
                sensitiveInformationPolicyConfig: {
                    piiEntitiesConfigs: [
                        { type: 'EMAIL', action: 'ANONYMIZE' },
                        { type: 'PHONE', action: 'ANONYMIZE' },
                        { type: 'CREDIT_DEBIT_CARD_NUMBER', action: 'BLOCK' },
                    ],
                },
                tags: mergedTags,
            },
            defaultOpts,
        );
        this.guardrailId = this.guardrail.guardrailId;

        this.registerOutputs({
            knowledgeBase: this.knowledgeBase,
            dataSource: this.dataSource,
            role: this.role,
            guardrail: this.guardrail,
            knowledgeBaseId: this.knowledgeBaseId,
            guardrailId: this.guardrailId,
        });
    }
}

export default KnowledgeBaseComponent;
