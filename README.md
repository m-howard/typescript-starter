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
- 🏗️ **Multi-Stack Architecture** - Separate deployment lifecycles 
- 🔄 **CI/CD Ready** - GitHub Actions workflows for automated deployments
- 🧩 **Reusable Components** - Modular AWS Pulumi components
- 🧪 **Comprehensive Testing** - Jest with unit, integration, and e2e tests
- 📝 **Code Quality** - ESLint + Prettier for consistent code style
- 📚 **Documentation** - Complete infrastructure and deployment guides

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

# Deploy infrastructure (development environment)
npm run deploy:dev
```

## 📁 Project Structure

```text
src/
├── index.ts           # Main Pulumi automation API entry point
├── components/        # Reusable AWS Pulumi components
├── stacks/           # Multi-stack definitions (dev, val, prd)
└── utils/            # Infrastructure utility functions

.github/workflows/    # GitHub Actions CI/CD pipelines
configs/             # Environment-based configurations
test/               # Infrastructure and component tests
docs/               # Infrastructure documentation
```

## 🛠️ Available Scripts

| Script                | Description                           |
| --------------------- | ------------------------------------- |
| `npm run deploy:dev`  | Deploy development infrastructure     |
| `npm run deploy:val`  | Deploy validation infrastructure      |
| `npm run deploy:prd`  | Deploy production infrastructure      |
| `npm run destroy:dev` | Destroy development infrastructure    |
| `npm run preview`     | Preview infrastructure changes        |
| `npm run test`        | Run infrastructure tests              |
| `npm run test:cov`    | Run tests with coverage               |
| `npm run lint`        | Check code quality                    |
| `npm run format`      | Format code                           |

## 📖 Documentation

- [Infrastructure Guide](./docs/README.md) - Complete infrastructure deployment guide
- [AWS Components](./docs/AWS-COMPONENTS.md) - Available AWS Pulumi components
- [Multi-Stack Architecture](./docs/MULTI-STACK.md) - Environment management strategy

## 🏗️ Infrastructure Components

The repository provides reusable AWS components for:

```typescript
import { WebAppStack, DatabaseStack, NetworkingStack } from './src/components';

// Deploy a complete web application infrastructure
const webApp = new WebAppStack('my-app', {
  environment: 'dev',
  region: 'us-east-1'
});

// Use modular components
const networking = new NetworkingStack('networking', {
  cidr: '10.0.0.0/16'
});
```

## 🎯 What's Included

### AWS Infrastructure Components

- **VPC & Networking** - Secure network infrastructure with subnets and security groups
- **Application Load Balancer** - High-availability load balancing
- **ECS/Fargate Services** - Containerized application hosting
- **RDS Databases** - Managed database solutions
- **S3 Buckets** - Static asset storage and backups
- **Route 53 DNS** - Domain management and routing

### Multi-Environment Support

- **Development (dev)** - Cost-optimized for development and testing
- **Validation (val)** - Production-like environment for validation
- **Production (prd)** - High-availability, scalable production setup

### CI/CD Pipeline

- **GitHub Actions** - Automated infrastructure deployment
- **Environment Promotion** - Controlled deployment across environments
- **Infrastructure Testing** - Validation of infrastructure changes
- **Rollback Capabilities** - Safe deployment practices

## 🔧 Environment Configuration

The infrastructure supports environment-based configuration:

```typescript
// configs/dev.ts
export const devConfig = {
  region: 'us-east-1',
  instanceType: 't3.micro',
  minCapacity: 1,
  maxCapacity: 2
};

// configs/prd.ts
export const prdConfig = {
  region: 'us-east-1',
  instanceType: 't3.large',
  minCapacity: 2,
  maxCapacity: 10
};
```

## 🚦 Deployment Workflow

1. **Development** - Deploy and test infrastructure changes in dev environment
2. **Validation** - Promote changes to validation environment for testing
3. **Production** - Deploy validated changes to production environment
4. **Monitoring** - Track infrastructure health and performance

## 📄 License

UNLICENSED - Free to use for any purpose

---

<p align="center">
  <em>Happy coding! 🎉</em>
</p>
