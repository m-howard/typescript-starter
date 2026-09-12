import { promises as fs } from 'fs';
import * as path from 'path';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { LocalFsProvider } from '../src/maintenance/providers/local-fs-provider';
import { loadConfig } from '../src/maintenance/config/load-config';
import { buildDefaultSourceRegistry } from '../src/maintenance/sources';
import { buildCollectors, describeEnvironment } from '../src/maintenance/cli';
import { runCollectors } from '../src/maintenance/runner';
import { CollectorContext } from '../src/maintenance/types';
import { FixedClock } from '../src/maintenance/clock';
import { MaintenanceReport, MaintenanceReportSchema } from '../src/maintenance/schema';
import { FakeCommandRunner, FakeHttpClient, RecordingLogger } from './support/maintenance-fakes';

const REPO_ROOT = path.resolve(__dirname, '..');
const FIXTURES = path.join(__dirname, 'fixtures', 'maintenance');

/**
 * Upstream answers, chosen to be ahead of what this repository declares.
 *
 * Deliberately fixed rather than fetched: the point of this spec is that the *committed
 * files* produce real findings, and a live lookup would make the assertions drift with
 * whatever upstream shipped this morning.
 */
const GITHUB_RELEASES: Record<string, string> = {
    'actions/checkout': 'v5.1.0',
    'actions/setup-node': 'v4.4.0',
    'pulumi/pulumi': 'v3.201.0',
    'nodejs/node': 'v24.8.0',
    'kubernetes/kubernetes': 'v1.34.2',
    'helm/helm': 'v3.19.0',
    'aws/aws-cli': '2.31.4',
    'actions/upload-artifact': 'v7.0.1',
};

const OCI_TAGS: Record<string, string[]> = {
    'actions/actions-runner': ['2.320.0', '2.321.0', '2.331.0', 'latest'],
    'actions/actions-runner-controller-charts/gha-runner-scale-set-controller': [
        '0.10.1',
        '0.14.2',
    ],
    'actions/actions-runner-controller-charts/gha-runner-scale-set': ['0.10.1', '0.14.2'],
    'devcontainers/base': ['bullseye', 'bookworm', 'ubuntu', 'latest'],
};

/** Every npm package resolves one minor ahead of whatever the manifest asks for. */
function packument(declared: string): string {
    const core = /(\d+)\.(\d+)\.(\d+)/.exec(declared);
    const latest = core === null ? '9.9.9' : `${core[1]}.${Number(core[2]) + 1}.0`;
    return JSON.stringify({ 'dist-tags': { latest }, versions: { [latest]: {} } });
}

async function buildHttpClient(): Promise<FakeHttpClient> {
    const http = new FakeHttpClient();

    // The registry is asked about every declared dependency, so the fixture is derived
    // from the manifest rather than listed by hand — a dependency added to this project
    // must not silently turn this spec into a test of the unresolved path.
    const manifest = JSON.parse(
        await fs.readFile(path.join(REPO_ROOT, 'package.json'), 'utf8'),
    ) as { dependencies: Record<string, string>; devDependencies: Record<string, string> };
    for (const [name, range] of [
        ...Object.entries(manifest.dependencies),
        ...Object.entries(manifest.devDependencies),
    ]) {
        http.on(`https://registry.npmjs.org/${name.replace('/', '%2f')}`, {
            body: packument(range),
        });
    }

    for (const [repo, tag] of Object.entries(GITHUB_RELEASES)) {
        http.on(`https://api.github.com/repos/${repo}/releases/latest`, {
            body: JSON.stringify({ tag_name: tag }),
        });
    }

    for (const [repo, tags] of Object.entries(OCI_TAGS)) {
        http.on(`https://ghcr.io/token?service=ghcr.io&scope=repository:${repo}:pull`, {
            body: JSON.stringify({ token: 'anonymous' }),
        });
        http.on(`https://ghcr.io/v2/${repo}/tags/list`, { body: JSON.stringify({ tags }) });
        http.on(`https://mcr.microsoft.com/v2/${repo}/tags/list`, {
            body: JSON.stringify({ tags }),
        });
    }
    return http;
}

async function buildCommandRunner(): Promise<FakeCommandRunner> {
    return new FakeCommandRunner({
        'npm outdated --json --long': {
            exitCode: 1,
            stdout: await fs.readFile(path.join(FIXTURES, 'npm-outdated.json'), 'utf8'),
        },
        'npm audit --json': {
            exitCode: 1,
            stdout: await fs.readFile(path.join(FIXTURES, 'npm-audit.json'), 'utf8'),
        },
    });
}

/** Run the whole stage over this repository's own committed files. */
async function scan(
    clock = new FixedClock('2026-09-12T06:00:00.000Z'),
): Promise<MaintenanceReport> {
    const files = new LocalFsProvider(REPO_ROOT);
    const loaded = await loadConfig(files);
    const context: CollectorContext = {
        config: loaded.config,
        files,
        commands: await buildCommandRunner(),
        sources: buildDefaultSourceRegistry({ http: await buildHttpClient() }),
        logger: new RecordingLogger(),
        clock,
        offline: false,
        repoRoot: REPO_ROOT,
        configPath: loaded.path,
    };
    return runCollectors({
        collectors: buildCollectors(),
        context,
        config: loaded,
        environment: describeEnvironment(false),
    });
}

