<h1 align="center">AWS Pulumi Infrastructure</h1>

<p align="center">
  <em>A complete, production-ready AWS infrastructure deployment solution</em>
  <br>
  <em>Deploy full web application infrastructure to AWS using Pulumi, TypeScript, and GitHub Actions</em>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/TypeScript-5.7.3-blue?style=flat-square&logo=typescript" alt="TypeScript">
  <img src="https://img.shields.io/badge/Pulumi-latest-purple?style=flat-square&logo=pulumi" alt="Pulumi">
  <img src="https://img.shields.io/badge/AWS-orange?style=flat-square&logo=amazon-aws" alt="AWS">
  <img src="https://img.shields.io/badge/GitHub%20Actions-2088FF?style=flat-square&logo=github-actions" alt="GitHub Actions">
  <img src="https://img.shields.io/badge/Jest-29.7.0-red?style=flat-square&logo=jest" alt="Jest">
  <img src="https://img.shields.io/badge/ESLint-9.18.0-purple?style=flat-square&logo=eslint" alt="ESLint">
</p>

## ✨ Features

- 🚀 **Infrastructure as Code** - Pulumi Automation API with TypeScript
- ☁️ **AWS Native** - Deploy full web application infrastructure to AWS
- 🏗️ **Layered Architecture** - 5-layer dependency model with proper separation
- 🔄 **CI/CD Ready** - GitHub Actions workflows for automated deployments
- 🧩 **Reusable Components** - Modular AWS Pulumi components
- 🧪 **Comprehensive Testing** - Jest with unit, integration, and e2e tests
- 📝 **Code Quality** - ESLint + Prettier for consistent code style
- 🌍 **Multi-Region** - Deploy across multiple AWS regions
- 🔒 **Blue/Green Ready** - Zero-downtime deployment strategies

## 🚀 Quick Start

```bash
# Clone the repository
git clone <your-repo-url>
cd aws-pulumi-infrastructure

# Install dependencies and set up development environment
npm install
npm run setup

# Configure AWS credentials
aws configure

# Quick development preview
npm run dev

# Deploy full infrastructure to development
npm run deploy:dev
```

## 🏗️ Layered Architecture

This project follows a 5-layer dependency model based on AWS best practices:

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

Each layer builds upon the previous one, ensuring proper dependency management and isolated failure domains.

## 📁 Project Structure

```text
src/
├── index.ts           # Main Pulumi automation API orchestrator
├── components/        # Reusable AWS Pulumi components
├── stacks/           # 5-layer stack definitions
│   ├── acct-baseline.ts    # Account baseline
│   ├── net-foundation.ts   # Network foundation
│   ├── svc-platform.ts     # Service platform
│   ├── stateful-data.ts    # Data storage
│   └── workloads.ts        # Application workloads
└── utils/            # Infrastructure utility functions

.github/workflows/    # GitHub Actions CI/CD pipelines
test/                # Infrastructure and component tests
docs/                # Architecture and deployment documentation
```

## 🛠️ Available Scripts

### **Core Development**

| Script              | Description                        |
| ------------------- | ---------------------------------- |
| `npm run dev`       | Quick development preview          |
| `npm run start`     | Alias for `dev`                    |
| `npm run build`     | Compile TypeScript to JavaScript  |
| `npm run test`      | Run infrastructure tests           |
| `npm run test:cov`  | Run tests with coverage            |
| `npm run lint`      | Check and fix code quality         |
| `npm run format`    | Format code with Prettier         |

### **Environment Deployments**

| Script                | Description                           |
| --------------------- | ------------------------------------- |
| `npm run deploy:dev`  | Deploy all layers to development     |
| `npm run deploy:val`  | Deploy all layers to validation       |
| `npm run deploy:prd`  | Deploy all layers to production       |
| `npm run destroy:dev` | Destroy all layers in development    |
| `npm run destroy:val` | Destroy all layers in validation     |
| `npm run destroy:prd` | Destroy all layers in production     |
| `npm run preview:dev` | Preview changes in development       |
| `npm run preview:val` | Preview changes in validation        |
| `npm run preview:prd` | Preview changes in production        |

### **Specialized Deployments**

| Script                    | Description                               |
| ------------------------- | ----------------------------------------- |
| `npm run deploy:foundation` | Deploy account baseline + networking   |
| `npm run deploy:platform`   | Deploy foundation + services + data    |
| `npm run destroy:platform`  | Destroy platform components only       |
| `npm run deploy:multi-region` | Deploy across multiple regions        |

## 💻 Usage Examples

### **Quick Development Workflow**

