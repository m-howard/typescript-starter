# GitHub Actions Workflow Documentation

This document describes the automated workflows for CI/CD and infrastructure management in this repository, as implemented in `.github/workflows/`.


## Prerequisites & Setup

Before running these workflows, ensure the following are set up in your repository and AWS account:

- **GitHub Secrets:**
    - `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`: Required for deploy and drift-detection jobs (with sufficient permissions for all managed resources).
    - `AWS_ACCESS_KEY_ID_READONLY`, `AWS_SECRET_ACCESS_KEY_READONLY`: Required for infrastructure validation jobs (read-only permissions).
    - `PULUMI_ACCESS_TOKEN`: Required for Pulumi operations (create at https://app.pulumi.com/account/tokens).
    - `PULUMI_BACKEND_URL`: S3 backend URL for Pulumi state (e.g., `s3://your-pulumi-state-bucket/dev-pulumi-state`).
    - `CODECOV_TOKEN`: For uploading test coverage reports (optional, but recommended).
- **GitHub Variables:**
    - `AWS_REGION`: (Optional) Override default AWS region (`us-east-1`).
    - `AWS_ROLE_ARN`: (Optional) IAM role to assume for deployments.
    - For multi-environment/role setups, define variables like `AWS_ROLE_ARN_DEV`, `AWS_ROLE_ARN_VAL`, etc.
- **AWS S3 Bucket:**
    - Create an S3 bucket for Pulumi state files. Ensure the bucket exists and is accessible by the provided AWS credentials.
    - Use separate prefixes or buckets for each environment (e.g., `dev-pulumi-state`, `val-pulumi-state`, `prd-pulumi-state`).
- **Repository Configuration:**
    - Ensure all referenced scripts (e.g., `npm run build`, `npm run destroy:dev`, `npm run preview:dev`, etc.) exist in your `package.json`.
    - TypeScript sources should be in `src/`, tests in `test/`, and infrastructure code should follow the documented structure.
- **IAM Permissions:**
    - AWS credentials must have permissions to create, update, and destroy all managed AWS resources, as well as access to the S3 backend bucket.
- **Codecov (Optional):**
    - If using Codecov for coverage, set up the `CODECOV_TOKEN` secret in your repository.

---

## Overview

The repository uses GitHub Actions to automate code quality checks, security scanning, testing, and AWS infrastructure deployment with Pulumi. The workflows are designed for a robust, multi-environment AWS IaC pipeline, supporting development (`dev`), validation (`val`), and production (`prd`) lifecycles.


## Workflows

### 1. Continuous Integration (`ci.yml`)

**Triggers:**
- On push or pull request to `main` or `develop` branches.

**Jobs:**
- **Lint:** Installs dependencies, builds TypeScript, runs ESLint and Prettier, and checks for uncommitted changes.
- **Security:** Runs `npm audit` for high-severity vulnerabilities.
- **Test:** Runs unit tests with coverage and uploads results to Codecov.
- **Infrastructure Validation:** On pull requests, installs Pulumi, configures AWS credentials (read-only), validates infrastructure templates, and runs a Pulumi preview for the `dev` environment.

### 2. Deployment (`deploy.yml`)

**Triggers:**
- On push to `main` or `develop`.
- Manually via `workflow_dispatch` (with environment, scope, regions, and destroy options).

**Jobs:**
- **Determine Environment:** Sets deployment environment (`dev`, `val`, `prd`) and Pulumi S3 backend URL based on branch or workflow input.
- **Deploy/Destroy:** Installs dependencies, builds, configures AWS credentials, logs into Pulumi S3 backend, and either deploys or destroys infrastructure using Pulumi Automation API. Runs E2E tests for `val` environment after deployment. Runs production health checks for `prd` after deployment. Comments on PRs for successful `dev` deployments.
- **Drift Detection:** On schedule or manual trigger, checks for infrastructure drift in all environments using Pulumi preview with `--expect-no-changes`.

### 3. Nightly Cleanup (`cleanup.yml`)

**Triggers:**
- Scheduled daily at 7 AM UTC.
- Manually via `workflow_dispatch` (with environment selection).

**Jobs:**
- **Destroy Pulumi Stacks:** For `dev` and `val` environments, installs dependencies, configures AWS credentials, logs into Pulumi S3 backend, and destroys all stacks for the environment.

## Key Features

- **Multi-Environment Support:** All workflows support `dev`, `val`, and `prd` environments, with separate Pulumi state backends.
- **Secure AWS Access:** Uses GitHub secrets and role assumption for AWS credentials.
- **Pulumi Automation:** Deploys, previews, and destroys infrastructure using Pulumi Automation API and S3 state backend.
- **Quality Gates:** Linting, formatting, security scanning, and comprehensive testing are enforced before deployment.
- **Drift Detection:** Automated checks for configuration drift to ensure infrastructure matches code.
- **PR Feedback:** Comments on pull requests after successful development deployments.

## Development & Deployment Flow

1. Code changes are pushed or PRs are opened against `main` or `develop`.
2. CI workflow runs lint, security, and test jobs.
3. Infrastructure validation runs on PRs, ensuring templates are valid and a Pulumi preview is successful.
4. Deployment workflow runs on merges to `main`/`develop` or manual triggers, deploying or destroying infrastructure as specified.
5. Nightly cleanup destroys non-production stacks to save costs and keep environments clean.
6. Drift detection runs on schedule or manually to alert on any configuration drift.

## Best Practices

- Always ensure all CI jobs pass before merging.
- Use workflow dispatch for manual deployments or destruction with custom parameters.
- Keep secrets and backend URLs up to date for all environments.
- Monitor workflow summaries for deployment status, drift, and health checks.
