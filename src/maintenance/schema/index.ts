/**
 * The maintenance schema contract.
 *
 * Zod is the single source of truth: TypeScript types come from `z.infer`, and the
 * published JSON Schema is emitted from these same definitions
 * (`docs/maintenance/adr/0004-zod-single-source-of-truth.md`).
 */

export * from './common';
export * from './collector-run';
export * from './finding';
export * from './enriched-finding';
export * from './report';
