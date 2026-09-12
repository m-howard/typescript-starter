import { promises as fs } from 'fs';
import * as path from 'path';
import * as YAML from 'yaml';
import { parseWorkflow } from '../src/maintenance/parsers/workflow-yaml';
import { MaintenanceConfigSchema } from '../src/maintenance/schema/config';
import { render, renderReportAt } from '../src/maintenance/summary';

const REPO_ROOT = path.resolve(__dirname, '..');
const WORKFLOW_PATH = '.github/workflows/maintenance-scan.yml';

interface WorkflowLike {
    on?: { schedule?: unknown; workflow_dispatch?: unknown };
    permissions?: Record<string, string>;
    jobs?: Record<
        string,
        { steps?: Array<{ if?: string; uses?: string; run?: string; continueOnError?: string }> }
    >;
}

/**
 * The scan reads its own workflow, so the workflow has to satisfy the policy it
 * enforces. Asserting that here rather than trusting review is the difference between a
 * rule and a habit.
 */
describe('the maintenance scan workflow', () => {
    let text: string;
    let workflow: WorkflowLike;

    beforeAll(async () => {
        text = await fs.readFile(path.join(REPO_ROOT, WORKFLOW_PATH), 'utf8');
        workflow = YAML.parse(text, { version: '1.2' }) as WorkflowLike;
    });

    it('should run on a schedule and be manually dispatchable [REQ-WFL-001]', () => {
        expect(workflow.on?.schedule).toBeDefined();
        expect(workflow.on).toHaveProperty('workflow_dispatch');
    });

    it('should request nothing beyond reading contents [REQ-WFL-002]', () => {
        // Pass 1 writes nothing back. Issue creation belongs to the assess stage, and
        // this file must not quietly acquire the token to do it.
        expect(workflow.permissions).toEqual({ contents: 'read' });
    });

    it('should upload the report even when the run degrades [REQ-WFL-003]', () => {
        const upload = Object.values(workflow.jobs ?? {})
            .flatMap((job) => job.steps ?? [])
            .find((step) => step.uses?.includes('actions/upload-artifact'));
        expect(upload?.if).toBe('always()');
    });

    it('should pin every action to a full commit SHA [REQ-WFL-004]', () => {
        const { actions } = parseWorkflow(text, WORKFLOW_PATH);
        expect(actions.length).toBeGreaterThan(0);
        for (const action of actions) {
            expect([action.repository, action.pin]).toEqual([action.repository, 'sha']);
        }
    });

    it('should record the version each SHA denotes in a trailing comment', () => {
        // A SHA with no comment is unreadable, and the collector reports it as a version
        // it cannot determine.
        const { actions } = parseWorkflow(text, WORKFLOW_PATH);
        for (const action of actions) {
            expect([action.repository, /#\s*v?\d/.test(action.snippet)]).toEqual([
                action.repository,
                true,
            ]);
        }
    });

    it('should not gate the job on findings [REQ-WFL-006]', () => {
        // --fail-on is what turns findings into a red job, and a scheduled job that goes
        // red every week because maintenance work exists is a job people mute.
        expect(text).not.toContain('--fail-on');
        const collect = Object.values(workflow.jobs ?? {})
            .flatMap((job) => job.steps ?? [])
            .find((step) => step.run?.includes('maintenance:collect'));
        expect(collect).toBeDefined();
        expect(collect?.continueOnError).toBeUndefined();
    });

    it('should be in the set of workflows the collector scans [REQ-WFL-005]', async () => {
        const config = MaintenanceConfigSchema.parse(
            YAML.parse(await fs.readFile(path.join(REPO_ROOT, 'maintenance.config.yaml'), 'utf8'), {
                version: '1.2',
            }),
        );
        expect(config.collectors.githubActions?.workflows).toContain(WORKFLOW_PATH);
    });
});

describe('the step summary', () => {
    const report = {
        summary: {
            totalFindings: 3,
            unresolvedCount: 1,
            worstStatus: 'partial',
            bySeverity: { critical: 1, high: 1, medium: 0, low: 0, info: 1 },
            byCollector: { npm: 3, 'github-actions': 0, arc: 0, eks: 0, images: 0 },
        },
        collectorRuns: [
            {
                collector: 'npm',
                status: 'partial',
                findingCount: 3,
                unresolvedCount: 1,
                errors: [{ code: 'network' }],
            },
        ],
        findings: [
            { severity: { severity: 'critical' }, title: 'A is broken', id: 'npm/a' },
            { severity: { severity: 'high' }, title: 'B is behind', id: 'npm/b' },
            { severity: { severity: 'info' }, title: 'C is unresolved', id: 'npm/c' },
        ],
    };

    it('should lead with the totals a triager reads first', () => {
        const summary = render(report);
        expect(summary).toContain('**3** findings');
        expect(summary).toContain('**1** unresolved');
        expect(summary).toContain('worst collector run **partial**');
    });

    it('should say what unresolved means rather than leaving it as a number', () => {
        // The whole point of the count: those are gaps in what was established, not
        // clean results.
        expect(render(report)).toContain('not clean results');
    });

    it('should list only the findings worth acting on immediately', () => {
        const summary = render(report);
        expect(summary).toContain('A is broken');
        expect(summary).toContain('B is behind');
        expect(summary).not.toContain('C is unresolved');
    });

    it('should tabulate every collector run, errors included', () => {
        expect(render(report)).toContain('| npm | partial | 3 | 1 | 1 |');
    });

    it('should omit the notable section when there is nothing notable', () => {
        const quiet = {
            ...report,
            summary: { ...report.summary, unresolvedCount: 0 },
            findings: [{ severity: { severity: 'low' }, title: 'D', id: 'npm/d' }],
        };
        const summary = render(quiet);
        expect(summary).not.toContain('### Critical and high');
        expect(summary).not.toContain('not clean results');
    });

    it('should render every severity even when the report omits one', () => {
        const sparse = { ...report, summary: { ...report.summary, bySeverity: { critical: 1 } } };
        expect(render(sparse)).toContain('| medium | 0 |');
    });

    it('should truncate a long list rather than flooding the summary', () => {
        const many = {
            ...report,
            findings: Array.from({ length: 30 }, (_, index) => ({
                severity: { severity: 'high' },
                title: `Finding ${index}`,
                id: `npm/${index}`,
            })),
        };
        const summary = render(many);
        expect(summary).toContain('…and 5 more, in the uploaded report.');
    });

    describe('renderReportAt', () => {
        it('should render the report at a path', async () => {
            const target = path.join(REPO_ROOT, 'coverage', 'summary-fixture.json');
            await fs.mkdir(path.dirname(target), { recursive: true });
            await fs.writeFile(target, JSON.stringify(report), 'utf8');
            await expect(renderReportAt(target)).resolves.toContain('**3** findings');
            await fs.rm(target, { force: true });
        });

        it('should say so rather than throw when there is no report', async () => {
            // It runs with `if: always()`, including after the scan is what failed. A
            // summary step that throws turns a legible partial run into an opaque one.
            await expect(renderReportAt('does-not-exist.json')).resolves.toContain(
                'No report could be read',
            );
        });

        it('should say so when no path was given at all', async () => {
            await expect(renderReportAt(undefined)).resolves.toContain('No report path was given');
        });
    });
});
