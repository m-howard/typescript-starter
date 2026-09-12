/**
 * Actions Runner Controller: the two charts and the runner image.
 *
 * Everything comes from the declared values files rather than from `helm list`, so the
 * scan needs no cluster credentials and runs identically from any checkout. What that
 * costs is that the files must be kept true by hand, which `infra/README.md` says
 * plainly and `lastReconciled` in the EKS inventory nags about.
 *
 * The version-skew check is the reason this collector exists as more than three drift
 * comparisons. ARC requires the controller chart and the scale-set chart to be on the
 * same version; a mismatch is a supported-*looking* configuration that fails in ways
 * neither component reports, and it costs nothing to detect from two numbers already
 * being read (REQ-ARC-012).
 */

import { CollectorError, Evidence, Finding, LatestResolution, Subject } from '../schema';
import { MaintenanceConfig } from '../schema/config';
import { Collector, CollectorContext, CollectorOutput } from '../types';
import { ValueAtPath, ValuesDocument } from '../parsers/values-yaml';
import { splitImageReference } from '../parsers/dockerfile';
import { parseVersionForComparison, versionPrecision } from '../version';
import { buildFinding, notApplicableResolution, resolutionFromSource } from './build-finding';
import { collectorSettings, toCollectorError } from './collector';
import { ConfigError, toMaintenanceError } from '../errors';

type ArcSettings = NonNullable<MaintenanceConfig['collectors']['arc']>;
type ChartTarget = ArcSettings['chart'];

/** The two charts, with the finding kind and wording each produces. */
const CHARTS = [
    {
        key: 'chart' as const,
        id: 'gha-runner-scale-set-controller',
        displayName: 'ARC controller chart',
        kind: 'controller-outdated' as const,
    },
    {
        key: 'runnerScaleSet' as const,
        id: 'gha-runner-scale-set',
        displayName: 'ARC runner scale set chart',
        kind: 'chart-outdated' as const,
    },
];

export class ArcCollector implements Collector {
    public readonly id = 'arc' as const;

    public isEnabled(config: MaintenanceConfig): boolean {
        return config.collectors.arc?.enabled === true;
    }

    public async collect(ctx: CollectorContext): Promise<CollectorOutput> {
        const settings = collectorSettings(ctx.config, 'arc');
        const findings: Finding[] = [];
        const errors: CollectorError[] = [];
        const documents = new ValuesCache(ctx);
        const declaredVersions = new Map<string, ValueAtPath>();

        for (const chart of CHARTS) {
            const target = settings[chart.key];
            const declared = await read(documents, target.valuesFile, target.versionPath, errors);
            if (declared === null) {
                continue;
            }
            declaredVersions.set(chart.key, declared);
            findings.push(...(await this.inspectChart(chart, target, declared, ctx)));
        }

        if (settings.requireChartVersionParity) {
            const skew = this.checkParity(settings, declaredVersions, ctx);
            if (skew !== null) {
                findings.push(skew);
            }
        }

        const image = await this.inspectRunnerImage(settings, documents, errors, ctx);
        if (image !== null) {
            findings.push(image);
        }
        return { findings, errors };
    }

    private async inspectChart(
        chart: (typeof CHARTS)[number],
        target: ChartTarget,
        declared: ValueAtPath,
        ctx: CollectorContext,
    ): Promise<Finding[]> {
        const resolved = await ctx.sources.resolve(target.source);
        const latest = resolutionFromSource(target.source, resolved, ctx.clock);
        const observed = parseVersionForComparison(declared.value);
        const finding = buildFinding(
            {
                collector: this.id,
                kind: chart.kind,
                subject: chartSubject(chart.id, chart.displayName),
                title:
                    latest.version === null
                        ? `${chart.displayName} could not be checked against its registry`
                        : `${chart.displayName} is at ${declared.value}, latest is ${latest.version}`,
                detail: describeChart(chart.displayName, target, declared, latest),
                declared: declared.value,
                observed,
                comparePrecision: versionPrecision(declared.value) ?? undefined,
                latest,
                evidence: [valueEvidence(target.valuesFile, declared)],
                remediationHint:
                    latest.version === null
                        ? null
                        : `Set ${target.versionPath} to ${latest.version} in ${target.valuesFile}, ` +
                          `then upgrade the release.`,
                references: ['https://github.com/actions/actions-runner-controller/releases'],
                tags: ['arc', 'helm'],
            },
            ctx,
        );
        return finding.versions.bump === 'none' ? [] : [finding];
    }

