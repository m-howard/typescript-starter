# 🧪 Pulumi Testing Architecture

## 📌 Objective

Establish a layered, robust testing architecture for infrastructure-as-code (IaC) deployed via Pulumi (TypeScript), targeting AWS. The goal is to detect logical errors, misconfigurations, regressions, and policy violations **before production deployment** using a fast-feedback, CI-integrated pipeline.

---

## 🔖 Test Strategy Overview

| Test Layer             | Purpose                                                 | Where It Runs                   | Key Tools                                         | Outcome Verified                |
| ---------------------- | ------------------------------------------------------- | ------------------------------- | ------------------------------------------------- | ------------------------------- |
| **Static Analysis**    | Catch syntax errors, lint violations, insecure packages | Local / CI                      | ESLint, TypeScript, `npm audit`, `tfsec`, `trivy` | Clean code and dependencies     |
| **Unit Tests**         | Validate logical correctness of IaC definitions         | Node.js (Mocked Pulumi runtime) | Jest + Pulumi Mocks (`runtime.setMocks`)          | Resource structure & properties |
| **Pre-Prod (Sandbox)** | Validate deployment and runtime behavior in AWS         | Real AWS sandbox account        | Pulumi Automation API, AWS SDK, InSpec, Conftest  | Live infrastructure integrity   |
| **End-to-End**         | Validate entire stack through user-facing interfaces    | Staging / production            | Cypress, Playwright, `k6`, Postman                | Application-level SLOs          |

---

## 🗂 Directory Structure

```
infra/
├── Pulumi.yaml
├── src/
│   ├── index.ts
│   └── components/
│       └── vpc.ts
├── policy/
│   └── tagRequired.ts
├── test/
│   ├── unit/
│   │   └── vpc.test.ts
│   └── e2e/
│       └── smoke.test.ts
├── .github/
│   └── workflows/
│       └── ci.yml
├── jest.config.ts
└── tsconfig.json
```

---

## 🔬 1. Unit Testing — Pulumi Mocks

### ✅ Purpose:

Verify that Pulumi resource code produces expected resources and configurations **without deploying**.

### 🛠 Tools:

- Jest
- `@pulumi/pulumi` mock runtime

### 🧪 Example:

```ts
pulumi.runtime.setMocks({
    newResource: ({ name, type, inputs }) => ({
        id: `${name}_id`,
        state: inputs,
    }),
    call: () => ({}),
});

test('VPC has 3 subnets', async () => {
    const vpc = await createVpc('test');
    const subnets = await vpc.subnetIds;
    expect(subnets.length).toBe(3);
});
```

---

## 🧪 2. Pre-Prod Testing — Sandbox Environment

### ✅ Purpose:

Full deployment to AWS in an **ephemeral, isolated** environment to run:

- Smoke tests
- Policy checks
- Security validations
- Performance budget testing

### 🛠 Tools:

- Pulumi Automation API
- AWS SDK (Node)
- `Conftest` + OPA
- `k6` for performance
- `InSpec` for compliance

### ✅ Workflow:

1. Deploy via Pulumi Automation API using CI
2. Run:
    - Resource status checks
    - Tag enforcement
    - Encryption validation
    - `k6` latency tests
3. Auto-destroy stack on success/fail

---

## 🔐 3. Policy as Code (CrossGuard)

### ✅ Purpose:

Block unsafe infrastructure _before_ deployment.

### 🛠 Tools:

- Pulumi CrossGuard (TypeScript)
- OPA + `Conftest` (for CloudFormation output)

### 🧪 Example (CrossGuard):

```ts
policy('requireTags', async (policyArgs, reportViolation) => {
    if (!policyArgs.resource.tags || !policyArgs.resource.tags['Owner']) {
        reportViolation("Resource must have an 'Owner' tag.");
    }
});
```

---

## 🚦 4. CI/CD Integration

### ✅ GitHub Actions Workflow

```yaml
name: Infra CI

on: [push, pull_request]

jobs:
    lint-test:
        runs-on: ubuntu-latest
        steps:
            - uses: actions/checkout@v4
            - uses: actions/setup-node@v4
              with: { node-version: 20 }
            - run: npm ci
            - run: npm run lint
            - run: npm test

    deploy-sandbox:
        runs-on: ubuntu-latest
        needs: lint-test
        env:
            PULUMI_ACCESS_TOKEN: ${{ secrets.PULUMI_ACCESS_TOKEN }}
            AWS_ACCESS_KEY_ID: ${{ secrets.AWS_SANDBOX_KEY }}
            AWS_SECRET_ACCESS_KEY: ${{ secrets.AWS_SANDBOX_SECRET }}
        steps:
            - uses: actions/checkout@v4
            - run: npm ci
            - run: ts-node .github/scripts/deploy-sandbox.ts
```

---

## ✅ Best Practices

- ✅ **Mock all external dependencies** during unit tests
- ✅ **Isolate stacks per test** with randomised names
- ✅ **Clean up stacks after every run**
- ✅ **Enforce tagging and encryption policies**
- ✅ **Run smoke + compliance tests in real AWS**
- ✅ **Block merges unless all layers pass**

---

## 🏁 Summary

| Test Type    | Speed   | Confidence | Cost    |
| ------------ | ------- | ---------- | ------- |
| Unit (Mocks) | 🟢 Fast | 🔸 Medium  | 🟢 Free |
| AWS Sandbox  | 🔴 Slow | 🟢 High    | 🔴 Paid |
| E2E UI/API   | 🔴 Slow | 🟢 Highest | 🔴 Paid |

This layered test architecture ensures **rapid feedback**, **secure deployments**, and **policy compliance** for Pulumi-managed AWS infrastructure.
