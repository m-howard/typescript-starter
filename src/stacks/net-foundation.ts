/**
 * Network Foundation Stack - Provides core networking infrastructure for the region.
 *
 * Provisions the VPC, private subnets, and — critically for this architecture — PrivateLink
 * interface endpoints for Bedrock, Secrets Manager, and RDS Data, plus an S3 gateway endpoint.
 * These endpoints are what make the "data stays in our AWS account and never traverses the public
 * internet" claim actually true; without them, traffic to Bedrock would leave the VPC. Depends on
 * the account baseline stack and is a prerequisite for all regional stacks.
 *
 * @param env - The deployment environment (dev, val, prd)
 * @returns Pulumi outputs for the network foundation stack
 */
import * as pulumi from '@pulumi/pulumi';
import * as aws from '@pulumi/aws';
import { parseStackName, standardTags } from './shared';

export interface StackOutputs {
    /** Informational message about the stack deployment. */
    message: pulumi.Output<string>;
    /** ID of the provisioned VPC. */
    vpcId: pulumi.Output<string>;
    /** Private subnet IDs for workloads that must reach private endpoints. */
    privateSubnetIds: pulumi.Output<string[]>;
    /** Security group ID allowing intra-VPC access to the interface endpoints. */
    endpointSecurityGroupId: pulumi.Output<string>;
}

/**
 * Creates the network foundation stack for the specified region/environment.
 *
 * @param env - The deployment stack name (`<region>-<env>`)
 * @returns Pulumi outputs for the network foundation stack
 */
export async function createStack(env: string): Promise<StackOutputs> {
    pulumi.log.info(`[net-foundation] Deploying network foundation stack for environment: ${env}`);

    const identity = parseStackName(env);
    const tags = standardTags('net-foundation', identity);
    const config = new pulumi.Config();
    const cidr = config.get('vpcCidr') ?? '10.0.0.0/16';

    const vpc = new aws.ec2.Vpc('kb-vpc', {
        cidrBlock: cidr,
        enableDnsHostnames: true,
        enableDnsSupport: true,
        tags: { ...tags, Name: `kb-vpc-${identity.env}` },
    });

    const azs = await aws.getAvailabilityZones({ state: 'available' });
    const subnetAzs = azs.names.slice(0, 2);

    const privateSubnets = subnetAzs.map(
        (az, index) =>
            new aws.ec2.Subnet(`kb-private-${index}`, {
                vpcId: vpc.id,
                cidrBlock: `10.0.${index}.0/24`,
                availabilityZone: az,
                mapPublicIpOnLaunch: false,
                tags: { ...tags, Name: `kb-private-${az}` },
            }),
    );
    const privateSubnetIds = pulumi.all(privateSubnets.map((s) => s.id));

    // Security group permitting HTTPS from within the VPC to the interface endpoints.
    const endpointSg = new aws.ec2.SecurityGroup('kb-endpoints-sg', {
        vpcId: vpc.id,
        description: 'Allow intra-VPC HTTPS to PrivateLink endpoints',
        ingress: [
            {
                description: 'HTTPS from VPC',
                fromPort: 443,
                toPort: 443,
                protocol: 'tcp',
                cidrBlocks: [cidr],
            },
        ],
        egress: [{ fromPort: 0, toPort: 0, protocol: '-1', cidrBlocks: ['0.0.0.0/0'] }],
        tags: { ...tags, Name: `kb-endpoints-sg-${identity.env}` },
    });

    const region = identity.region ?? aws.config.region ?? 'us-east-1';

    // S3 gateway endpoint (free) keeps doc reads on the AWS backbone.
    const routeTable = new aws.ec2.RouteTable('kb-private-rt', {
        vpcId: vpc.id,
        tags: { ...tags, Name: `kb-private-rt-${identity.env}` },
    });
    privateSubnets.forEach((subnet, index) => {
        new aws.ec2.RouteTableAssociation(`kb-private-rta-${index}`, {
            subnetId: subnet.id,
            routeTableId: routeTable.id,
        });
    });
    new aws.ec2.VpcEndpoint('kb-s3-endpoint', {
        vpcId: vpc.id,
        serviceName: `com.amazonaws.${region}.s3`,
        vpcEndpointType: 'Gateway',
        routeTableIds: [routeTable.id],
        tags: { ...tags, Name: `kb-s3-endpoint-${identity.env}` },
    });

    // Interface endpoints so Bedrock/Secrets/RDS-Data traffic never leaves the account.
    const interfaceServices = [
        'bedrock-runtime',
        'bedrock-agent-runtime',
        'secretsmanager',
        'rds-data',
    ];
    interfaceServices.forEach((service) => {
        new aws.ec2.VpcEndpoint(`kb-${service}-endpoint`, {
            vpcId: vpc.id,
            serviceName: `com.amazonaws.${region}.${service}`,
            vpcEndpointType: 'Interface',
            subnetIds: privateSubnets.map((s) => s.id),
            securityGroupIds: [endpointSg.id],
            privateDnsEnabled: true,
            tags: { ...tags, Name: `kb-${service}-endpoint-${identity.env}` },
        });
    });

    return {
        message: pulumi.output(`Network foundation (VPC + PrivateLink) deployed for: ${env}`),
        vpcId: vpc.id,
        privateSubnetIds,
        endpointSecurityGroupId: endpointSg.id,
    };
}