describe('the collect stage, end to end over this repository', () => {
    let report: MaintenanceReport;

    beforeAll(async () => {
        report = await scan();
    }, 30_000);

    it('should produce a report that satisfies the contract [REQ-SCH-001]', () => {
        expect(MaintenanceReportSchema.safeParse(report).success).toBe(true);
    });

    it('should validate against the published JSON Schema, not only against Zod', async () => {
        // The artifact is what a non-TypeScript consumer validates against, so the two
        // must agree. Ajv strict mode also rejects any keyword the emitter invented.
        const schema = JSON.parse(
            await fs.readFile(
                path.join(REPO_ROOT, 'schemas', 'maintenance-report.v1.json'),
                'utf8',
            ),
        ) as object;
        const ajv = new Ajv2020({ strict: true, allErrors: true });
        addFormats(ajv);
        const validate = ajv.compile(schema);
        expect(validate(report)).toBe(true);
    });

    it('should run every configured collector [REQ-RPT-001]', () => {
        expect(report.collectorRuns.map((run) => run.collector)).toEqual([
            'npm',
            'github-actions',
            'arc',
            'eks',
            'images',
        ]);
        expect(report.collectorRuns.every((run) => run.status !== 'skipped')).toBe(true);
    });

    it('should produce findings from every collector, with no new infrastructure', () => {
        // The point of the whole exercise: real output on day one, from files that were
        // already in the repository plus the committed inventory.
        for (const [collector, count] of Object.entries(report.summary.byCollector)) {
            expect([collector, count > 0]).toEqual([collector, true]);
        }
    });

    it('should find the day-one problems the design was built around', () => {
        const ids = report.findings.map((finding) => finding.id);
        expect(ids).toEqual(
            expect.arrayContaining([
                // Debian 11 left standard support on 2026-08-31.
                'images/image-distro-eol/devcontainer-dockerfile-mcr.microsoft.com-devcontainers-base',
                // EKS 1.31 is past standard support in the committed calendar.
                'eks/cluster-version-eol/infra-eks-cluster.yaml-cluster',
                // ci.yml pins by tag, not by SHA.
                'github-actions/action-unpinned/actions-checkout',
                'github-actions/action-unpinned/actions-setup-node',
            ]),
        );
    });

    it('should give every finding a distinct fingerprint [REQ-ID-001]', () => {
        const fingerprints = report.findings.map((finding) => finding.fingerprint);
        expect(new Set(fingerprints).size).toBe(fingerprints.length);
    });

    it('should evidence every finding [REQ-EVI-001]', () => {
        expect(report.findings.every((finding) => finding.evidence.length > 0)).toBe(true);
    });

    it('should point file evidence at lines that exist', async () => {
        const lineCounts = new Map<string, number>();
        for (const finding of report.findings) {
            for (const evidence of finding.evidence) {
                if (evidence.type !== 'file' || evidence.line === null) {
                    continue;
                }
                if (!lineCounts.has(evidence.path)) {
                    const text = await fs.readFile(path.join(REPO_ROOT, evidence.path), 'utf8');
                    lineCounts.set(evidence.path, text.split('\n').length);
                }
                // A wrong line number is worse than none: it looks authoritative and
                // sends the reader to the wrong place.
                expect(evidence.line).toBeLessThanOrEqual(lineCounts.get(evidence.path) as number);
            }
        }
    });

    it('should order findings by descending severity [REQ-RPT-002]', () => {
        const ranks = report.findings.map((finding) => finding.severity.severity);
        const order = ['critical', 'high', 'medium', 'low', 'info'];
        const positions = ranks.map((severity) => order.indexOf(severity));
        expect(positions).toEqual([...positions].sort((a, b) => a - b));
    });

    it('should agree with its own summary [REQ-RPT-003]', () => {
        expect(report.summary.totalFindings).toBe(report.findings.length);
        expect(report.summary.unresolvedCount).toBe(
            report.findings.filter((finding) => finding.unresolved).length,
        );
    });

    it('should carry no judgement field at the collect stage [REQ-SCH-002]', () => {
        for (const finding of report.findings) {
            expect(finding).not.toHaveProperty('assessment');
            expect(finding).not.toHaveProperty('issue');
            expect(finding).not.toHaveProperty('recommendation');
        }
    });

    it('should differ between two runs on the same day only by timestamp [REQ-RPT-004]', async () => {
        // Late the same evening. Day counts are computed from UTC midnight on both sides
        // precisely so a scan at 06:00 and one at 23:45 agree about how long is left —
        // without that, every end-of-life message would churn with the time of day.
        const second = await scan(new FixedClock('2026-09-12T23:45:00.000Z'));
        expect(second.generatedAt).not.toBe(report.generatedAt);
        expect(stripTimestamps(second)).toEqual(stripTimestamps(report));
    }, 30_000);
});

/** Blank the two fields a second run over the same inputs is allowed to differ in. */
function stripTimestamps(report: MaintenanceReport): unknown {
    return JSON.parse(
        JSON.stringify({
            ...report,
            generatedAt: null,
            collectorRuns: report.collectorRuns.map((run) => ({ ...run, startedAt: null })),
            findings: report.findings.map((finding) => ({
                ...finding,
                latestResolution: { ...finding.latestResolution, retrievedAt: null },
                evidence: finding.evidence.map((evidence) =>
                    evidence.type === 'http' ? { ...evidence, retrievedAt: null } : evidence,
                ),
            })),
        }),
    );
}
