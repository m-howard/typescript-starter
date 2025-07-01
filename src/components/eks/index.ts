/**
 * AWS EKS Cluster Component - Manages EKS cluster and node groups
 */
import * as pulumi from '@pulumi/pulumi';
import * as aws from '@pulumi/aws';
import * as eks from '@pulumi/eks';
import * as k8s from '@pulumi/kubernetes';

/**
 * Node group options for EKS managed node groups
 * @example
 * {
 *   nodeGroupName: "app-ng",
 *   instanceTypes: ["t3.medium"],
 *   minSize: 1,
 *   maxSize: 3,
 *   desiredSize: 2
 * }
 */
export interface NodeGroupOptions {
    nodeGroupName: string;
    instanceTypes: pulumi.Input<string[]>;
    minSize: pulumi.Input<number>;
    maxSize: pulumi.Input<number>;
    desiredSize: pulumi.Input<number>;
    // ...other node group options as needed
}

/**
 * Arguments for the EKS cluster component
 */
export interface EksClusterArgs {
    /** Optional cluster name override */
    name?: pulumi.Input<string>;
    /** Kubernetes version (default: 1.29) */
    version?: pulumi.Input<string>;
    /** VPC ID for the cluster */
    vpcId: pulumi.Input<string>;
    /** Public subnet IDs for EKS */
    publicSubnetIds: pulumi.Input<string[]>;
    /** Private subnet IDs for EKS */
    privateSubnetIds: pulumi.Input<string[]>;
    /** Additional CIDRs for API SG ingress */
    additionalSecurityGroupCidrs?: pulumi.Input<string[]>;
    /** CIDRs allowed to access EKS API */
    eksApiSgCidrs: pulumi.Input<string>[];
    /** Enable public endpoint access (default: true) */
    endpointPublicAccess?: pulumi.Input<boolean>;
    /** Enable private endpoint access (default: true) */
    endpointPrivateAccess?: pulumi.Input<boolean>;
    /** Optional cluster RBAC role mappings */
    clusterRoleMappings?: pulumi.Input<eks.RoleMapping[]>;
    /** Node group configuration(s) */
    nodeGroupOptions: NodeGroupOptions[];
    /** Cluster-level tags */
    clusterTags: pulumi.Input<{ [key: string]: pulumi.Input<string> }>;
    /** Resource tags */
    tags: pulumi.Input<{ [key: string]: pulumi.Input<string> }>;
}

/**
 * EKS Cluster Component
 * @example
 * const eksCluster = new EksCluster('my-eks', { ... });
 */
export class EksCluster extends pulumi.ComponentResource {
    /** EKS cluster name */
    public readonly clusterName: string;
    /** Pulumi EKS cluster resource */
    public readonly cluster: eks.Cluster;
    /** Kubernetes version */
    public readonly version: string;
    /** VPC ID */
    public readonly vpcId: string;
    /** Security group for EKS API */
    public readonly eksApiSecurityGroup: aws.ec2.SecurityGroup;
    /** Managed node groups */
    public readonly nodeGroups: eks.ManagedNodeGroup[] = [];

