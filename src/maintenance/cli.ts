/**
 * `maintenance:collect` — the collect stage's entry point.
 *
 * Argument parsing, wiring and exit codes only; everything worth testing lives in
 * `runner.ts` and the collectors, and the `require.main` block at the bottom stays a
 * few lines so nothing untestable accumulates in it.
 *
 * The exit code deserves a note. Findings do **not** fail the run: a scheduled job that
 * goes red every week because maintenance work exists is a job people mute, and the
 * whole design assumes somebody still reads the report. A red job means the *tool*
 * broke. `--fail-on` exists for the caller who wants a gate anyway, and it is opt-in
 * (REQ-CLI-002, REQ-CLI-003).
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import { parseArgs } from 'util';
import { Logger, LogLevel } from '../utils/logger';
import { SystemClock } from './clock';
import { DEFAULT_CONFIG_PATH, loadConfig } from './config/load-config';
import { LocalFsProvider } from './providers/local-fs-provider';
import { FetchHttpClient } from './http/http-client';
import { OfflineHttpClient } from './http/offline-http-client';
import { CommandRunner, ExecFileCommandRunner } from './exec/command-runner';
import { OfflineCommandRunner } from './exec/offline-command-runner';
import { buildDefaultSourceRegistry } from './sources';
import { HttpClient } from './http/http-client';
import { ArcCollector } from './collectors/arc';
import { EksCollector } from './collectors/eks';
import { GithubActionsCollector } from './collectors/github-actions';
import { ImagesCollector } from './collectors/images';
import { NpmCollector } from './collectors/npm';
import { RunEnvironment, runCollectors } from './runner';
import { Collector, CollectorContext } from './types';
import {
    COLLECTOR_IDS,
    CollectorId,
    MaintenanceReport,
    SEVERITY_RANK,
    Severity,
    SeveritySchema,
} from './schema';
import { ConfigError, toMaintenanceError } from './errors';

/** Where a report lands when `--out` is not given. */
export const DEFAULT_OUTPUT_PATH = '.maintenance/report.json';

const OPTIONS = {
    config: { type: 'string' },
    out: { type: 'string' },
    collectors: { type: 'string' },
    offline: { type: 'boolean' },
    'log-level': { type: 'string' },
    'fail-on': { type: 'string' },
    stdout: { type: 'boolean' },
    help: { type: 'boolean' },
} as const;

export interface CliOptions {
    configPath: string;
    outPath: string;
    collectors: CollectorId[] | undefined;
    offline: boolean;
    logLevel: LogLevel;
    failOn: Severity | null;
    stdout: boolean;
    help: boolean;
}

export const USAGE = [
    'Usage: maintenance collect [options]',
    '',
    `  --config <path>       Inventory to read (default: ${DEFAULT_CONFIG_PATH})`,
    `  --out <path>          Where to write the report (default: ${DEFAULT_OUTPUT_PATH})`,
    `  --collectors <list>   Comma-separated subset of: ${COLLECTOR_IDS.join(', ')}`,
    '  --offline             Make no network request; every lookup reports unresolved',
    '  --log-level <level>   debug, info, warn or error (default: info)',
    '  --fail-on <severity>  Exit non-zero when a finding reaches this severity',
    '  --stdout              Write the report to standard output instead of a file',
    '  --help                Show this message',
].join('\n');

/**
 * Parse the command line.
 *
 * `strict` is what turns an unrecognised flag into an error naming it; without it a
 * mistyped `--offlien` would be silently ignored and the run would quietly reach the
 * network (REQ-CLI-004).
 */
