/**
 * The inventory of record.
 *
 * This is the one schema in the set where `.default()` belongs. Defaults resolve here,
 * at load, so the report records only resolved values and its own schema can stay free
 * of input/output ambiguity.
 *
 * Every file a collector reads is named explicitly — there is no globbing
 * (`docs/maintenance/adr/0005-no-globbing-in-file-provider.md`, REQ-CFG-006).
 */

import { z } from 'zod';
import { IsoDateSchema, SeveritySchema } from './common';
import { CONFIG_SCHEMA_VERSION } from './report';

/**
 * A version written in YAML.
 *
 * Unquoted versions lose trailing zeros at parse time: `1.30` becomes the number `1.3`
 * and `1.20` becomes `1.2`. EKS 1.30 is a real version and `1.3` is not, so an unquoted
 * value would have a collector compare the wrong thing. The information is destroyed
 * before Zod sees it, so it cannot be recovered by coercion — the only honest response
 * is to reject a number and say how to fix it.
 */
const VersionStringSchema = z
    .string({
        error: (issue) =>
            typeof issue.input === 'number'
                ? "Versions must be quoted in YAML. Write '1.30', not 1.30 — an " +
                  'unquoted 1.30 parses as the number 1.3 and loses the trailing zero.'
                : undefined,
    })
    .min(1);

/** A repository-relative path to a declared input file. */
const FilePathSchema = z.string().min(1);

/**
 * An upstream reference, e.g. `npm:typescript` or `github-release:pulumi/pulumi`.
 *
 * Validated as a scheme plus identifier here; the source registry resolves it.
 */
const SourceRefSchema = z
    .string()
    .regex(
        /^(npm|github-release|github-tag|oci|helm|static):.+$/,
        'Must be <scheme>:<identifier>, e.g. github-release:actions/runner',
    );

export const DefaultsSchema = z.strictObject({
    httpTimeoutMs: z.number().int().positive().default(15_000),
    httpRetries: z.number().int().nonnegative().default(2),
    commandTimeoutMs: z.number().int().positive().default(180_000),
    offline: z.boolean().default(false),
});

export const SourcesSchema = z.strictObject({
    github: z
        .strictObject({
            apiBaseUrl: z.url().default('https://api.github.com'),
            /** Environment variable holding the token. Never the token itself. */
            tokenEnv: z.string().min(1).default('GITHUB_TOKEN'),
        })
        .prefault({}),
    npm: z
        .strictObject({
            registryUrl: z.url().default('https://registry.npmjs.org'),
        })
        .prefault({}),
});

export const NpmCollectorSchema = z.strictObject({
    enabled: z.boolean().default(true),
    /** Authoritative for the declared dependency set — see ADR-0001. */
    manifest: FilePathSchema.default('package.json'),
    lockfile: FilePathSchema.default('package-lock.json'),
    runOutdated: z.boolean().default(true),
    runAudit: z.boolean().default(true),
    /** Package names to skip entirely. */
    ignore: z.array(z.string().min(1)).default([]),
});

export const GithubActionsCollectorSchema = z.strictObject({
    enabled: z.boolean().default(true),
    /** Explicitly listed; the collector never discovers workflows by globbing. */
    workflows: z.array(FilePathSchema).min(1),
    /** Emit a finding for any action referenced by a mutable tag. */
    requireShaPins: z.boolean().default(true),
    /** Action references to skip, as `owner/repo`. */
    ignore: z.array(z.string().min(1)).default([]),
});

const ValuesPathSchema = z.strictObject({
    valuesFile: FilePathSchema,
    /** Dotted path within the values file, e.g. `arc.controller.chartVersion`. */
    versionPath: z.string().min(1),
    source: SourceRefSchema,
});

export const ArcCollectorSchema = z.strictObject({
    enabled: z.boolean().default(true),
    chart: ValuesPathSchema,
    runnerScaleSet: ValuesPathSchema,
    runnerImage: z.strictObject({
        valuesFile: FilePathSchema,
        imagePath: z.string().min(1),
        source: SourceRefSchema,
        tagPattern: z.string().min(1),
    }),
    /** ARC requires the controller and scale-set charts to be the same version. */
    requireChartVersionParity: z.boolean().default(true),
});

export const EksSupportCalendarEntrySchema = z.strictObject({
    version: VersionStringSchema,
    releasedAt: IsoDateSchema.nullable().default(null),
    endOfStandardSupport: IsoDateSchema,
    endOfExtendedSupport: IsoDateSchema.nullable().default(null),
    status: z.enum(['standard-support', 'extended-support', 'deprecated']),
});

