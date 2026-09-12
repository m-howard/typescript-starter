import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    DEFAULT_OUTPUT_PATH,
    USAGE,
    buildCollectors,
    collect,
    degradedResolutionWarning,
    describeEnvironment,
    exitCodeFor,
    parseCliOptions,
} from '../src/maintenance/cli';
import { MaintenanceReport, MaintenanceReportSchema, Severity } from '../src/maintenance/schema';
import { ConfigError } from '../src/maintenance/errors';
import { LogLevel } from '../src/utils/logger';
import { RecordingLogger } from './support/maintenance-fakes';

const CONFIG = [
    'version: 1',
    'defaults:',
    '    offline: true',
    'collectors:',
    '    npm:',
    '        enabled: true',
    '        runOutdated: false',
    '        runAudit: false',
    '    githubActions:',
    '        enabled: true',
    '        workflows:',
    '            - .github/workflows/ci.yml',
].join('\n');

const WORKFLOW = [
    'name: CI',
    'on: [push]',
    'jobs:',
    '  build:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - uses: actions/checkout@v4',
].join('\n');

const MANIFEST = JSON.stringify(
    { name: 'fixture', version: '1.0.0', dependencies: { lodash: '^4.17.21' } },
    null,
    4,
);

/** A throwaway checkout the CLI can be pointed at. */
async function scratchRepo(config = CONFIG): Promise<string> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'maintenance-cli-'));
    await fs.mkdir(path.join(root, '.github', 'workflows'), { recursive: true });
    await fs.writeFile(path.join(root, 'maintenance.config.yaml'), config, 'utf8');
    await fs.writeFile(path.join(root, 'package.json'), MANIFEST, 'utf8');
    await fs.writeFile(path.join(root, '.github/workflows/ci.yml'), WORKFLOW, 'utf8');
    return root;
}

const report = (severities: Severity[]): MaintenanceReport =>
    ({
        findings: severities.map((severity) => ({ severity: { severity } })),
    }) as MaintenanceReport;

describe('parseCliOptions', () => {
    describe('defaults', () => {
        it('should fall back to the committed inventory and the ignored output path', () => {
            expect(parseCliOptions([])).toEqual({
                configPath: 'maintenance.config.yaml',
                outPath: DEFAULT_OUTPUT_PATH,
                collectors: undefined,
                offline: false,
                logLevel: LogLevel.INFO,
                failOn: null,
                stdout: false,
                help: false,
            });
        });
    });

    describe('flags [REQ-CLI-001]', () => {
        it('should accept every documented flag', () => {
            expect(
                parseCliOptions([
                    '--config',
                    'other.yaml',
                    '--out',
                    'build/report.json',
                    '--collectors',
                    'npm,images',
                    '--offline',
                    '--log-level',
                    'debug',
                    '--fail-on',
                    'high',
                    '--stdout',
                ]),
            ).toMatchObject({
                configPath: 'other.yaml',
                outPath: 'build/report.json',
                collectors: ['npm', 'images'],
                offline: true,
                logLevel: LogLevel.DEBUG,
                failOn: 'high',
                stdout: true,
            });
        });

        it('should tolerate spaces around a collector list', () => {
            expect(parseCliOptions(['--collectors', ' npm , eks ']).collectors).toEqual([
                'npm',
                'eks',
            ]);
        });

        it('should document every flag it accepts', () => {
            for (const flag of ['--config', '--out', '--collectors', '--offline', '--fail-on']) {
                expect(USAGE).toContain(flag);
            }
        });
    });

    describe('rejections', () => {
        it('should name an unrecognised flag rather than ignoring it [REQ-CLI-004]', () => {
            // A silently ignored `--offlien` would let a run reach the network.
            expect(() => parseCliOptions(['--offlien'])).toThrow(ConfigError);
            expect(() => parseCliOptions(['--offlien'])).toThrow(/offlien/);
        });

        it.each([
            ['an unknown collector', ['--collectors', 'npm,kubernetes'], /kubernetes/],
            ['an unknown log level', ['--log-level', 'chatty'], /chatty/],
            ['an unknown severity', ['--fail-on', 'catastrophic'], /catastrophic/],
        ])('should reject %s naming it', (_label, argv: string[], match: RegExp) => {
            expect(() => parseCliOptions(argv)).toThrow(match);
        });
    });
});

describe('exitCodeFor', () => {
    it('should exit zero however many findings there are [REQ-CLI-002]', () => {
        // A scheduled job that goes red every week because maintenance work exists is a
        // job people mute.
        expect(exitCodeFor(report(['critical', 'high', 'low']), null)).toBe(0);
    });

    it('should exit non-zero once a finding reaches the threshold [REQ-CLI-003]', () => {
        expect(exitCodeFor(report(['medium', 'high']), 'high')).toBe(1);
        expect(exitCodeFor(report(['critical']), 'high')).toBe(1);
    });

    it('should exit zero when nothing reaches the threshold', () => {
        expect(exitCodeFor(report(['medium', 'low', 'info']), 'high')).toBe(0);
        expect(exitCodeFor(report([]), 'critical')).toBe(0);
    });
});