export function parseCliOptions(argv: readonly string[]): CliOptions {
    let values: Record<string, string | boolean | undefined>;
    try {
        ({ values } = parseArgs({ args: [...argv], options: OPTIONS, strict: true }));
    } catch (error: unknown) {
        throw new ConfigError(toMaintenanceError(error).message, { target: argv.join(' ') });
    }

    return {
        configPath: asString(values.config) ?? DEFAULT_CONFIG_PATH,
        outPath: asString(values.out) ?? DEFAULT_OUTPUT_PATH,
        collectors: parseCollectors(asString(values.collectors)),
        offline: values.offline === true,
        logLevel: parseLogLevel(asString(values['log-level'])),
        failOn: parseSeverity(asString(values['fail-on'])),
        // Winston writes info and debug to stdout, so a report on stdout must silence
        // everything below error or the stream stops being valid JSON (REQ-CLI-005).
        stdout: values.stdout === true,
        help: values.help === true,
    };
}

export interface CollectResult {
    report: MaintenanceReport;
    exitCode: number;
}

/**
 * Load the inventory, run the collectors, write the report.
 *
 * Takes the working directory and a logger rather than reading `process` itself, so the
 * whole path is exercisable from a spec.
 */
export async function collect(
    argv: readonly string[],
    repoRoot: string,
    logger: Logger,
): Promise<CollectResult> {
    const options = parseCliOptions(argv);
    if (options.stdout) {
        logger.setLogLevel(LogLevel.ERROR);
    } else {
        logger.setLogLevel(options.logLevel);
    }

    const files = new LocalFsProvider(repoRoot);
    const loaded = await loadConfig(files, options.configPath);
    const offline = options.offline || loaded.config.defaults.offline;
    const clock = new SystemClock();

    const warning = degradedResolutionWarning(offline, loaded.config.sources.github.tokenEnv);
    if (warning !== null) {
        logger.warn(warning);
    }

    const context: CollectorContext = {
        config: loaded.config,
        files,
        commands: buildCommandRunner(offline, clock),
        sources: buildDefaultSourceRegistry({
            http: buildHttpClient(offline, loaded, clock),
            npmRegistryUrl: loaded.config.sources.npm.registryUrl,
            githubApiBaseUrl: loaded.config.sources.github.apiBaseUrl,
        }),
        logger,
        clock,
        offline,
        repoRoot,
        configPath: loaded.path,
    };

    const report = await runCollectors({
        collectors: buildCollectors(),
        context,
        config: loaded,
        environment: describeEnvironment(offline),
        selected: options.collectors,
    });

    await writeReport(report, options, repoRoot, logger);
    logger.info(
        `Collected ${report.summary.totalFindings} findings ` +
            `(${report.summary.unresolvedCount} unresolved, worst run ${report.summary.worstStatus}).`,
    );
    return { report, exitCode: exitCodeFor(report, options.failOn) };
}

/**
 * The warning to print at startup when this run cannot establish upstream truth, or
 * null when it can.
 *
 * Worth saying out loud because both cases fail the same quiet way: a scan that
 * resolved nothing looks exactly like a scan that found nothing wrong, and only the
 * `unresolved` counts distinguish them (REQ-NET-022, REQ-NET-026).
 */
export function degradedResolutionWarning(offline: boolean, tokenEnv: string): string | null {
    if (offline) {
        return (
            'Offline mode: no upstream will be consulted, so every finding is reported ' +
            'as unresolved rather than as up to date.'
        );
    }
    if (process.env[tokenEnv] === undefined) {
        return (
            `${tokenEnv} is not set. The GitHub API allows 60 requests an hour ` +
            'unauthenticated, so some findings will be unresolved.'
        );
    }
    return null;
}

/** Every collector, in the order they appear in the report. */
export function buildCollectors(): Collector[] {
    return [
        new NpmCollector(),
        new GithubActionsCollector(),
        new ArcCollector(),
        new EksCollector(),
        new ImagesCollector(),
    ];
}

/**
 * Zero unless a threshold was given and something met it.
 *
 * The default is deliberate: the run succeeded, and how much maintenance work exists is
 * the report's business rather than the exit code's (REQ-CLI-002, REQ-CLI-003).
 */
export function exitCodeFor(report: MaintenanceReport, failOn: Severity | null): number {
    if (failOn === null) {
        return 0;
    }
    const threshold = SEVERITY_RANK[failOn];
    return report.findings.some((finding) => SEVERITY_RANK[finding.severity.severity] >= threshold)
        ? 1
        : 0;
}