    /**
     * The two chart versions must match.
     *
     * Kept separate from the drift findings and given its own discriminator, because it
     * is a different unit of work: both charts can be current and still mismatched
     * mid-upgrade, and both can be behind while perfectly consistent.
     */
    private checkParity(
        settings: ArcSettings,
        declared: ReadonlyMap<string, ValueAtPath>,
        ctx: CollectorContext,
    ): Finding | null {
        const controller = declared.get('chart');
        const scaleSet = declared.get('runnerScaleSet');
        if (controller === undefined || scaleSet === undefined) {
            return null;
        }
        if (controller.value === scaleSet.value) {
            return null;
        }
        return buildFinding(
            {
                collector: this.id,
                kind: 'chart-outdated',
                subject: chartSubject('gha-runner-scale-set-controller', 'ARC chart versions'),
                discriminator: 'version-skew',
                title:
                    `ARC controller chart ${controller.value} and scale set chart ` +
                    `${scaleSet.value} are on different versions`,
                detail:
                    `${settings.chart.valuesFile}:${controller.line} declares ` +
                    `${controller.value} and ${settings.runnerScaleSet.valuesFile}:` +
                    `${scaleSet.line} declares ${scaleSet.value}. ARC requires the controller ` +
                    `and every runner scale set to be on the same chart version; a mismatch is ` +
                    `accepted at install time and fails later in ways neither component ` +
                    `reports.`,
                declared: `${controller.value} / ${scaleSet.value}`,
                observed: null,
                latest: notApplicableResolution(
                    'static-config',
                    'Both versions are declared here; the mismatch is between them.',
                ),
                evidence: [
                    valueEvidence(settings.chart.valuesFile, controller),
                    valueEvidence(settings.runnerScaleSet.valuesFile, scaleSet),
                ],
                remediationHint:
                    `Bring both files to the same chart version, then upgrade the controller ` +
                    `release before the scale set.`,
                references: [
                    'https://docs.github.com/actions/hosting-your-own-runners/managing-self-hosted-runners-with-actions-runner-controller',
                ],
                tags: ['arc', 'version-skew'],
            },
            ctx,
        );
    }

    private async inspectRunnerImage(
        settings: ArcSettings,
        documents: ValuesCache,
        errors: CollectorError[],
        ctx: CollectorContext,
    ): Promise<Finding | null> {
        const { valuesFile, imagePath, source, tagPattern } = settings.runnerImage;
        const declared = await read(documents, valuesFile, imagePath, errors);
        if (declared === null) {
            return null;
        }
        const reference = splitImageReference(declared.value);
        if (reference.digest !== null) {
            // A digest pin is a deliberate choice, not drift (REQ-IMG-017).
            return null;
        }

        let latest: LatestResolution;
        try {
            const resolved = await ctx.sources.resolve(source, {
                tagPattern: compilePattern(tagPattern, source),
            });
            latest = resolutionFromSource(source, resolved, ctx.clock);
        } catch (error: unknown) {
            errors.push(toCollectorError(toMaintenanceError(error, source)));
            return null;
        }

        const finding = buildFinding(
            {
                collector: this.id,
                kind: 'image-base-outdated',
                subject: {
                    kind: 'container-image',
                    id: `${valuesFile}#${reference.image}`,
                    displayName: reference.image,
                    ecosystem: 'oci',
                    scope: 'infra',
                },
                title:
                    latest.version === null
                        ? `The runner image could not be checked against its registry`
                        : `The runner image is at ${reference.tag ?? 'an untagged reference'}, ` +
                          `latest is ${latest.version}`,
                detail:
                    `${valuesFile}:${declared.line} runs ${declared.value}. ` +
                    (latest.version === null
                        ? `The newest matching tag could not be established` +
                          `${latest.reason === null ? '' : `: ${latest.reason}`}.`
                        : `The newest tag matching \`${tagPattern}\` is ${latest.version}. ` +
                          `The runner binary is what GitHub deprecates first, so this one ` +
                          `tends to matter sooner than the charts.`),
                declared: reference.tag,
                observed: reference.tag === null ? null : parseVersionForComparison(reference.tag),
                comparePrecision:
                    reference.tag === null
                        ? undefined
                        : (versionPrecision(reference.tag) ?? undefined),
                latest,
                evidence: [valueEvidence(valuesFile, declared)],
                remediationHint:
                    latest.version === null
                        ? null
                        : `Set ${imagePath} to ${reference.image}:${latest.version} in ` +
                          `${valuesFile}.`,
                references: ['https://github.com/actions/runner/releases'],
                tags: ['arc', 'runner-image'],
            },
            ctx,
        );
        return finding.versions.bump === 'none' ? null : finding;
    }
}