export const EksSupportCalendarSchema = z.strictObject({
    /** When a human last checked this table against the AWS documentation. */
    lastVerified: IsoDateSchema,
    /** Days after `lastVerified` at which the collector nags about itself. */
    staleAfterDays: z.number().int().positive().default(90),
    source: z.url(),
    defaultVersion: VersionStringSchema,
    versions: z.array(EksSupportCalendarEntrySchema).min(1),
});

export const EksCollectorSchema = z.strictObject({
    enabled: z.boolean().default(true),
    inventoryFile: FilePathSchema,
    clusterVersionPath: z.string().min(1).default('cluster.version'),
    addonsPath: z.string().min(1).default('cluster.addons'),
    /**
     * `support-calendar` is the default and needs no credentials. `aws-cli` is opt-in
     * enrichment that falls back to the calendar, recording the downgrade — see ADR-0002.
     */
    latestStrategy: z
        .enum(['support-calendar', 'aws-cli', 'support-calendar+aws-cli'])
        .default('support-calendar'),
    awsCli: z
        .strictObject({
            argv: z
                .array(z.string().min(1))
                .min(1)
                .default(['aws', 'eks', 'describe-cluster-versions', '--output', 'json']),
        })
        .prefault({}),
    supportCalendar: EksSupportCalendarSchema,
    /** Addon name to upstream reference. */
    addonLatest: z.record(z.string().min(1), SourceRefSchema).default({}),
});

export const DistroCalendarEntrySchema = z.strictObject({
    distro: z.string().min(1),
    release: VersionStringSchema,
    endOfStandardSupport: IsoDateSchema,
});
export type DistroCalendarEntry = z.infer<typeof DistroCalendarEntrySchema>;

export const ImageToolPinSchema = z.strictObject({
    id: z.string().min(1),
    /** Regex with one capture group holding the version. */
    pattern: z.string().min(1),
    source: SourceRefSchema,
    compare: z.enum(['exact', 'major', 'minor']).default('exact'),
});
export type ImageToolPin = z.infer<typeof ImageToolPinSchema>;

export const ImageBaseSchema = z.strictObject({
    source: SourceRefSchema,
    /**
     * Required, not optional: one registry returns nearly two thousand tags for a
     * single repository, so an unfiltered "sort and take the max" picks nonsense.
     */
    tagPattern: z.string().min(1),
    /** Route the tag through the distribution calendar rather than semver comparison. */
    distroFromCodenameSuffix: z.boolean().default(false),
});
export type ImageBase = z.infer<typeof ImageBaseSchema>;

export const ImagesCollectorSchema = z.strictObject({
    enabled: z.boolean().default(true),
    distroCalendar: z
        .strictObject({
            lastVerified: IsoDateSchema,
            staleAfterDays: z.number().int().positive().default(180),
            codenames: z.record(z.string().min(1), DistroCalendarEntrySchema),
        })
        .optional(),
    dockerfiles: z
        .array(
            z.strictObject({
                path: FilePathSchema,
                baseImages: z.record(z.string().min(1), ImageBaseSchema).default({}),
                toolPins: z.array(ImageToolPinSchema).default([]),
            }),
        )
        .min(1),
});

/**
 * A severity override.
 *
 * Both a reason and an expiry are required. A permanent override is how a maintenance
 * queue goes silently blind, so an expired one is ignored and raises a `config-stale`
 * finding naming itself (REQ-SEV-053, REQ-SEV-054).
 */
export const SeverityOverrideSchema = z
    .strictObject({
        id: z.string().min(1).optional(),
        fingerprint: z
            .string()
            .regex(/^[0-9a-f]{32}$/)
            .optional(),
        severity: SeveritySchema,
        reason: z.string().min(1),
        expiresAt: IsoDateSchema,
    })
    .refine((value) => value.id !== undefined || value.fingerprint !== undefined, {
        error: 'A severity override must match on either id or fingerprint.',
    });
export type SeverityOverrideConfig = z.infer<typeof SeverityOverrideSchema>;

/**
 * A collector absent from `collectors` is not configured, and the runner records it as
 * `skipped` rather than failing — so a repository can adopt one collector at a time.
 */
export const CollectorsSchema = z.strictObject({
    npm: NpmCollectorSchema.optional(),
    githubActions: GithubActionsCollectorSchema.optional(),
    arc: ArcCollectorSchema.optional(),
    eks: EksCollectorSchema.optional(),
    images: ImagesCollectorSchema.optional(),
});

export const MaintenanceConfigSchema = z.strictObject({
    version: z.literal(CONFIG_SCHEMA_VERSION),
    defaults: DefaultsSchema.prefault({}),
    sources: SourcesSchema.prefault({}),
    collectors: CollectorsSchema.prefault({}),
    severity: z
        .strictObject({ overrides: z.array(SeverityOverrideSchema).default([]) })
        .prefault({}),
});
export type MaintenanceConfig = z.infer<typeof MaintenanceConfigSchema>;
