# Copilot Instructions for AWS Pulumi Infrastructure Repository

> **Note:** When updating this file, ensure that `AGENTS.md` is updated to reflect the same changes. Other than the title, the files should be the same.

## Project Overview

This is a comprehensive AWS infrastructure deployment solution using Pulumi, TypeScript, and GitHub Actions. It provides the ability to deploy full web application infrastructure to AWS leveraging a multi-stack architecture for different deployment lifecycles (dev, val, prd). All infrastructure is deployed to us-east-1 by default and follows AWS best practices.

### Key Technologies

- **TypeScript 5.7.3** - Main programming language with strict type checking
- **Pulumi** - Infrastructure as code using the Automation API
- **AWS SDK** - AWS service integrations and resource management
- **GitHub Actions** - CI/CD pipelines for automated infrastructure deployment
- **Jest 29.7.0** - Testing framework for infrastructure components
- **ESLint 9.18.0** - Code linting and quality enforcement
- **Prettier 3.4.2** - Code formatting

## Project Structure

```text
src/
├── index.ts           # Main Pulumi automation API entry point
├── components/       # Reusable AWS Pulumi components
│   ├── networking/   # VPC, subnets, security groups
│   ├── compute/      # ECS, EC2, load balancers
│   ├── storage/      # S3, RDS, ElastiCache
│   ├── monitoring/      # CloudWatch, alarms
│   └── index.ts   # Infrastructure component exports
├── stacks/          # Multi-stack definitions
└── utils/           # Infrastructure utility functions
    ├── helpers.ts   # General helper functions
    └── logger.ts    # Logging utilities

.github/workflows/   # GitHub Actions CI/CD pipelines
configs/            # Environment-based configurations
test/              # Infrastructure and component tests
├── *.spec.ts      # Unit tests for components
├── *.e2e.spec.ts  # End-to-end infrastructure tests
└── jest-e2e.json  # E2E test configuration

bin/               # Compiled JavaScript output
docs/              # Infrastructure documentation
```

## Coding Standards & Best Practices

### TypeScript Guidelines

- **Strict Mode**: Always use strict TypeScript settings (enabled in tsconfig.json)
- **Type Safety**: Prefer explicit types over `any`, use proper generics
- **Null Safety**: Use strict null checks, prefer optional chaining (`?.`)
- **Interfaces vs Types**: Use interfaces for object shapes, types for unions/primitives
- **Naming Conventions**:
    - Classes: PascalCase (`VpcComponent`, `EcsService`)
    - Functions/Variables: camelCase (`createVpc`, `isValid`)
    - Constants: UPPER_SNAKE_CASE (`DEFAULT_REGION`, `MAX_RETRY_ATTEMPTS`)
    - Files: kebab-case (`vpc-component.ts`) or camelCase (`vpcComponent.ts`)

### Infrastructure Organization

- **Reusability**: Create modular components that can be reused across stacks
- **Resource Tagging**: Apply consistent tagging strategy for cost tracking and compliance
- **Security First**: Follow AWS security best practices in all components
- **Documentation**: Use JSDoc comments for all infrastructure components

### File Structure Patterns

```typescript
// Standard infrastructure component structure
/**
 * AWS VPC Component - Creates and manages VPC infrastructure
 */

// Imports (external libraries first, then internal)
import * as aws from '@pulumi/aws';
import * as pulumi from '@pulumi/pulumi';
import { ComponentArgs } from '../types';

// Types and interfaces
interface VpcArgs extends ComponentConfig {
    cidrBlock: string;
    enableDnsHostnames?: boolean;
}

// Main component implementation
export class VpcComponent extends pulumi.ComponentResource {
    public readonly vpc: aws.ec2.Vpc;
    public readonly publicSubnets: aws.ec2.Subnet[];
    public readonly privateSubnets: aws.ec2.Subnet[];

    constructor(name: string, args: VpcArgs, opts?: pulumi.ComponentResourceOptions) {
        super('aws:networking:VpcComponent', name, {}, opts);

        // Implementation
    }
}

// Default export (if applicable)
export default VpcComponent;
```

