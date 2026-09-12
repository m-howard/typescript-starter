# Infrastructure inventory of record

These files declare **what is currently deployed** to the self-hosted runner
fleet. They are read by the maintenance collectors
([docs/maintenance/](../docs/maintenance/pipeline-overview.md)).

> They are **not** deployment manifests. Nothing here is applied to a cluster.
> Editing a version in this directory does not upgrade anything; it records
> that an upgrade happened.

## Why declarations rather than live queries

Pass 1 makes no live AWS or Kubernetes calls. The collectors read what is
committed here, which means the scan needs no credentials, runs offline,
produces reproducible output, and can run from any checkout. The cost is that
these files must be kept true by hand.

## Contents

| Path | Declares |
| --- | --- |
| `eks/cluster.yaml` | Cluster version, region, addon versions, node groups |
| `arc/gha-runner-scale-set-controller.values.yaml` | ARC controller chart version and image |
| `arc/gha-runner-scale-set.values.yaml` | Scale set chart version, runner image, scaling bounds |
| `images/runner.Dockerfile` | Runner image base and the tools baked into it |

The sample declarations land alongside the collectors that read them; until
then this directory holds only this file.

## Keeping them true

Update the relevant file **in the same change** that performs a fleet upgrade.
A stale declaration is worse than none: the scan will report drift against a
version that is no longer deployed, and real drift will hide behind it.

`eks/cluster.yaml` carries `lastReconciled`. If it is drifting from reality,
that is a process problem the collectors cannot detect — they can only compare
what is declared against what is published upstream.

## Required egress

The collectors reach these hosts. A restricted environment that blocks any of
them yields `unresolved` findings for the affected sources — degraded, but
never silently reported as healthy.

| Host | Used for |
| --- | --- |
| `registry.npmjs.org` | npm package versions and deprecation status |
| `api.github.com` | Action, chart and tool releases and tags |
| `ghcr.io` | ARC chart versions, runner image tags |
| `mcr.microsoft.com` | Microsoft-hosted base image tags |
| `registry-1.docker.io`, `auth.docker.io` | Docker Hub base image tags |

No AWS endpoint is required by default; the EKS support calendar is committed
in `maintenance.config.yaml`. It is only needed if the AWS CLI strategy is
enabled — see [ADR-0002](../docs/maintenance/adr/0002-eks-support-calendar.md).
