/**
 * Stateful Data Stack - Manages regional data storage and persistence services.
 *
 * Provisions the two stores at the heart of the RAG engine:
 *  - The **raw docs S3 bucket** (versioned + TLS-only), the sync target for the docs repos. The
 *    CI step uses `aws s3 sync --delete` against it so deletions are reconciled, not just adds.
 *  - The **Aurora PostgreSQL Serverless v2 + pgvector** vector store with the Data API enabled,
 *    scaling to zero when idle. This is the "hard tenant isolation" option (row-level security in
 *    the database) preferred when any docs are access-restricted — and it avoids the OpenSearch
 *    Serverless always-on OCU floor that dominated the original cost model.
 *
 * Depends on the network foundation stack and provides outputs to the platform + workload layers.
 *
 * @param env - The deployment environment (dev, val, prd)
 * @returns Pulumi outputs for the stateful data stack
 */
import * as pulumi from '@pulumi/pulumi';
import * as aws from '@pulumi/aws';
import * as random from '@pulumi/random';
import { S3BucketComponent } from '../components/s3';
import { LambdaFunctionComponent } from '../components/lambda';
import { parseStackName, standardTags } from './shared';

export interface StackOutputs {
    /** Informational message about the stack deployment. */
    message: pulumi.Output<string>;
    /** ARN of the raw docs bucket that feeds ingestion. */
    rawBucketArn: pulumi.Output<string>;
    /** Name of the raw docs bucket (the `aws s3 sync --delete` target). */
    rawBucketName: pulumi.Output<string>;
    /** ARN of the Aurora cluster backing the vector store. */
    vectorClusterArn: pulumi.Output<string>;
    /** ARN of the Secrets Manager secret holding Aurora credentials. */
    vectorSecretArn: pulumi.Output<string>;
    /** Aurora database name used by the knowledge base. */
    databaseName: string;
}

/**
 * Creates the stateful data stack for the specified region/environment.
 *
 * @param env - The deployment stack name (`<region>-<env>`)
 * @returns Pulumi outputs for the stateful data stack
 */