describe('degradedResolutionWarning', () => {
    const withToken = <T>(value: string | undefined, run: () => T): T => {
        const previous = process.env.MAINTENANCE_TEST_TOKEN;
        if (value === undefined) {
            delete process.env.MAINTENANCE_TEST_TOKEN;
        } else {
            process.env.MAINTENANCE_TEST_TOKEN = value;
        }
        try {
            return run();
        } finally {
            if (previous === undefined) {
                delete process.env.MAINTENANCE_TEST_TOKEN;
            } else {
                process.env.MAINTENANCE_TEST_TOKEN = previous;
            }
        }
    };

    it('should say plainly that an offline run resolves nothing', () => {
        expect(degradedResolutionWarning(true, 'MAINTENANCE_TEST_TOKEN')).toContain('Offline mode');
    });

    it('should warn when no GitHub token is set [REQ-NET-026]', () => {
        // 60 requests an hour, and the failure mode looks exactly like a clean scan.
        const warning = withToken(undefined, () =>
            degradedResolutionWarning(false, 'MAINTENANCE_TEST_TOKEN'),
        );
        expect(warning).toContain('MAINTENANCE_TEST_TOKEN is not set');
    });

    it('should stay quiet when the run can resolve upstream', () => {
        expect(
            withToken('ghp_x', () => degradedResolutionWarning(false, 'MAINTENANCE_TEST_TOKEN')),
        ).toBeNull();
    });

    it('should prefer the offline warning when both apply', () => {
        expect(
            withToken(undefined, () => degradedResolutionWarning(true, 'MAINTENANCE_TEST_TOKEN')),
        ).toContain('Offline mode');
    });
});

describe('buildCollectors', () => {
    it('should assemble all five collectors', () => {
        expect(buildCollectors().map((collector) => collector.id)).toEqual([
            'npm',
            'github-actions',
            'arc',
            'eks',
            'images',
        ]);
    });
});

describe('describeEnvironment [REQ-RPT-006]', () => {
    it('should record the runtime and carry the offline flag through', () => {
        const environment = describeEnvironment(true);
        expect(environment.runtime).toMatchObject({
            node: process.version,
            platform: `${process.platform}-${process.arch}`,
            offline: true,
        });
        expect(environment.repository.name.length).toBeGreaterThan(0);
    });
});

describe('collect', () => {
    let root: string;

    beforeEach(async () => {
        root = await scratchRepo();
    });

    afterEach(async () => {
        await fs.rm(root, { recursive: true, force: true });
    });

    it('should write a schema-valid report and exit zero [REQ-CLI-002]', async () => {
        const { report: written, exitCode } = await collect([], root, new RecordingLogger());
        expect(exitCode).toBe(0);
        expect(MaintenanceReportSchema.safeParse(written).success).toBe(true);

        const onDisk = JSON.parse(
            await fs.readFile(path.join(root, DEFAULT_OUTPUT_PATH), 'utf8'),
        ) as MaintenanceReport;
        expect(onDisk.generatedAt).toBe(written.generatedAt);
    });

    it('should account for every collector, running only the configured ones', async () => {
        const { report: written } = await collect([], root, new RecordingLogger());
        expect(written.collectorRuns.map((run) => `${run.collector}=${run.status}`)).toEqual([
            'npm=partial',
            'github-actions=partial',
            'arc=skipped',
            'eks=skipped',
            'images=skipped',
        ]);
    });

    it('should limit the run to the selected collectors [REQ-CLI-006]', async () => {
        const { report: written } = await collect(
            ['--collectors', 'npm'],
            root,
            new RecordingLogger(),
        );
        const actions = written.collectorRuns.find((run) => run.collector === 'github-actions');
        expect(actions).toMatchObject({ status: 'skipped' });
        expect(actions?.skippedReason).toContain('Not selected');
    });

    it('should make no outbound request in offline mode [REQ-NET-020]', async () => {
        const { report: written } = await collect([], root, new RecordingLogger());
        // The config sets offline, so every lookup is refused at the seam and every
        // finding says so rather than reporting no drift.
        expect(written.runtime.offline).toBe(true);
        expect(written.summary.worstStatus).toBe('partial');
        // Everything that needed an upstream is unresolved. `action-unpinned` is the
        // exception: pinning is a property of the reference, so there was nothing to ask.
        const needingUpstream = written.findings.filter(
            (finding) => finding.latestResolution.status !== 'not-applicable',
        );
        expect(needingUpstream.length).toBeGreaterThan(0);
        expect(needingUpstream.every((finding) => finding.unresolved)).toBe(true);
    });

    it('should warn plainly when the run is offline', async () => {
        const logger = new RecordingLogger();
        await collect([], root, logger);
        expect(logger.at('warn')[0]).toContain('Offline mode');
    });

    it('should write to a caller-chosen path', async () => {
        await collect(['--out', 'build/scan.json'], root, new RecordingLogger());
        await expect(fs.stat(path.join(root, 'build/scan.json'))).resolves.toBeDefined();
    });

    it('should silence non-error logging when writing to standard output [REQ-CLI-005]', async () => {
        const logger = new RecordingLogger();
        const written: string[] = [];
        const write = jest
            .spyOn(process.stdout, 'write')
            .mockImplementation((chunk: string | Uint8Array) => {
                written.push(String(chunk));
                return true;
            });
        try {
            await collect(['--stdout'], root, logger);
        } finally {
            write.mockRestore();
        }
        // Winston writes info and debug to stdout, so anything below error would leave
        // the stream invalid JSON.
        expect(logger.at('info')).toEqual([]);
        expect(logger.at('warn')).toEqual([]);
        expect(() => JSON.parse(written.join(''))).not.toThrow();
    });

    it('should exit non-zero when a finding reaches the threshold [REQ-CLI-003]', async () => {
        const { exitCode } = await collect(['--fail-on', 'info'], root, new RecordingLogger());
        expect(exitCode).toBe(1);
    });

    it('should surface a missing configuration rather than writing a report [REQ-CFG-003]', async () => {
        await expect(
            collect(['--config', 'nope.yaml'], root, new RecordingLogger()),
        ).rejects.toThrow(/nope\.yaml/);
    });
});
