/**
 * Service Platform Stack - Deploys the RAG engine and its ingestion pipeline.
 *
 * Provisions the Bedrock Knowledge Base (Aurora pgvector storage), its Guardrail, and the
 * ingestion trigger: an `S3 event → Lambda → StartIngestionJob` wire. That trigger is the fix for
 * the "a put does not auto-reindex" footgun — without it the index silently serves stale content.
 * Depends on the network foundation + stateful data stacks (their outputs are supplied as config)
 * and is required by the workload layer.
 *
 * @param env - The deployment environment (dev, val, prd)
 * @returns Pulumi outputs for the service platform stack
 */
import * as pulumi from '@pulumi/pulumi';
import * as aws from '@pulumi/aws';
import { KnowledgeBaseComponent } from '../components/bedrock';
import { LambdaFunctionComponent } from '../components/lambda';
import { DEFAULT_EMBEDDING_MODEL, parseStackName, standardTags } from './shared';

export interface StackOutputs {
    /** Informational message about the stack deployment. */
    message: pulumi.Output<string>;
    /** ID of the provisioned knowledge base, if created. */
    knowledgeBaseId?: pulumi.Output<string>;
    /** ID of the companion guardrail, if created. */
    guardrailId?: pulumi.Output<string>;
}

/**
 * Creates the service platform stack for the specified region/environment.
 *
 * @param env - The deployment stack name (`<region>-<env>`)
 * @returns Pulumi outputs for the service platform stack
 */
export async function createStack(env: string): Promise<StackOutputs> {
    pulumi.log.info(`[svc-platform] Deploying service platform stack for environment: ${env}`);

    const identity = parseStackName(env);
    const tags = standardTags('svc-platform', identity);
    const config = new pulumi.Config();
    const region = identity.region ?? aws.config.region ?? 'us-east-1';

    // Cross-layer inputs are published by stateful-data into this stack's config. Until they are
    // present this layer no-ops (mirrors how later layers wait on earlier layers' outputs).
    const rawBucketArn = config.get('rawBucketArn');
    const rawBucketName = config.get('rawBucketName');
    const vectorClusterArn = config.get('vectorClusterArn');
    const vectorSecretArn = config.get('vectorSecretArn');
    if (!rawBucketArn || !rawBucketName || !vectorClusterArn || !vectorSecretArn) {
        pulumi.log.warn(
            '[svc-platform] Waiting on stateful-data outputs (rawBucketArn, vectorClusterArn, ...). Skipping.',
        );
        return {
            message: pulumi.output(`Service platform waiting on upstream outputs for: ${env}`),
        };
    }

    const databaseName = config.get('databaseName') ?? 'kb';
    const embeddingModelArn = `arn:aws:bedrock:${region}::foundation-model/${DEFAULT_EMBEDDING_MODEL}`;

    // --- Bedrock Knowledge Base + data source + guardrail ---
    const kb = new KnowledgeBaseComponent('docs-kb', {
        name: pulumi.interpolate`docs-kb-${identity.env}`,
        sourceBucketArn: rawBucketArn,
        embeddingModelArn,
        auroraClusterArn: vectorClusterArn,
        auroraSecretArn: vectorSecretArn,
        databaseName,
        tags,
    });

    // --- Ingestion trigger: S3 change → StartIngestionJob (a put does not auto-reindex) ---
    const ingestionFn = new LambdaFunctionComponent('kb-ingestion-trigger', {
        name: pulumi.interpolate`kb-ingestion-trigger-${identity.env}`,
        code: new pulumi.asset.FileArchive('./functions/ingestion-trigger'),
        handler: 'index.handler',
        timeout: 60,
        environment: {
            KNOWLEDGE_BASE_ID: kb.knowledgeBaseId,
            DATA_SOURCE_ID: kb.dataSource.dataSourceId,
        },
        inlinePolicy: pulumi.all([kb.knowledgeBase.arn]).apply(([kbArn]) =>
            JSON.stringify({
                Version: '2012-10-17',
                Statement: [
                    {
                        Sid: 'StartIngestion',
                        Effect: 'Allow',
                        Action: ['bedrock:StartIngestionJob', 'bedrock:GetIngestionJob'],
                        Resource: [kbArn],
                    },
                ],
            }),
        ),
        tags,
    });

    // Permit S3 to invoke the trigger, then wire the bucket notification.
    const s3Permission = new aws.lambda.Permission('kb-ingestion-s3-permission', {
        action: 'lambda:InvokeFunction',
        function: ingestionFn.function.name,
        principal: 's3.amazonaws.com',
        sourceArn: rawBucketArn,
    });

    new aws.s3.BucketNotification(
        'kb-ingestion-notification',
        {
            bucket: rawBucketName,
            lambdaFunctions: [
                {
                    lambdaFunctionArn: ingestionFn.arn,
                    events: ['s3:ObjectCreated:*', 's3:ObjectRemoved:*'],
                },
            ],
        },
        { dependsOn: [s3Permission] },
    );

    return {
        message: pulumi.output(`Service platform (Bedrock KB + ingestion) deployed for: ${env}`),
        knowledgeBaseId: kb.knowledgeBaseId,
        guardrailId: kb.guardrailId,
    };
}