/**
 * Values files read once each.
 *
 * The controller chart version and the runner image can live in the same file, and both
 * chart targets may point at one file in a smaller deployment. Reading it twice would be
 * two provider calls and, on a remote provider, two API requests.
 */
class ValuesCache {
    private readonly documents = new Map<string, ValuesDocument>();

    constructor(private readonly ctx: CollectorContext) {}

    public async get(path: string): Promise<ValuesDocument> {
        const existing = this.documents.get(path);
        if (existing !== undefined) {
            return existing;
        }
        const document = new ValuesDocument(await this.ctx.files.read({ path }), path);
        this.documents.set(path, document);
        return document;
    }
}

/**
 * Read one declared value, recording rather than raising whatever goes wrong.
 *
 * A missing file and an unresolvable path are different mistakes and get different
 * codes, but neither costs the other targets their findings (REQ-ARC-014, REQ-ARC-015).
 */
async function read(
    documents: ValuesCache,
    valuesFile: string,
    path: string,
    errors: CollectorError[],
): Promise<ValueAtPath | null> {
    let document: ValuesDocument;
    try {
        document = await documents.get(valuesFile);
    } catch (error: unknown) {
        errors.push(toCollectorError(toMaintenanceError(error, valuesFile)));
        return null;
    }
    const value = document.readString(path);
    if (value === null) {
        errors.push(
            toCollectorError(
                new ConfigError(`${valuesFile} has no value at ${path}`, {
                    target: `${valuesFile}#${path}`,
                }),
            ),
        );
        return null;
    }
    return value;
}

function chartSubject(id: string, displayName: string): Subject {
    return {
        kind: 'helm-chart',
        // A global name: the same chart deployed from two values files is still one
        // thing to upgrade.
        id,
        displayName,
        ecosystem: 'helm',
        scope: 'infra',
    };
}

function valueEvidence(path: string, value: ValueAtPath): Evidence {
    return {
        type: 'file',
        path,
        line: value.line,
        column: null,
        snippet: value.snippet,
        contentSha256: null,
        repo: null,
        ref: null,
    };
}

function describeChart(
    displayName: string,
    target: ChartTarget,
    declared: ValueAtPath,
    latest: LatestResolution,
): string {
    const where =
        `${target.valuesFile}:${declared.line} declares ${target.versionPath} as ` +
        `\`${declared.value}\``;
    if (latest.version === null) {
        return (
            `${where}. The latest ${displayName} version could not be established` +
            `${latest.reason === null ? '' : `: ${latest.reason}`}.`
        );
    }
    return `${where}; ${target.source} publishes ${latest.version} as the newest chart version.`;
}

function compilePattern(pattern: string, target: string): RegExp {
    try {
        return new RegExp(pattern);
    } catch {
        throw new ConfigError(`Invalid tagPattern for ${target}: ${pattern}`, { target });
    }
}
