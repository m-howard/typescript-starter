# AWS Pulumi Infrastructure Documentation

## Overview

This AWS Pulumi Infrastructure repository provides a complete foundation for deploying web application infrastructure to AWS using Pulumi, TypeScript, and the Automation API. The project follows a layered architecture based on AWS best practices to support different deployment lifecycles and environments.

## Layered Architecture

The infrastructure follows a 5-layer dependency model:

```text
  acct-baseline (Account-wide policies, roles, config rules)
        ↓
net-foundation (VPC, subnets, gateways, endpoints, certs)
        ↓
 ┌──────────────────┐
 ↓                  ↓
stateful-data    svc-platform (Clusters, service mesh, observability)
        ↓
     workload (Application services & blue/green deployments)
```

### Layer Details

#### Account Baseline (`acct-baseline`)

- **Purpose**: Account-wide policies, roles, config rules
- **Scope**: Per AWS Account
- **Contains**: IAM policies, CloudTrail, Config rules, compliance settings

#### Network Foundation (`net-foundation`)

- **Purpose**: VPC, subnets, gateways, endpoints, certificates
- **Scope**: Per Region
- **Contains**: VPC, subnets, NAT gateways, VPC endpoints, ACM certificates

#### Service Platform (`svc-platform`)

- **Purpose**: Clusters, service mesh, platform observability
- **Scope**: Per Region
- **Contains**: EKS/ECS clusters, service mesh, monitoring infrastructure

#### Stateful Data (`stateful-data`)

- **Purpose**: Data storage systems
- **Scope**: Per Region
- **Contains**: RDS databases, ElastiCache, S3 buckets, data stores

#### Workload (`workload`)

- **Purpose**: Application services & blue/green deployments
- **Scope**: Per Region
- **Contains**: Application services, load balancers, auto-scaling groups

## Project Structure

```text
aws-pulumi-infrastructure/
├── src/                        # Infrastructure source code
│   ├── index.ts               # Main Pulumi automation API orchestrator
│   ├── components/            # Reusable AWS Pulumi components
│   │   ├── networking/        # VPC, subnets, security groups
│   │   ├── compute/           # ECS, EC2, load balancers
│   │   ├── storage/           # S3, RDS, ElastiCache
│   │   ├── monitoring/        # CloudWatch, alarms
│   │   └── index.ts           # Infrastructure component exports
│   ├── stacks/               # 5-layer stack definitions
│   │   ├── acct-baseline.ts   # Account baseline stack
│   │   ├── net-foundation.ts  # Network foundation stack
│   │   ├── svc-platform.ts    # Service platform stack
│   │   ├── stateful-data.ts   # Data storage stack
│   │   └── workloads.ts       # Application workload stack
│   └── utils/                # Infrastructure utility functions
│       ├── helpers.ts        # General helper functions
│       └── logger.ts         # Logging utility
├── .github/workflows/        # GitHub Actions CI/CD pipelines
├── test/                    # Infrastructure and component tests
│   ├── *.spec.ts            # Unit tests for components
│   ├── *.e2e.spec.ts        # End-to-end infrastructure tests
│   └── jest-e2e.json        # E2E test configuration
├── docs/                    # Infrastructure documentation
├── bin/                     # Compiled output (generated)
└── coverage/                # Test coverage reports (generated)
```

## Features

### AWS Infrastructure Components

- **VPC & Networking**: Complete VPC setup with public/private subnets, NAT gateways, and security groups
- **Application Load Balancer**: High-availability load balancing with SSL termination
- **ECS/Fargate**: Containerized application hosting with auto-scaling
- **RDS**: Managed database solutions with backup and monitoring
- **S3**: Static asset storage, backups, and CloudFront integration
- **Route 53**: DNS management and health checks

### Multi-Environment Support

- **Development (dev)**: Cost-optimized environment for development and testing
- **Validation (val)**: Production-like environment for validation and staging
- **Production (prd)**: High-availability, scalable production infrastructure

### Development Tools

- **Pulumi Automation API**: Infrastructure as code with TypeScript
- **GitHub Actions**: Automated CI/CD pipelines for infrastructure deployment
- **Environment Configuration**: Structured configuration management per environment
- **Jest**: Infrastructure testing framework with coverage reporting
- **ESLint**: Code linting with TypeScript and Pulumi best practices
- **Prettier**: Code formatting for consistent style

## Getting Started

### Prerequisites

- Node.js (version 16 or higher)
- npm or yarn
- AWS CLI configured with appropriate credentials
- Pulumi CLI installed

### Installation

1. Clone the repository
2. Install dependencies:

    ```bash
    npm install
    ```

3. Configure AWS credentials:

    ```bash
    aws configure
    ```

4. Install and configure Pulumi:

    ```bash
    curl -fsSL https://get.pulumi.com | sh
    pulumi login
    ```

5. Run the setup script:

    ```bash
    ./scripts/setup-dev.sh
    ```

### Infrastructure Deployment

Deploy development environment:

```bash
npm run deploy:dev
```

Deploy validation environment:

```bash
npm run deploy:val
```

Deploy production environment:

```bash
npm run deploy:prd
```

Preview changes before deployment:

```bash
npm run preview:dev  # or preview:val, preview:prd
```

Destroy infrastructure:

```bash
npm run destroy:dev  # or destroy:val, destroy:prd
```