    /**
     * Creates an EKS cluster and managed node groups
     * @param name Resource name
     * @param args Cluster configuration
     * @param opts Pulumi resource options
     */
    constructor(name: string, args: EksClusterArgs, opts?: pulumi.ComponentResourceOptions) {
        super('mtx:aws:eks', name, {}, opts);

        this.clusterName = (args.name as string) ?? name;
        this.vpcId = args.vpcId as string;
        this.version = (args.version as string) ?? '1.29';

        const defaultTags = args.tags ?? {};
        const resourceTags = {
            ...defaultTags,
            Name: `${this.clusterName}-nodegroup`,
        };

        // --- Security Group for EKS API ---
        const sgName = `${this.clusterName}-eks-api`;
        this.eksApiSecurityGroup = new aws.ec2.SecurityGroup(
            sgName,
            {
                name: sgName,
                vpcId: this.vpcId,
                ingress: [
                    {
                        description: 'API network access',
                        fromPort: 443,
                        toPort: 443,
                        protocol: 'tcp',
                        cidrBlocks: [...(args.eksApiSgCidrs as string[])],
                    },
                    ...((args.additionalSecurityGroupCidrs as string[] | undefined) || []).map(
                        (cidr) => ({
                            description: 'Self access',
                            fromPort: 0,
                            toPort: 0,
                            protocol: '-1',
                            cidrBlocks: [cidr],
                            self: true,
                        }),
                    ),
                ],
                egress: [
                    {
                        fromPort: 0,
                        toPort: 0,
                        protocol: '-1',
                        cidrBlocks: ['0.0.0.0/0'],
                        ipv6CidrBlocks: ['::/0'],
                    },
                ],
                tags: { ...resourceTags, Name: sgName },
            },
            { parent: this },
        );

        // --- KMS Key for Secrets Encryption ---
        const secretsEncryptionKey = new aws.kms.Key(
            `${this.clusterName}-eks-secrets-key`,
            {
                description: 'KMS key for EKS secrets encryption',
                enableKeyRotation: true,
                tags: {
                    ...resourceTags,
                    Name: `${this.clusterName}-eks-secrets-key`,
                },
            },
            { parent: this },
        );

        // --- IAM Role for EKS Cluster ---
        const serviceRole = new aws.iam.Role(
            `${this.clusterName}-eks-service`,
            {
                assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal({
                    Service: 'eks.amazonaws.com',
                }),
                tags: {
                    ...resourceTags,
                    Name: `${this.clusterName}-eks-service-role`,
                },
            },
            { parent: this },
        );

        new aws.iam.RolePolicyAttachment(`${this.clusterName}-eks-cluster-policy`, {
            role: serviceRole.name,
            policyArn: 'arn:aws:iam::aws:policy/AmazonEKSClusterPolicy',
        });

        // --- EKS Cluster Definition ---
        this.cluster = new eks.Cluster(
            `${this.clusterName}`,
            {
                vpcId: this.vpcId,
                privateSubnetIds: args.privateSubnetIds,
                publicSubnetIds: args.publicSubnetIds,
                publicAccessCidrs: args.eksApiSgCidrs,
                endpointPublicAccess: args.endpointPublicAccess ?? true,
                endpointPrivateAccess: args.endpointPrivateAccess ?? true,
                clusterSecurityGroup: this.eksApiSecurityGroup,
                nodeAssociatePublicIpAddress: false,
                createOidcProvider: true,
                serviceRole: serviceRole,
                roleMappings: args.clusterRoleMappings,
                skipDefaultNodeGroup: true, // We'll create managed node groups below
                encryptionConfigKeyArn: secretsEncryptionKey.arn,
                enabledClusterLogTypes: [
                    'api',
                    'audit',
                    'authenticator',
                    'controllerManager',
                    'scheduler',
                ],
                clusterTags: {
                    ...args.clusterTags,
                    [`kubernetes.io/cluster/${this.clusterName}`]: 'owned',
                },
                tags: {
                    ...args.tags,
                    [`kubernetes.io/cluster/${this.clusterName}`]: 'owned',
                },
                version: this.version,
            },
            { parent: this, customTimeouts: { create: '30m', delete: '30m' } },
        );

        // --- Managed Node Groups ---
        if (Array.isArray(args.nodeGroupOptions)) {
            for (const ngOpts of args.nodeGroupOptions) {
                this.nodeGroups.push(
                    new eks.ManagedNodeGroup(
                        `${this.clusterName}-${ngOpts.nodeGroupName}`,
                        {
                            cluster: this.cluster,
                            instanceTypes: ngOpts.instanceTypes,
                            scalingConfig: {
                                minSize: ngOpts.minSize,
                                maxSize: ngOpts.maxSize,
                                desiredSize: ngOpts.desiredSize,
                            },
                            subnetIds: args.privateSubnetIds,
                            tags: {
                                ...resourceTags,
                                Name: `${this.clusterName}-${ngOpts.nodeGroupName}`,
                                [`kubernetes.io/cluster/${this.clusterName}`]: 'owned',
                            },
                        },
                        { parent: this },
                    ),
                );
            }
        }

        // --- RBAC: ClusterRole and ClusterRoleBinding for admin ---
        new k8s.rbac.v1.ClusterRole(
            `${this.clusterName}-admin-role`,
            {
                metadata: { name: 'cluster-admin-role' },
                rules: [
                    {
                        apiGroups: ['*'],
                        resources: ['*'],
                        verbs: ['*'],
                    },
                ],
            },
            { parent: this.cluster, provider: this.cluster.provider },
        );

        new k8s.rbac.v1.ClusterRoleBinding(
            `${this.clusterName}-admin-role-binding`,
            {
                metadata: { name: 'cluster-admin-binding' },
                subjects:
                    (args.clusterRoleMappings as eks.RoleMapping[] | undefined)
                        ?.filter(
                            (mapping) =>
                                Array.isArray(mapping.groups) &&
                                mapping.groups.includes('system:masters'),
                        )
                        .map((mapping) => ({ kind: 'User', name: mapping.username })) || [],
                roleRef: {
                    kind: 'ClusterRole',
                    name: 'cluster-admin-role',
                    apiGroup: 'rbac.authorization.k8s.io',
                },
            },
            { parent: this.cluster, provider: this.cluster.provider },
        );

        // --- Tag subnets for Kubernetes ---
        pulumi.output(args.privateSubnetIds as string[]).apply((subnets) => {
            subnets.forEach((subnetId, index) => {
                new aws.ec2.Tag(`${this.clusterName}-private-subnet-${index}-shared`, {
                    key: `kubernetes.io/cluster/${this.clusterName}`,
                    value: 'shared',
                    resourceId: subnetId,
                });
            });
        });
        pulumi.output(args.publicSubnetIds as string[]).apply((subnets) => {
            subnets.forEach((subnetId, index) => {
                new aws.ec2.Tag(`${this.clusterName}-public-subnet-${index}-shared`, {
                    key: `kubernetes.io/cluster/${this.clusterName}`,
                    value: 'shared',
                    resourceId: subnetId,
                });
            });
        });

        // --- Register outputs for stack references ---
        this.registerOutputs({
            cluster: this.cluster,
            nodeGroups: this.nodeGroups,
            securityGroup: this.eksApiSecurityGroup,
            serviceRole: serviceRole,
            secretsEncryptionKey: secretsEncryptionKey,
        });
    }
}

export default EksCluster;
