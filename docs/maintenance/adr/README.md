# Architecture decision records

One record per decision that could genuinely have gone the other way. Each
states the context, the decision, its consequences, and — the part that matters
most later — **what would reverse it**.

| # | Decision | Status |
| --- | --- | --- |
| [0001](./0001-package-json-authoritative.md) | `package.json` is authoritative for the npm declared set | Accepted |
| [0002](./0002-eks-support-calendar.md) | EKS latest from a committed support calendar | Accepted |
| [0003](./0003-two-hash-finding-identity.md) | Two-hash finding identity; fingerprint excludes version | Accepted |
| [0004](./0004-zod-single-source-of-truth.md) | Zod is the single source of truth for the contract | Accepted |
| [0005](./0005-no-globbing-in-file-provider.md) | `FileProvider` forbids globbing; inputs are declared | Accepted |
| [0006](./0006-deterministic-severity.md) | Severity is a deterministic rule table | Accepted |
| [0007](./0007-unresolved-is-first-class.md) | Unresolved is a first-class finding state | Accepted |
