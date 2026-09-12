/**
 * Rendering a report as a GitHub step summary.
 *
 * The scheduled workflow's only human-facing output. What it leads with matters: an
 * unresolved finding is one where nothing was established, not one where nothing is
 * wrong, and a reader who takes "8 unresolved" for "8 minor issues" has drawn the
 * opposite conclusion from the truth. So the count is explained in words before any
 * table (REQ-NET-022).
 *
 * Reads a file rather than taking the report from the runner, because it runs as a
 * separate step with `if: always()` — including after the scan is what failed.
 */

import { promises as fs } from 'fs';
import { Severity } from './schema';
import { toError } from './errors';

/** Severity order for the table, most to least severe. */
const SEVERITIES: readonly Severity[] = ['critical', 'high', 'medium', 'low', 'info'];

/** Findings listed inline before the summary defers to the uploaded artifact. */
const MAX_LISTED = 25;

/**
 * The report as this renderer reads it.
 *
 * Deliberately structural rather than the schema type: the summary must still render
 * something from a report written by an older version of the tool, and failing here
 * would turn a legible partial run into an opaque one.
 */
interface ReportLike {
    summary: {
        totalFindings: number;
        unresolvedCount: number;
        worstStatus: string;
        bySeverity: Record<string, number>;
    };
    collectorRuns: ReadonlyArray<{
        collector: string;
        status: string;
        findingCount: number;
        unresolvedCount: number;
        errors: readonly unknown[];
    }>;
    findings: ReadonlyArray<{ severity: { severity: string }; title: string; id: string }>;
}

/** Read a report and render it, saying so plainly when there is nothing to read. */
export async function renderReportAt(reportPath: string | undefined): Promise<string> {
    if (reportPath === undefined) {
        return heading('No report path was given.');
    }
    try {
        return render(JSON.parse(await fs.readFile(reportPath, 'utf8')) as ReportLike);
    } catch (error: unknown) {
        return heading(`No report could be read from ${reportPath}: ${toError(error).message}`);
    }
}

/** Render a report as GitHub-flavoured markdown. */
export function render(report: ReportLike): string {
    const lines = ['## Maintenance scan', ''];
    lines.push(
        `**${report.summary.totalFindings}** findings, ` +
            `**${report.summary.unresolvedCount}** unresolved, ` +
            `worst collector run **${report.summary.worstStatus}**.`,
        '',
    );

    if (report.summary.unresolvedCount > 0) {
        lines.push(
            `> ${report.summary.unresolvedCount} findings could not be checked against ` +
                'upstream. Those are gaps in what this scan established, not clean results.',
            '',
        );
    }

    lines.push('| Severity | Count |', '| --- | --- |');
    for (const severity of SEVERITIES) {
        lines.push(`| ${severity} | ${report.summary.bySeverity[severity] ?? 0} |`);
    }
    lines.push('');

    lines.push(
        '| Collector | Status | Findings | Unresolved | Errors |',
        '| --- | --- | --- | --- | --- |',
    );
    for (const run of report.collectorRuns) {
        lines.push(
            `| ${run.collector} | ${run.status} | ${run.findingCount} | ` +
                `${run.unresolvedCount} | ${run.errors.length} |`,
        );
    }
    lines.push('');

    const notable = report.findings.filter((finding) =>
        ['critical', 'high'].includes(finding.severity.severity),
    );
    if (notable.length > 0) {
        lines.push('### Critical and high', '');
        for (const finding of notable.slice(0, MAX_LISTED)) {
            lines.push(`- **${finding.severity.severity}** ${finding.title} (\`${finding.id}\`)`);
        }
        if (notable.length > MAX_LISTED) {
            lines.push(`- …and ${notable.length - MAX_LISTED} more, in the uploaded report.`);
        }
        lines.push('');
    }
    return `${lines.join('\n')}\n`;
}

function heading(message: string): string {
    return `## Maintenance scan\n\n${message}\n`;
}

/* istanbul ignore next -- entry point; renderReportAt carries the logic and the tests. */
if (require.main === module) {
    renderReportAt(process.argv[2])
        .then((summary) => process.stdout.write(summary))
        .catch(() => process.stdout.write(heading('The summary could not be rendered.')));
}
