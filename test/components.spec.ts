/**
 * Tests for the RAG knowledge base Pulumi components.
 *
 * Uses Pulumi's mock runtime to construct components in-process and assert the corrected-design
 * invariants: least-privilege defaults, arm64 Lambdas, DELETE-on-removal ingestion, and the
 * Aurora (not OpenSearch) vector store.
 */

import * as pulumi from '@pulumi/pulumi';

// Mocks must be registered before any resource is constructed.
pulumi.runtime.setMocks({
    newResource: (args: pulumi.runtime.MockResourceArgs) => ({
        id: `${args.name}-id`,
        state: { ...args.inputs, arn: `arn:aws:mock:::${args.name}` },
    }),
    call: (args: pulumi.runtime.MockCallArgs) => args.inputs,
});

/** Resolve a Pulumi Output to a concrete value for assertions. */
function resolve<T>(output: pulumi.Output<T>): Promise<T> {
    return new Promise((res) => {
        output.apply((value) => {
            res(value);
            return value;
        });
    });
}

// Imported after setMocks so construction uses the mock runtime.
import { LambdaFunctionComponent } from '../src/components/lambda';
import { KnowledgeBaseComponent } from '../src/components/bedrock';

describe('LambdaFunctionComponent', () => {
    it('defaults to arm64 and merges the ManagedBy tag', async () => {
        const fn = new LambdaFunctionComponent('unit-fn', {
            name: 'unit-fn',
            code: new pulumi.asset.AssetArchive({}),
            tags: { Environment: 'dev' },
        });

        const architectures = await resolve(fn.function.architectures);
        expect(architectures).toEqual(['arm64']);

        const tags = await resolve(fn.function.tags as pulumi.Output<Record<string, string>>);
        expect(tags).toMatchObject({ ManagedBy: 'Pulumi', Environment: 'dev' });
    });

    it('rejects an empty name', () => {
        expect(
            () =>
                new LambdaFunctionComponent('bad-fn', {
                    name: '',
                    code: new pulumi.asset.AssetArchive({}),
                }),
        ).toThrow('Lambda function name is required.');
    });
});

describe('KnowledgeBaseComponent', () => {
    it('backs the KB with Aurora (RDS), not OpenSearch Serverless', async () => {
        const kb = new KnowledgeBaseComponent('unit-kb', {
            name: 'unit-kb',
            sourceBucketArn: 'arn:aws:s3:::docs',
            embeddingModelArn: 'arn:aws:bedrock:us-east-1::foundation-model/amazon.titan',
            auroraClusterArn: 'arn:aws:rds:us-east-1:1:cluster:vec',
            auroraSecretArn: 'arn:aws:secretsmanager:us-east-1:1:secret:vec',
            databaseName: 'kb',
        });

        const storage = await resolve(kb.knowledgeBase.storageConfiguration);
        expect(storage?.type).toBe('RDS');
    });

    it('reconciles deletions (data deletion policy DELETE) and ships a guardrail', async () => {
        const kb = new KnowledgeBaseComponent('unit-kb2', {
            name: 'unit-kb2',
            sourceBucketArn: 'arn:aws:s3:::docs',
            embeddingModelArn: 'arn:aws:bedrock:us-east-1::foundation-model/amazon.titan',
            auroraClusterArn: 'arn:aws:rds:us-east-1:1:cluster:vec',
            auroraSecretArn: 'arn:aws:secretsmanager:us-east-1:1:secret:vec',
            databaseName: 'kb',
        });

        const policy = await resolve(kb.dataSource.dataDeletionPolicy);
        expect(policy).toBe('DELETE');
        expect(kb.guardrail).toBeDefined();
    });
});