// Default export (if applicable)
export default VpcComponent;

````

## Development Workflow

### Available Scripts

- `npm run deploy:dev` - Deploy development infrastructure to AWS
- `npm run deploy:val` - Deploy validation infrastructure to AWS
- `npm run deploy:prd` - Deploy production infrastructure to AWS
- `npm run destroy:dev` - Destroy development infrastructure
- `npm run destroy:val` - Destroy validation infrastructure
- `npm run preview` - Preview infrastructure changes before deployment
- `npm run test` - Run infrastructure component tests
- `npm run test:watch` - Run tests in watch mode
- `npm run test:cov` - Run tests with coverage
- `npm run test:e2e` - Run end-to-end infrastructure tests
- `npm run lint` - Run ESLint with auto-fix
- `npm run format` - Format code with Prettier

### Testing Strategy

- **Unit Tests**: Test individual AWS components in isolation
- **Integration Tests**: Test component interactions and dependencies
- **E2E Tests**: Test complete infrastructure stack deployments
- **Coverage Target**: Aim for >80% code coverage
- **Test Naming**: Describe infrastructure behavior, not implementation

```typescript
// Good infrastructure test naming
describe('VpcComponent', () => {
    it('should create VPC with correct CIDR block', () => {
        // ...
    });

    it('should create public and private subnets in multiple AZs', () => {
        // ...
    });

    it('should throw error when invalid CIDR block provided', () => {
        // ...
    });
});
````

## Code Generation Guidelines

### When Creating New Infrastructure

1. **Components**: Create in `src/components/` with proper AWS resource management
2. **Stacks**: Create in `src/stacks/` for environment-specific deployments
3. **Configs**: Create in `configs/` for environment-based configuration
4. **Utils**: Create in `src/utils/` for reusable infrastructure functions
5. **Tests**: Mirror src structure in test/ directory

### Component Structure Template

```typescript
/**
 * AWS ECS Service Component - Manages containerized application deployment
 */
export class EcsServiceComponent extends pulumi.ComponentResource {
    public readonly service: aws.ecs.Service;
    public readonly taskDefinition: aws.ecs.TaskDefinition;
    public readonly targetGroup: aws.lb.TargetGroup;

    constructor(
        name: string,
        args: EcsServiceArgs,
        dependencies: EcsServiceDependencies,
        opts?: pulumi.ComponentResourceOptions,
    ) {
        super('aws:compute:EcsServiceComponent', name, {}, opts);

        this.taskDefinition = this.createTaskDefinition(config);
        this.targetGroup = this.createTargetGroup(config);
        this.service = this.createService(config, dependencies);

        this.registerOutputs({
            service: this.service,
            taskDefinition: this.taskDefinition,
            targetGroup: this.targetGroup,
        });
    }

    /**
     * Creates ECS task definition with container specifications
     */
    private createTaskDefinition(args: EcsServiceArgs): aws.ecs.TaskDefinition {
        // Implementation
    }

    private createTargetGroup(args: EcsServiceArgs): aws.lb.TargetGroup {
        // Implementation
    }

    private createService(args: EcsServiceArgs, deps: EcsServiceDependencies): aws.ecs.Service {
        // Implementation
    }
}
```

### Error Handling Patterns

```typescript
// Use custom error classes for infrastructure failures
export class InfrastructureError extends Error {
    constructor(resource: string, operation: string, cause?: Error) {
        super(`Failed to ${operation} ${resource}: ${cause?.message || 'Unknown error'}`);
        this.name = 'InfrastructureError';
    }
}

export class ValidationError extends Error {
    constructor(field: string, value: unknown, requirement: string) {
        super(`Invalid ${field}: ${value} (${requirement})`);
        this.name = 'ValidationError';
    }
}

