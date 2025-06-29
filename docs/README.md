# AWS Pulumi Infrastructure Documentation

## Overview

This AWS Pulumi Infrastructure repository provides a complete foundation for deploying web application infrastructure to AWS using Pulumi, TypeScript, and GitHub Actions. The project follows a multi-stack architecture to support different deployment lifecycles and environments.

## Project Structure

```text
aws-pulumi-infrastructure/
├── src/                        # Infrastructure source code
│   ├── index.ts               # Main Pulumi automation API entry point
│   ├── components/            # Reusable AWS Pulumi components
│   │   ├── networking/        # VPC, subnets, security groups
│   │   ├── compute/           # ECS, EC2, load balancers
│   │   ├── storage/           # S3, RDS, ElastiCache
│   │   ├── monitoring/        # CloudWatch, alarms
│   │   └── index.ts           # Infrastructure component exports
│   ├── stacks/               # Multi-stack definitions
│   └── utils/                # Infrastructure utility functions
│       ├── helpers.ts        # General helper functions
│       └── logger.ts         # Logging utility
├── .github/workflows/        # GitHub Actions CI/CD pipelines
├── configs/                  # Environment-based configurations
│   ├── dev.ts               # Development configuration
│   ├── val.ts               # Validation configuration
│   └── prd.ts               # Production configuration
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

### Multi-Stack Architecture

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
npm run preview
```

Destroy infrastructure (development only):

```bash
npm run destroy:dev
```

## Available Scripts

- `npm run deploy:dev` - Deploy development infrastructure
- `npm run deploy:val` - Deploy validation infrastructure  
- `npm run deploy:prd` - Deploy production infrastructure
- `npm run destroy:dev` - Destroy development infrastructure
- `npm run destroy:val` - Destroy validation infrastructure
- `npm run preview` - Preview infrastructure changes
- `npm run test` - Run infrastructure tests
- `npm run test:watch` - Run tests in watch mode
- `npm run test:cov` - Run tests with coverage
- `npm run test:e2e` - Run end-to-end infrastructure tests
- `npm run lint` - Run ESLint
- `npm run format` - Format code with Prettier

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
      cidrBlock: '10.0.0.0/16'
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
    cidrBlock: '10.0.0.0/16'
  },
  ecs: {
    instanceType: 't3.micro',
    minCapacity: 1,
    maxCapacity: 2
  },
  rds: {
    instanceClass: 'db.t3.micro',
    allocatedStorage: 20
  }
};
```

## CI/CD with GitHub Actions

The repository includes GitHub Actions workflows for:

- **Infrastructure Validation**: Lint, test, and validate infrastructure code
- **Environment Deployment**: Automated deployment to dev, val, and prd environments
- **Infrastructure Drift Detection**: Monitor and alert on configuration drift
- **Security Scanning**: Scan infrastructure code for security vulnerabilities

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
