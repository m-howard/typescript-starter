/**
 * Ingestion trigger - S3 event → Bedrock StartIngestionJob.
 *
 * An S3 put does NOT auto-reindex a Bedrock Knowledge Base. This handler closes that operational
 * gap: on any change under the raw docs bucket it starts an ingestion job for the data source so
 * the vector index tracks the docs. Bedrock coalesces concurrent jobs, so bursty CI syncs collapse
 * into a single reconciliation pass that also honours deletions (the data source uses DELETE).
 *
 * Env: KNOWLEDGE_BASE_ID, DATA_SOURCE_ID
 */
import { BedrockAgentClient, StartIngestionJobCommand } from '@aws-sdk/client-bedrock-agent';

const client = new BedrockAgentClient({});

export const handler = async (event) => {
    const knowledgeBaseId = process.env.KNOWLEDGE_BASE_ID;
    const dataSourceId = process.env.DATA_SOURCE_ID;
    if (!knowledgeBaseId || !dataSourceId) {
        throw new Error('KNOWLEDGE_BASE_ID and DATA_SOURCE_ID must be set.');
    }

    const changed = (event.Records ?? []).length;
    console.log(`Starting ingestion for ${changed} changed object(s).`);

    const result = await client.send(
        new StartIngestionJobCommand({
            knowledgeBaseId,
            dataSourceId,
            description: `Triggered by S3 change event (${changed} object(s)).`,
        }),
    );

    const jobId = result.ingestionJob?.ingestionJobId;
    console.log(`Ingestion job started: ${jobId}`);
    return { ingestionJobId: jobId };
};