// Handle infrastructure operations appropriately
try {
    const vpc = await createVpc(config);
    return vpc;
} catch (error) {
    logger.error('VPC creation failed', error);
    throw new InfrastructureError('VPC', 'create', error);
}
```

### Pulumi/AWS Best Practices

- Always use `pulumi.ComponentResource` for complex components
- Implement proper resource dependencies with `dependsOn`
- Use `registerOutputs()` for component outputs
- Handle AWS service limits and quotas gracefully
- Implement proper resource tagging for cost allocation
- Use AWS IAM least-privilege access principles

## Dependencies & Libraries

### Core Dependencies

- **@pulumi/pulumi**: Core Pulumi framework for infrastructure as code
- **@pulumi/aws**: AWS provider for Pulumi
- **@pulumi/automation**: Pulumi Automation API for programmatic deployments
- **aws-sdk**: AWS SDK for additional AWS service integrations
- **lodash**: Use for utility functions (deep merge, cloning configuration objects)

### Development Dependencies

- **@types/\***: Always install type definitions for libraries
- **jest**: Primary testing framework for infrastructure components
- **eslint**: Code quality and style enforcement
- **prettier**: Code formatting
- **@pulumi/policy**: Policy as code for infrastructure compliance

### Adding New Dependencies

1. Install with proper scope: `npm install package-name`
2. Add types if needed: `npm install --save-dev @types/package-name`
3. Update imports to follow project patterns
4. Add to appropriate tsconfig paths if needed
5. Consider AWS service limits and Pulumi provider compatibility

## Performance Considerations

- Use Pulumi resource options for parallel deployment where safe
- Implement proper resource dependencies to avoid circular references
- Use Pulumi outputs or System Manager parameters for cross-stack references
- Use Pulumi transformations for bulk resource modifications
- Consider AWS service limits when designing auto-scaling policies

## Security Guidelines

- Validate all infrastructure inputs using TypeScript interfaces
- Use AWS SecretManager Parameter Store for secrets management
- Follow AWS security best practices (encryption, IAM policies, VPC security)
- Implement least-privilege access principles for all resources
- Use AWS Security Groups with minimal required access
- Keep AWS provider and Pulumi dependencies updated

## Documentation Standards

- Use JSDoc comments for all infrastructure components
- Include examples in component documentation
- Keep README.md updated with new infrastructure capabilities
- Document breaking changes in commit messages
- Maintain infrastructure documentation in docs/ directory
- Include deployment runbooks and troubleshooting guides

## Git Workflow

- Use conventional commit messages (feat, fix, docs, refactor, etc.)
- Create feature branches for new infrastructure work
- **Run `npm test` and ensure all tests pass before committing or merging**
- **Run `npm run lint` and ensure there are no lint errors before committing or merging**
- Test infrastructure changes in development environment first
- Use meaningful commit messages that describe infrastructure changes
- Squash commits when appropriate for cleaner history

## Environment Setup

This project is designed to work in dev containers and includes:

- Pre-configured TypeScript environment optimized for Pulumi development
- AWS CLI, Pulumi CLI, and infrastructure tools
- Git, Docker CLI, and common development tools
- Debian-based container with modern tooling
- All necessary VS Code extensions for infrastructure development

## Additional Guidelines

- **JSDoc Comments**: All infrastructure components, interfaces, and methods must include clear and descriptive JSDoc comments with usage examples.
- **Infrastructure Validation**: Any infrastructure validation scripts created that are not tests should be removed after use to keep the repository clean.
- **Unit Tests**: Always add unit tests for new infrastructure components, bug fixes, and configuration changes to ensure infrastructure reliability.
- **Environment Variables**: Use AWS Systems Manager Parameter Store for environment-specific configuration. Document required parameters in environment-specific documentation.
- **Code Comments**: Provide detailed code comments wherever infrastructure logic is complex or not immediately clear, especially for AWS resource configurations and dependencies.
- **Cost Optimization**: Always consider AWS costs when designing infrastructure and include cost optimization strategies in component design.
- **Multi-Region Support**: Design components to be region-agnostic where possible, with us-east-1 as the default region.

When generating infrastructure code, always consider the existing patterns and maintain consistency with the established AWS architecture and Pulumi best practices.