export async function createStack(env: string): Promise<StackOutputs> {
    pulumi.log.info(`[stateful-data] Deploying stateful data stack for environment: ${env}`);

    const identity = parseStackName(env);
    const tags = standardTags('stateful-data', identity);
    const config = new pulumi.Config();
    const databaseName = config.get('databaseName') ?? 'kb';

    // --- Raw docs bucket: versioned so deletions/rollbacks are auditable and reconcilable ---
    const rawBucket = new S3BucketComponent('kb-raw-docs', {
        name: pulumi.interpolate`kb-raw-docs-${identity.env}-${identity.region ?? 'global'}`,
        versioning: true,
        tags,
    });

    // Enforce TLS-only access to the docs at rest.
    new aws.s3.BucketPolicy('kb-raw-docs-tls', {
        bucket: rawBucket.bucket.id,
        policy: rawBucket.arn.apply((arn) =>
            JSON.stringify({
                Version: '2012-10-17',
                Statement: [
                    {
                        Sid: 'DenyInsecureTransport',
                        Effect: 'Deny',
                        Principal: '*',
                        Action: 's3:*',
                        Resource: [arn, `${arn}/*`],
                        Condition: { Bool: { 'aws:SecureTransport': 'false' } },
                    },
                ],
            }),
        ),
    });

    // --- Aurora credentials in Secrets Manager (Bedrock reads this to reach the vector store) ---
    const masterPassword = new random.RandomPassword('kb-vector-db-password', {
        length: 32,
        special: false,
    });

    const dbSecret = new aws.secretsmanager.Secret('kb-vector-db-secret', {
        name: pulumi.interpolate`kb/vector-db/${identity.env}`,
        description: 'Aurora pgvector credentials for the Bedrock knowledge base',
        tags,
    });
    new aws.secretsmanager.SecretVersion('kb-vector-db-secret-version', {
        secretId: dbSecret.id,
        secretString: masterPassword.result.apply((password) =>
            JSON.stringify({ username: 'kbadmin', password }),
        ),
    });

    // Optional VPC placement: CI passes net-foundation outputs as config in real deployments.
    const subnetCsv = config.get('privateSubnetIds');
    const dbSubnetGroupName = subnetCsv
        ? new aws.rds.SubnetGroup('kb-vector-db-subnets', {
              subnetIds: subnetCsv.split(','),
              tags,
          }).name
        : undefined;
    const vpcSecurityGroupIds = config.get('vectorSecurityGroupId')
        ? [config.require('vectorSecurityGroupId')]
        : undefined;

    // --- Aurora PostgreSQL Serverless v2 with Data API + scale-to-zero ---
    // Scale-to-zero (minCapacity 0) requires a recent engine (>= 15.7 / 16.3); pgvector 0.8.0
    // for HNSW iterative scans ships on these too. Overridable via config.
    const engineVersion = config.get('engineVersion') ?? '16.6';
    const cluster = new aws.rds.Cluster('kb-vector-db', {
        engine: 'aurora-postgresql',
        engineMode: 'provisioned',
        engineVersion,
        databaseName,
        masterUsername: 'kbadmin',
        masterPassword: masterPassword.result,
        storageEncrypted: true,
        enableHttpEndpoint: true, // Data API — how Bedrock talks to the vector store.
        skipFinalSnapshot: identity.env !== 'prd',
        dbSubnetGroupName,
        vpcSecurityGroupIds,
        serverlessv2ScalingConfiguration: { minCapacity: 0, maxCapacity: 4 },
        tags,
    });

    const instance = new aws.rds.ClusterInstance('kb-vector-db-instance', {
        clusterIdentifier: cluster.id,
        instanceClass: 'db.serverless',
        engine: 'aurora-postgresql',
        engineVersion: cluster.engineVersion,
        tags,
    });

    // --- Provision the pgvector schema Bedrock validates on KB creation (via the Data API) ---
    // Titan V2 emits 1024-dim embeddings; keep this in lockstep with the KB embedding model.
    const vectorDimensions = config.getNumber('vectorDimensions') ?? 1024;
    const bootstrapFn = new LambdaFunctionComponent('kb-pgvector-bootstrap', {
        name: pulumi.interpolate`kb-pgvector-bootstrap-${identity.env}`,
        code: new pulumi.asset.FileArchive('./functions/pgvector-bootstrap'),
        timeout: 120,
        environment: {
            CLUSTER_ARN: cluster.arn,
            SECRET_ARN: dbSecret.arn,
            DATABASE_NAME: databaseName,
            TABLE_NAME: 'bedrock_kb',
            VECTOR_DIMENSIONS: String(vectorDimensions),
        },
        inlinePolicy: pulumi.all([cluster.arn, dbSecret.arn]).apply(([clusterArn, secretArn]) =>
            JSON.stringify({
                Version: '2012-10-17',
                Statement: [
                    {
                        Sid: 'RunSchemaDdl',
                        Effect: 'Allow',
                        Action: ['rds-data:ExecuteStatement'],
                        Resource: [clusterArn],
                    },
                    {
                        Sid: 'ReadDbSecret',
                        Effect: 'Allow',
                        Action: ['secretsmanager:GetSecretValue'],
                        Resource: [secretArn],
                    },
                ],
            }),
        ),
        tags,
    });

    // Invoke once at deploy time, after the instance is available; re-runs if the cluster changes.
    new aws.lambda.Invocation(
        'kb-pgvector-bootstrap-invoke',
        {
            functionName: bootstrapFn.function.name,
            input: cluster.arn.apply((arn) => JSON.stringify({ clusterArn: arn })),
            triggers: { clusterArn: cluster.arn },
        },
        { dependsOn: [instance] },
    );

    return {
        message: pulumi.output(`Stateful data (S3 raw + Aurora pgvector) deployed for: ${env}`),
        rawBucketArn: rawBucket.arn,
        rawBucketName: rawBucket.bucket.bucket,
        vectorClusterArn: cluster.arn,
        vectorSecretArn: dbSecret.arn,
        databaseName,
    };
}