## Available Scripts

### Core Development

- `npm run dev` - Quick development preview of all infrastructure
- `npm run start` - Alias for `dev`
- `npm run build` - Compile TypeScript to JavaScript
- `npm run test` - Run infrastructure component tests
- `npm run test:watch` - Run tests in watch mode
- `npm run test:cov` - Run tests with coverage
- `npm run test:e2e` - Run end-to-end infrastructure tests
- `npm run lint` - Check and fix code quality
- `npm run format` - Format code with Prettier

### Environment Deployments

- `npm run deploy:dev` - Deploy all layers to development
- `npm run deploy:val` - Deploy all layers to validation
- `npm run deploy:prd` - Deploy all layers to production
- `npm run destroy:dev` - Destroy all layers in development
- `npm run destroy:val` - Destroy all layers in validation
- `npm run destroy:prd` - Destroy all layers in production
- `npm run preview:dev` - Preview changes in development
- `npm run preview:val` - Preview changes in validation
- `npm run preview:prd` - Preview changes in production

### Specialized Deployments

- `npm run deploy:foundation` - Deploy account baseline + networking
- `npm run deploy:platform` - Deploy foundation + services + data
- `npm run destroy:platform` - Destroy platform components only
- `npm run deploy:multi-region` - Deploy across multiple regions

### Custom Orchestration

For advanced use cases, use the orchestrator directly:

```bash
# Deploy specific layers
npx ts-node src/index.ts deploy prd --scope acct-baseline,net-foundation --regions us-east-1

# Multi-region deployment
npx ts-node src/index.ts deploy prd --scope workload --regions us-east-1,us-west-2

# Preview specific scope
npx ts-node src/index.ts preview val --scope svc-platform,stateful-data --regions us-east-1
```

## Usage Examples

### Quick Development Workflow

```bash
# Start development - preview all infrastructure layers
npm run dev

# Deploy everything to development
npm run deploy:dev

# Make infrastructure changes and preview
npm run preview:dev

# Deploy changes
npm run deploy:dev

# Run tests to validate
npm run test
```

### Environment Promotion Workflow

```bash
# 1. Develop and test
npm run deploy:dev
npm run test

# 2. Promote to validation
npm run deploy:val

# 3. Deploy to production
npm run deploy:prd
```

### Incremental Development

```bash
# Deploy just the foundation layers (account + network)
npm run deploy:foundation

# Deploy platform components (foundation + services + data)
npm run deploy:platform

# Deploy workloads to complete the stack
npx ts-node src/index.ts deploy dev --scope workload --regions us-east-1
```

### Multi-Region Deployment

```bash
# Deploy to multiple regions
npm run deploy:multi-region

# Or deploy specific layers to specific regions
npx ts-node src/index.ts deploy prd --scope net-foundation,svc-platform --regions us-west-2,eu-west-1
```

## Infrastructure Testing

The project includes comprehensive infrastructure testing:

- **Unit Tests**: Individual component testing (VPC, ALB, ECS, etc.)
- **Integration Tests**: Multi-component interaction testing
- **End-to-End Tests**: Full infrastructure stack validation

Test files are located in the `test/` directory and follow the naming convention `*.spec.ts` for unit tests and `*.e2e.spec.ts` for end-to-end tests.

Example infrastructure test:

```typescript
describe('VPC Component', () => {
    it('should create VPC with correct CIDR block', async () => {
        const vpc = new VpcComponent('test-vpc', {
            cidrBlock: '10.0.0.0/16',
        });

        expect(vpc.vpc.cidrBlock).toBe('10.0.0.0/16');
    });
});
```

## Multi-Environment Configuration

The project uses environment-based configuration files:

```typescript
// configs/dev.ts
export const devConfig = {
    region: 'us-east-1',
    environment: 'dev',
    vpc: {
        cidrBlock: '10.0.0.0/16',
    },
    ecs: {
        instanceType: 't3.micro',
        minCapacity: 1,
        maxCapacity: 2,
    },
    rds: {
        instanceClass: 'db.t3.micro',
        allocatedStorage: 20,
    },
};
```

## CI/CD with GitHub Actions

The repository includes GitHub Actions workflows for:

- **Infrastructure Validation**: Lint, test, and validate infrastructure code
- **Environment Deployment**: Automated deployment to dev, val, and prd environments
- **Infrastructure Drift Detection**: Monitor and alert on configuration drift
- **Security Scanning**: Scan infrastructure code for security vulnerabilities

## Pulumi State Backend Setup

To configure your Pulumi state backend (S3 or local), use the helper script:

```bash
./scripts/pulumi-login.sh
```

This script will prompt you to select and configure your preferred backend for storing Pulumi state files. S3 is recommended for AWS projects and team collaboration.

## Contributing

1. Follow the existing infrastructure patterns and naming conventions
2. Write tests for new AWS components
3. Ensure all tests pass before submitting: `npm test`
4. Run linting to check code quality: `npm run lint`
5. Test infrastructure changes in development environment first
6. Document new components and configuration options

## Security Considerations

- All infrastructure follows AWS security best practices
- Secrets and sensitive data are managed through AWS Systems Manager
- Network security groups follow least-privilege access principles
- All resources are tagged for cost tracking and compliance

## License

This project is licensed under the UNLICENSED license.
