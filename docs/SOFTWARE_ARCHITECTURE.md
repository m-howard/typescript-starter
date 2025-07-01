# Pulumi Software Architecture

This document outlines the complete software architecture design for an infrastructure system using Pulumi Automation API. It provides a modular and layered approach to manage infrastructure in AWS using well-scoped projects, logical separation of responsibilities, and support for environment-specific deployments.

---

## 🔧 Design Principles

- **Modularity**: Separate infrastructure concerns across clearly defined projects.
- **Least Privilege**: Scope stack permissions and updates to the smallest possible blast radius.
- **Layered Dependency**: Projects are applied in strict top-down order and destroyed bottom-up.
- **Blue/Green Ready**: Application and compute stacks are designed for zero-downtime switchovers.
- **Automation-Friendly**: Driven by Pulumi Automation API for CI/CD orchestration.

---

## 🗂️ Projects Overview

| Project File     | Purpose                                        | Scope           |
| ---------------- | ---------------------------------------------- | --------------- |
| `acct-baseline`  | Account-wide policies, roles, config rules     | Per AWS Account |
| `net-foundation` | VPC, subnets, gateways, endpoints, certs       | Per Region      |
| `svc-platform`   | Clusters, service mesh, platform observability | Per Region      |
| `stateful-data`  | Data storage systems                           | Per Region      |
| `workload`       | Application services & blue/green deployments  | Per Region      |

---

## 🧱 Stack Dependency Graph

```text
  acct-baseline
        ↓
net-foundation (region-specific)
        ↓
 ┌──────────────────┐
 ↓                  ↓
data-stateful    svc-platform
        ↓
     workload
```

> Each arrow indicates a dependency via `StackReference` (read-only).

---

## 🛠️ Automation API Orchestrator

A central `orchestrator` project uses the Pulumi Automation API to:

- Accept CLI arguments (`deploy|preview|destroy`, env, scope, regions)
- Determine rollout order
- Create/select stack for each project-layer
- Refresh, configure, and execute action
- Parallelize independent region stacks

### Sample CLI

```bash
node index.js deploy dev --scope svc-platform,workload --regions us-east-1
```

### Rollout Order (Creation)

```ts
['acct-baseline', 'net-foundation', 'svc-platform', 'data-stateful', 'workload'];
```

### Stack Naming Convention

```
<org>/<project>/<region>-<env>
```

Example: `acme/30-svc-platform/us-east-1-prd`

---

## 🔐 Secrets & Configuration

| Config Key         | Stored In         | Consumed By                |
| ------------------ | ----------------- | -------------------------- |
| `aws:region`       | All stacks        | Pulumi provider            |
| `dbMasterPassword` | 40-data-stateful  | 50-workload via output     |
| `vpcId`            | 20-net-foundation | Used by clusters & storage |

All secrets are encrypted using Pulumi’s secret provider.

---

## 🧪 Blue/Green Strategy

### Cluster-Level

- Duplicate entire cluster (EKS/ECS) in `30-svc-platform`
- Route traffic switch via ALB/NLB or Route53

### Service-Level

- Parameterize `color` (blue/green)
- Deploy both stacks
- Swap DNS/ALB
- Destroy stale color via `--target`

---

## 🚀 CI/CD Workflow (Example)

1. **Pull Request**:

    - Lint + Preview via Automation API
    - Scope to impacted layers

2. **Merge to Main**:

    - Run orchestrator with `deploy`
    - Blue/Green switch + health validation
    - Destroy stale resources

3. **Scheduled Weekly Jobs**:

    - Refresh + diff-only preview for `10-20` stable layers

---

## 🧭 Stack Tags

Each stack includes the following tags:

```ts
{
  env: 'prd',
  layer: '30-svc-platform',
  team: 'platform',
  costCentre: 'core-infra'
}
```

---

## ✅ Benefits

- Predictable deployments with minimal drift
- Fast iteration on services, slow change to foundational layers
- Isolated failure domains
- Team-level ownership mapping directly to project folders

---

## 🔄 Next Steps

1. Refactor existing projects into the five canonical folders
2. Update Automation API rollout strategy
3. Enforce stack naming and tagging policies
4. Integrate into CI/CD pipelines

---

For questions or enhancements, contact the platform team.
