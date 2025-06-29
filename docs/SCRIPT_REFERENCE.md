# Script Reference Guide

Quick reference for all available npm scripts in the AWS Pulumi Infrastructure project.

## 🚀 Quick Start Scripts

| Script | Description |
|--------|-------------|
| `npm run dev` | Quick development preview of all infrastructure |
| `npm run deploy:dev` | Deploy everything to development environment |
| `npm run test` | Run all infrastructure tests |

## 📋 All Available Scripts

### Core Development (8 scripts)

```bash
npm run dev              # Quick development preview
npm run start            # Alias for 'dev'
npm run build            # Compile TypeScript
npm run clean            # Clean build artifacts
npm run test             # Run tests
npm run test:watch       # Run tests in watch mode
npm run test:cov         # Run tests with coverage
npm run test:e2e         # Run end-to-end tests
npm run lint             # Check and fix code quality
npm run format           # Format code with Prettier
npm run setup            # Set up development environment
npm run validate         # Validate project setup
npm run start:prod       # Run compiled application
```

### Environment Operations (9 scripts)

```bash
# Deploy to environments
npm run deploy:dev       # Deploy all layers to development
npm run deploy:val       # Deploy all layers to validation  
npm run deploy:prd       # Deploy all layers to production

# Destroy environments
npm run destroy:dev      # Destroy all layers in development
npm run destroy:val      # Destroy all layers in validation
npm run destroy:prd      # Destroy all layers in production

# Preview changes
npm run preview:dev      # Preview changes in development
npm run preview:val      # Preview changes in validation
npm run preview:prd      # Preview changes in production
```

### Specialized Operations (4 scripts)

```bash
npm run deploy:foundation    # Deploy account baseline + networking
npm run deploy:platform      # Deploy foundation + services + data
npm run destroy:platform     # Destroy platform components only
npm run deploy:multi-region  # Deploy across multiple regions
```

## 🎯 Common Usage Patterns

### Daily Development

```bash
# Quick development workflow
npm run dev                    # Preview infrastructure
npm run deploy:dev            # Deploy to dev environment
npm run test                  # Validate infrastructure
```

### Environment Promotion

```bash
# Standard promotion workflow
npm run deploy:dev   →   npm run deploy:val   →   npm run deploy:prd
```

### Incremental Deployment

```bash
npm run deploy:foundation     # First: account + network
npm run deploy:platform       # Then: + services + data
# Finally: deploy workloads via custom command
npx ts-node src/index.ts deploy dev --scope workload --regions us-east-1
```

### Testing & Quality

```bash
npm run test                  # Unit tests
npm run test:cov             # Coverage report
npm run test:e2e             # End-to-end tests
npm run lint                 # Code quality
npm run format               # Code formatting
```

## 🛠️ Custom Orchestration

For advanced scenarios, use the orchestrator directly:

```bash
# Custom layer deployment
npx ts-node src/index.ts deploy ENV --scope LAYERS --regions REGIONS

# Examples:
npx ts-node src/index.ts deploy prd --scope acct-baseline,net-foundation --regions us-east-1
npx ts-node src/index.ts preview val --scope svc-platform,workload --regions us-east-1,us-west-2
npx ts-node src/index.ts destroy dev --scope workload --regions us-east-1
```

### Available Parameters

- **ENV**: `dev`, `val`, `prd`
- **LAYERS**: `acct-baseline`, `net-foundation`, `svc-platform`, `stateful-data`, `workload`
- **REGIONS**: `us-east-1`, `us-west-2`, `eu-west-1` (comma-separated)

## 📊 Script Comparison

| Task | Old (80+ scripts) | New (26 scripts) |
|------|-------------------|------------------|
| Deploy all to dev | `deploy:all:dev` | `deploy:dev` |
| Individual layer | `deploy:layer:env` | Custom orchestrator |
| Multi-environment | 15 scripts per action | 3 scripts per action |
| Foundation only | `deploy:foundation:env` | `deploy:foundation` |

## 💡 Pro Tips

1. **Use `npm run dev`** for quick infrastructure previews during development
2. **Use environment-specific scripts** (`deploy:dev`, `deploy:val`, `deploy:prd`) for standard deployments
3. **Use specialized scripts** (`deploy:foundation`, `deploy:platform`) for incremental deployments
4. **Use the orchestrator directly** for custom scenarios and CI/CD pipelines
5. **Always run tests** after infrastructure changes with `npm run test`

## 🔗 Related Documentation

- [Software Architecture](./SOFTWARE_ARCHITECTURE.md) - Layered architecture overview
- [Main README](../README.md) - Project overview and examples
- [Testing Architecture](./TESTING_ARCHITECTURE.md) - Testing strategies
