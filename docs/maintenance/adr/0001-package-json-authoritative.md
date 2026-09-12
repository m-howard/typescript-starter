# ADR-0001 — `package.json` is authoritative for the npm declared set

**Status:** Accepted · **Date:** 2026-09-12 · **Relates to:** REQ-NPM-010, REQ-NPM-014, REQ-NPM-018

## Context

The npm collector needs two different things: the set of dependencies this
project declares, and the latest version of each. `npm outdated --json` looks
like it provides both.

Probing showed it does not. With dependencies installed it reports 27 of 34
declared packages; the 7 absent ones are simply already at latest. It is a
**diff, not an inventory**:

- A package at its latest version does not appear at all, so the output can
  never enumerate what is declared.
- Its contents depend on the installed tree. The same command run without
  `node_modules` returned a different, smaller set.
- `--all` returns a different set again — 420 transitive packages.

An earlier probe run without `node_modules` suggested the tool omitted all
`devDependencies`. That was an artefact of the missing install, not a property
of the tool, and it is recorded in the research document so the wrong reason
does not outlive the right decision.

## Decision

Read the declared dependency set — names and scope — from `package.json` via
the `FileProvider`. Treat `npm outdated --json --long` as **enrichment only**
for the packages it happens to report, and resolve latest versions for
everything else from the npm registry.

## Consequences

- The collector behaves identically whether or not `node_modules` is populated,
  which makes it usable in a fresh checkout and reproducible in CI.
- `package.json` also supplies the line number that file evidence needs.
- Scope comes from the manifest section a package sits in; `--long`'s `type`
  field is a cross-check rather than the source.
- More registry requests than a pure `npm outdated` approach, mitigated by
  per-run memoisation.
- Transitive dependencies are out of scope for *outdated* findings; they are
  still covered for advisories through `npm audit`, which is the right split —
  you upgrade a direct dependency to fix a transitive one.

## What would reverse this

An npm command that reports the full declared set with scope in one call,
independent of the installed tree. `npm ls --json --depth=0` is close but
likewise reflects installation state rather than declaration.