```bash
# Start development - preview all infrastructure
npm run dev

# Deploy to development environment
npm run deploy:dev

# Make changes and preview
npm run preview:dev

# Deploy changes
npm run deploy:dev
```

### **Environment Promotion**

```bash
# 1. Test in development
npm run deploy:dev
npm run test

# 2. Promote to validation
npm run deploy:val

# 3. Deploy to production
npm run deploy:prd
```

### **Incremental Deployments**

```bash
# Deploy just the foundation layers
npm run deploy:foundation

# Deploy platform components (foundation + services + data)
npm run deploy:platform

# Deploy specific layers using the orchestrator directly
npx ts-node src/index.ts deploy dev --scope workload --regions us-east-1

# Deploy to multiple regions
npm run deploy:multi-region
```

### **Infrastructure Testing**

```bash
# Run all infrastructure tests
npm run test

# Run tests with coverage
npm run test:cov

# Run end-to-end tests
npm run test:e2e

# Validate project setup
npm run validate
```

### **Custom Orchestration**

For advanced use cases, use the orchestrator directly:

```bash
# Deploy specific layers
npx ts-node src/index.ts deploy prd --scope acct-baseline,net-foundation --regions us-east-1

# Multi-region deployment
npx ts-node src/index.ts deploy prd --scope workload --regions us-east-1,us-west-2,eu-west-1

# Preview changes with specific scope
npx ts-node src/index.ts preview val --scope svc-platform,stateful-data --regions us-east-1
```

## 🎯 Layer Dependencies

### **Account Baseline** (`acct-baseline`)
- Account-wide IAM policies and roles
- Config rules and compliance
- CloudTrail and security settings
- **Scope**: Per AWS Account

### **Network Foundation** (`net-foundation`)
- VPC, subnets, and routing
- Internet/NAT gateways
- VPC endpoints and certificates
- **Scope**: Per Region

### **Service Platform** (`svc-platform`)
- EKS/ECS clusters
- Service mesh configuration
- Platform observability
- **Scope**: Per Region

### **Stateful Data** (`stateful-data`)
- RDS databases
- ElastiCache clusters
- S3 buckets and storage
- **Scope**: Per Region

### **Workload** (`workload`)
- Application services
- Blue/green deployments
- Application-specific resources
- **Scope**: Per Region

## 🔧 Environment Configuration

The infrastructure supports environment-based configuration with different resource sizing and features:

```typescript
// Development environment
const devConfig = {
  region: 'us-east-1',
  instanceType: 't3.micro',
  minCapacity: 1,
  maxCapacity: 2,
  multiAz: false
};

// Production environment
const prdConfig = {
  region: 'us-east-1',
  instanceType: 't3.large',
  minCapacity: 2,
  maxCapacity: 10,
  multiAz: true
};
```

## 🚦 Deployment Strategies

### **Blue/Green Deployments**

The architecture supports both cluster-level and service-level blue/green deployments:

```bash
# Deploy new version (blue)
npm run deploy:dev

# Switch traffic and verify
# Deploy green version
npx ts-node src/index.ts deploy dev --scope workload --regions us-east-1

# Destroy old version after validation
npx ts-node src/index.ts destroy dev --scope workload --regions us-east-1 --target blue
```

### **Multi-Region Strategy**

```bash
# Deploy to primary region
npm run deploy:prd

# Deploy to secondary regions
npx ts-node src/index.ts deploy prd --scope net-foundation,svc-platform,stateful-data,workload --regions us-west-2,eu-west-1
```

## 🗝️ Pulumi State Backend Setup

To use a self-managed Pulumi state backend (such as AWS S3 or local filesystem), use the provided login script:

```bash
./scripts/pulumi-login.sh
```

This script will prompt you to select and configure your preferred backend for storing Pulumi state files. For AWS projects, S3 is recommended for team use.

## 📖 Documentation

- [Software Architecture](./docs/SOFTWARE_ARCHITECTURE.md) - Complete architectural overview
- [Infrastructure Guide](./docs/README.md) - Detailed deployment guide
- [Testing Architecture](./docs/TESTING_ARCHITECTURE.md) - Testing strategies and patterns

## 🔒 Security & Compliance

- **Least Privilege**: IAM roles with minimal required permissions
- **Encryption**: All data encrypted at rest and in transit
- **Network Security**: VPC with proper subnet isolation
- **Compliance**: AWS Config rules for governance
- **Monitoring**: CloudTrail and CloudWatch for observability

## 📄 License

UNLICENSED - Free to use for any purpose

---

<p align="center">
  <em>Happy coding! 🚀</em>
</p>