/** What the report records about the machine it ran on (REQ-RPT-006). */
export function describeEnvironment(offline: boolean): RunEnvironment {
    return {
        repository: {
            name: path.basename(process.cwd()),
            owner: process.env.GITHUB_REPOSITORY_OWNER ?? null,
            commitSha: process.env.GITHUB_SHA ?? null,
            ref: process.env.GITHUB_REF ?? null,
        },
        runtime: {
            node: process.version,
            npm: process.env.npm_config_user_agent ?? null,
            platform: `${process.platform}-${process.arch}`,
            offline,
        },
    };
}

/**
 * Offline stops commands as well as requests.
 *
 * Every command this stage runs reaches the network, so leaving the real runner in
 * place would let `--offline` quietly half-apply (REQ-NET-020).
 */
function buildCommandRunner(offline: boolean, clock: SystemClock): CommandRunner {
    return offline ? new OfflineCommandRunner() : new ExecFileCommandRunner(clock);
}

function buildHttpClient(
    offline: boolean,
    loaded: Awaited<ReturnType<typeof loadConfig>>,
    clock: SystemClock,
): HttpClient {
    if (offline) {
        return new OfflineHttpClient();
    }
    return new FetchHttpClient({
        clock,
        timeoutMs: loaded.config.defaults.httpTimeoutMs,
        retries: loaded.config.defaults.httpRetries,
        githubToken: process.env[loaded.config.sources.github.tokenEnv] ?? null,
    });
}

async function writeReport(
    report: MaintenanceReport,
    options: CliOptions,
    repoRoot: string,
    logger: Logger,
): Promise<void> {
    const serialised = `${JSON.stringify(report, null, 4)}\n`;
    if (options.stdout) {
        process.stdout.write(serialised);
        return;
    }
    const target = path.resolve(repoRoot, options.outPath);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, serialised, 'utf8');
    logger.info(`Wrote ${options.outPath}`);
}

function parseCollectors(value: string | undefined): CollectorId[] | undefined {
    if (value === undefined) {
        return undefined;
    }
    const requested = value
        .split(',')
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);
    const unknown = requested.filter((entry) => !isCollectorId(entry));
    if (unknown.length > 0) {
        throw new ConfigError(
            `Unknown collector: ${unknown.join(', ')}. Known: ${COLLECTOR_IDS.join(', ')}.`,
            { target: value },
        );
    }
    return requested as CollectorId[];
}

function parseLogLevel(value: string | undefined): LogLevel {
    if (value === undefined) {
        return LogLevel.INFO;
    }
    const levels = Object.values(LogLevel) as string[];
    if (!levels.includes(value)) {
        throw new ConfigError(`Unknown log level: ${value}. Known: ${levels.join(', ')}.`, {
            target: value,
        });
    }
    return value as LogLevel;
}

function parseSeverity(value: string | undefined): Severity | null {
    if (value === undefined) {
        return null;
    }
    const parsed = SeveritySchema.safeParse(value);
    if (!parsed.success) {
        throw new ConfigError(
            `Unknown severity: ${value}. Known: ${SeveritySchema.options.join(', ')}.`,
            { target: value },
        );
    }
    return parsed.data;
}

function isCollectorId(value: string): value is CollectorId {
    return (COLLECTOR_IDS as readonly string[]).includes(value);
}

function asString(value: string | boolean | undefined): string | undefined {
    return typeof value === 'string' ? value : undefined;
}

/* istanbul ignore next -- entry point; collect() carries the logic and the tests. */
if (require.main === module) {
    const logger = new Logger();
    const args = process.argv.slice(2).filter((argument) => argument !== 'collect');
    if (args.includes('--help')) {
        process.stdout.write(`${USAGE}\n`);
    } else {
        collect(args, process.cwd(), logger)
            .then((result) => {
                process.exitCode = result.exitCode;
            })
            .catch((error: unknown) => {
                logger.error('The maintenance scan failed', toMaintenanceError(error));
                process.exitCode = 2;
            });
    }
}
