/**
 * What a collector is given, and what it returns.
 *
 * `collect` returns findings **and** errors rather than a bare array. Without that a
 * half-working collector has nowhere to say so, and "unresolved is first-class" becomes
 * unimplementable (`docs/maintenance/adr/0007-unresolved-is-first-class.md`).
 */

import { Logger } from '../utils/logger';
import { Clock } from './clock';
import { CollectorError, CollectorId, Finding } from './schema';
import { MaintenanceConfig } from './schema/config';
import { FileProvider } from './providers/file-provider';
import { CommandRunner } from './exec/command-runner';
import { VersionSourceRegistry } from './sources';

export interface CollectorContext {
    readonly config: MaintenanceConfig;
    readonly files: FileProvider;
    readonly commands: CommandRunner;
    readonly sources: VersionSourceRegistry;
    readonly logger: Logger;
    readonly clock: Clock;
    /** True when no network call may be made. */
    readonly offline: boolean;
    /** Absolute path the collectors resolve relative paths against. */
    readonly repoRoot: string;
    /**
     * Repository-relative path of the configuration that declared this run.
     *
     * Carried so a finding about the configuration itself — a stale calendar, an expired
     * override, a collector that crashed — can point at a real file rather than carry
     * evidence invented for the occasion.
     */
    readonly configPath: string;
}

export interface CollectorOutput {
    findings: Finding[];
    errors: CollectorError[];
}

export interface Collector {
    readonly id: CollectorId;
    /** Whether the configuration asks for this collector at all. */
    isEnabled(config: MaintenanceConfig): boolean;
    collect(ctx: CollectorContext): Promise<CollectorOutput>;
}

/** An empty result, so a collector can return early without constructing one. */
export function emptyOutput(): CollectorOutput {
    return { findings: [], errors: [] };
}
