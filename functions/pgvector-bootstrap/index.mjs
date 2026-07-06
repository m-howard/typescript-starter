/**
 * pgvector bootstrap - Provisions the vector schema Bedrock expects, via the RDS Data API.
 *
 * `CreateKnowledgeBase` with an RDS store validates that the extension, table, and columns already
 * exist and hard-fails otherwise. This handler runs the one-time DDL (idempotently) so the table
 * is in place before the knowledge base is created. It talks to Aurora through the Data API — an
 * HTTPS control-plane call — so it needs no VPC attachment.
 *
 * Env: CLUSTER_ARN, SECRET_ARN, DATABASE_NAME, TABLE_NAME, VECTOR_DIMENSIONS
 */
import { RDSDataClient, ExecuteStatementCommand } from '@aws-sdk/client-rds-data';

const client = new RDSDataClient({});

export const handler = async () => {
    const resourceArn = process.env.CLUSTER_ARN;
    const secretArn = process.env.SECRET_ARN;
    const database = process.env.DATABASE_NAME ?? 'kb';
    const table = process.env.TABLE_NAME ?? 'bedrock_kb';
    const dimensions = Number(process.env.VECTOR_DIMENSIONS ?? '1024');

    const statements = [
        'CREATE EXTENSION IF NOT EXISTS vector;',
        `CREATE TABLE IF NOT EXISTS ${table} (
            id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            embedding vector(${dimensions}),
            chunks text,
            metadata jsonb
        );`,
        `CREATE INDEX IF NOT EXISTS ${table}_embedding_idx
            ON ${table} USING hnsw (embedding vector_cosine_ops);`,
    ];

    for (const sql of statements) {
        await client.send(new ExecuteStatementCommand({ resourceArn, secretArn, database, sql }));
    }

    console.log(`pgvector schema ready: ${database}.${table} (${dimensions} dims).`);
    return { status: 'ok', table, dimensions };
};
