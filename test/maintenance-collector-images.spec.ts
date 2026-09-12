import { ImagesCollector } from '../src/maintenance/collectors/images';
import { CollectorContext } from '../src/maintenance/types';
import { Finding } from '../src/maintenance/schema';
import { FixedClock } from '../src/maintenance/clock';
import {
    fakeContext,
    fakeResolved,
    fakeUnresolved,
    FakeSourceRegistry,
    InMemoryFileProvider,
} from './support/maintenance-fakes';

const DOCKERFILE = 'infra/images/runner.Dockerfile';
const NODE_IMAGE = 'docker.io/library/node';

const CALENDAR = {
    lastVerified: '2026-09-01',
    staleAfterDays: 180,
    codenames: {
        bullseye: { distro: 'Debian', release: '11', endOfStandardSupport: '2026-08-31' },
        bookworm: { distro: 'Debian', release: '12', endOfStandardSupport: '2028-06-10' },
    },
};

const nodeBase = {
    source: `oci:${NODE_IMAGE}`,
    tagPattern: '^\\d+\\.\\d+\\.\\d+$',
};

const config = (
    dockerfile: Record<string, unknown> = {},
    images: Record<string, unknown> = {},
) => ({
    version: 1,
    collectors: {
        images: {
            distroCalendar: CALENDAR,
            dockerfiles: [{ path: DOCKERFILE, ...dockerfile }],
            ...images,
        },
    },
});

interface Harness {
    ctx: CollectorContext;
    sources: FakeSourceRegistry;
}

function harness(
    contents: string,
    dockerfile: Record<string, unknown> = {},
    answers: Record<string, ReturnType<typeof fakeResolved>> = {},
    options: { clock?: FixedClock; images?: Record<string, unknown> } = {},
): Harness {
    const sources = new FakeSourceRegistry(answers);
    return {
        sources,
        ctx: fakeContext({
            config: config(dockerfile, options.images),
            files: new InMemoryFileProvider({ [DOCKERFILE]: contents }),
            sources,
            clock: options.clock ?? new FixedClock('2026-09-12T06:00:00.000Z'),
        }),
    };
}

const byKind = (findings: readonly Finding[], kind: string): Finding[] =>
    findings.filter((finding) => finding.kind === kind);

describe('ImagesCollector', () => {
    describe('isEnabled', () => {
        it('should run only when the configuration declares it [REQ-CFG-007]', () => {
            const collector = new ImagesCollector();
            expect(collector.isEnabled(fakeContext({ config: config() }).config)).toBe(true);
            expect(collector.isEnabled(fakeContext().config)).toBe(false);
        });
    });

    describe('base images [REQ-IMG-010]', () => {
        it('should report a base image behind its newest matching tag', async () => {
            const { ctx } = harness(
                `FROM ${NODE_IMAGE}:22.9.0\nRUN echo hi\n`,
                { baseImages: { [NODE_IMAGE]: nodeBase } },
                { [`oci:${NODE_IMAGE}`]: fakeResolved('22.14.0', 'oci-registry') },
            );
            const findings = byKind(
                (await new ImagesCollector().collect(ctx)).findings,
                'image-base-outdated',
            );
            expect(findings).toHaveLength(1);
            expect(findings[0]).toMatchObject({
                subject: { kind: 'container-image', id: `${DOCKERFILE}#${NODE_IMAGE}` },
                versions: {
                    declared: '22.9.0',
                    observed: '22.9.0',
                    latest: '22.14.0',
                    bump: 'minor',
                },
                evidence: [{ type: 'file', path: DOCKERFILE, line: 1 }],
            });
        });

        it('should emit nothing when the base image is already current [REQ-SCH-009]', async () => {
            const { ctx } = harness(
                `FROM ${NODE_IMAGE}:22.14.0\n`,
                { baseImages: { [NODE_IMAGE]: nodeBase } },
                { [`oci:${NODE_IMAGE}`]: fakeResolved('22.14.0', 'oci-registry') },
            );
            expect((await new ImagesCollector().collect(ctx)).findings).toEqual([]);
        });

        it('should pass the configured tag filter to the source [REQ-IMG-015]', async () => {
            const sources = new FakeSourceRegistry({
                [`oci:${NODE_IMAGE}`]: fakeResolved('22.14.0', 'oci-registry'),
            });
            const resolve = jest.spyOn(sources, 'resolve');
            const ctx = fakeContext({
                config: config({ baseImages: { [NODE_IMAGE]: nodeBase } }),
                files: new InMemoryFileProvider({ [DOCKERFILE]: `FROM ${NODE_IMAGE}:22.9.0\n` }),
                sources,
            });
            await new ImagesCollector().collect(ctx);
            expect(resolve).toHaveBeenCalledWith(`oci:${NODE_IMAGE}`, {
                tagPattern: /^\d+\.\d+\.\d+$/,
            });
        });

        it('should report an unmatched tag filter as unresolved [REQ-IMG-016]', async () => {
            const { ctx } = harness(
                `FROM ${NODE_IMAGE}:22.9.0\n`,
                { baseImages: { [NODE_IMAGE]: nodeBase } },
                {
                    [`oci:${NODE_IMAGE}`]: fakeUnresolved(
                        'No tag matched /^\\d+$/ among 1842 tags.',
                        'oci-registry',
                    ),
                },
            );
            const findings = byKind(
                (await new ImagesCollector().collect(ctx)).findings,
                'image-base-outdated',
            );
            expect(findings[0]).toMatchObject({
                unresolved: true,
                latestResolution: { status: 'unresolved' },
            });
            expect(findings[0].detail).toContain('No tag matched');
        });

        it('should ignore a reference to a preceding build stage [REQ-IMG-011]', async () => {
            const { ctx } = harness(
                `FROM ${NODE_IMAGE}:22.14.0 AS builder\nFROM builder\nRUN echo hi\n`,
                { baseImages: { [NODE_IMAGE]: nodeBase } },
                { [`oci:${NODE_IMAGE}`]: fakeResolved('22.14.0', 'oci-registry') },
            );
            expect((await new ImagesCollector().collect(ctx)).findings).toEqual([]);
        });

        it('should resolve a tag composed from build arguments [REQ-IMG-012]', async () => {
            const { ctx } = harness(
                `ARG NODE_TAG=22.9.0\nFROM ${NODE_IMAGE}:\${NODE_TAG}\n`,
                { baseImages: { [NODE_IMAGE]: nodeBase } },
                { [`oci:${NODE_IMAGE}`]: fakeResolved('22.14.0', 'oci-registry') },
            );
            const findings = byKind(
                (await new ImagesCollector().collect(ctx)).findings,
                'image-base-outdated',
            );
            expect(findings[0].versions).toMatchObject({ declared: '22.9.0', bump: 'minor' });
        });

        it('should report an unresolvable build argument rather than guess [REQ-IMG-013]', async () => {
            const { ctx } = harness(`FROM \${BASE_IMAGE}:\${BASE_TAG}\n`, {
                baseImages: { '${BASE_IMAGE}': { ...nodeBase } },
            });
            const findings = byKind(
                (await new ImagesCollector().collect(ctx)).findings,
                'image-base-outdated',
            );
            expect(findings[0]).toMatchObject({ unresolved: true });
            expect(findings[0].detail).toContain('unsubstituted build argument');
        });

        it('should not report a digest-pinned image as drift [REQ-IMG-017]', async () => {
            const { ctx } = harness(`FROM ${NODE_IMAGE}@sha256:${'a'.repeat(64)}\n`, {
                baseImages: { [NODE_IMAGE]: nodeBase },
            });
            expect((await new ImagesCollector().collect(ctx)).findings).toEqual([]);
        });

        it('should order findings by image so two runs of the same input agree', async () => {
            const alpine = 'docker.io/library/alpine';
            const { ctx } = harness(
                `FROM ${NODE_IMAGE}:22.9.0 AS build\nFROM ${alpine}:3.20.0\n`,
                {
                    baseImages: {
                        [NODE_IMAGE]: nodeBase,
                        [alpine]: { source: `oci:${alpine}`, tagPattern: '^\\d+\\.\\d+\\.\\d+$' },
                    },
                },
                {
                    [`oci:${NODE_IMAGE}`]: fakeResolved('22.14.0', 'oci-registry'),
                    [`oci:${alpine}`]: fakeResolved('3.21.0', 'oci-registry'),
                },
            );
            const findings = byKind(
                (await new ImagesCollector().collect(ctx)).findings,
                'image-base-outdated',
            );
            // Declared second in the file, first alphabetically.
            expect(findings.map((f) => f.subject.displayName)).toEqual([alpine, NODE_IMAGE]);
        });

        it('should merge repeated references to one image into a single finding', async () => {
            const { ctx } = harness(
                `FROM ${NODE_IMAGE}:22.9.0 AS build\nRUN echo hi\nFROM ${NODE_IMAGE}:22.9.0\n`,
                { baseImages: { [NODE_IMAGE]: nodeBase } },
                { [`oci:${NODE_IMAGE}`]: fakeResolved('22.14.0', 'oci-registry') },
            );
            const findings = byKind(
                (await new ImagesCollector().collect(ctx)).findings,
                'image-base-outdated',
            );
            expect(findings).toHaveLength(1);
            expect(findings[0].evidence.map((e) => (e.type === 'file' ? e.line : null))).toEqual([
                1, 3,
            ]);
        });
    });

    describe('distribution end of life [REQ-IMG-014]', () => {
        const distroBase = {
            source: 'oci:mcr.microsoft.com/devcontainers/base',
            tagPattern: '^(bullseye|bookworm)$',
            distroFromCodenameSuffix: true,
        };
        const IMAGE = 'mcr.microsoft.com/devcontainers/base';

        it('should score a lapsed distribution critical', async () => {
            const { ctx } = harness(`FROM ${IMAGE}:bullseye\n`, {
                baseImages: { [IMAGE]: distroBase },
            });
            const findings = byKind(
                (await new ImagesCollector().collect(ctx)).findings,
                'image-distro-eol',
            );
            expect(findings).toHaveLength(1);
            expect(findings[0]).toMatchObject({
                severity: { severity: 'critical', ruleId: 'SEV-EOL-PAST' },
                lifecycle: {
                    endOfStandardSupport: '2026-08-31',
                    daysUntilEndOfSupport: -12,
                    calendarSource: 'maintenance.config.yaml#collectors.images.distroCalendar',
                    calendarLastVerified: '2026-09-01',
                },
            });
            expect(findings[0].title).toContain(
                'Debian 11 (bullseye) is past end of standard support',
            );
        });

        it('should read the codename from a suffixed tag', async () => {
            const { ctx } = harness(`FROM ${IMAGE}:1-bullseye\n`, {
                baseImages: { [IMAGE]: distroBase },
            });
            const findings = byKind(
                (await new ImagesCollector().collect(ctx)).findings,
                'image-distro-eol',
            );
            expect(findings[0].versions.declared).toBe('1-bullseye');
        });

        it('should stay quiet while support is comfortably ahead [REQ-SCH-009]', async () => {
            const { ctx } = harness(`FROM ${IMAGE}:bookworm\n`, {
                baseImages: { [IMAGE]: distroBase },
            });
            // 2028-06-10 is well beyond the horizon the severity table reacts to, so
            // there is nothing to act on and nothing to report.
            expect((await new ImagesCollector().collect(ctx)).findings).toEqual([]);
        });

        it('should escalate as the end-of-support date approaches', async () => {
            const { ctx } = harness(
                `FROM ${IMAGE}:bookworm\n`,
                { baseImages: { [IMAGE]: distroBase } },
                {},
                { clock: new FixedClock('2028-06-01T00:00:00.000Z') },
            );
            const findings = byKind(
                (await new ImagesCollector().collect(ctx)).findings,
                'image-distro-eol',
            );
            expect(findings[0].severity).toMatchObject({
                severity: 'high',
                ruleId: 'SEV-EOL-SOON-30',
            });
        });

        it('should not ask a registry about a codename tag', async () => {
            const { ctx, sources } = harness(`FROM ${IMAGE}:bullseye\n`, {
                baseImages: { [IMAGE]: distroBase },
            });
            await new ImagesCollector().collect(ctx);
            expect(sources.asked).toEqual([]);
        });

        it('should report an untagged image read as a codename [REQ-IMG-022]', async () => {
            const { ctx } = harness(`FROM ${IMAGE}\n`, {
                baseImages: { [IMAGE]: distroBase },
            });
            const findings = byKind(
                (await new ImagesCollector().collect(ctx)).findings,
                'config-stale',
            );
            expect(findings).toHaveLength(1);
            expect(findings[0].detail).toContain('it carries no tag');
        });

        it('should report a codename when no calendar is configured at all', async () => {
            const ctx = fakeContext({
                config: {
                    version: 1,
                    collectors: {
                        images: {
                            dockerfiles: [
                                { path: DOCKERFILE, baseImages: { [IMAGE]: distroBase } },
                            ],
                        },
                    },
                },
                files: new InMemoryFileProvider({ [DOCKERFILE]: `FROM ${IMAGE}:bullseye\n` }),
            });
            const findings = byKind(
                (await new ImagesCollector().collect(ctx)).findings,
                'config-stale',
            );
            expect(findings).toHaveLength(1);
            expect(findings[0].title).toContain('bullseye');
        });

        it('should report a codename the calendar does not know [REQ-IMG-022]', async () => {
            const { ctx } = harness(`FROM ${IMAGE}:trixie\n`, {
                baseImages: { [IMAGE]: distroBase },
            });
            const findings = byKind(
                (await new ImagesCollector().collect(ctx)).findings,
                'config-stale',
            );
            expect(findings).toHaveLength(1);
            expect(findings[0]).toMatchObject({
                subject: { kind: 'maintenance-config' },
                severity: { severity: 'medium', ruleId: 'SEV-CONFIG-STALE' },
            });
            expect(findings[0].title).toContain('trixie');
        });
    });

    describe('tool pins', () => {
        const pulumiPin = {
            id: 'pulumi',
            pattern: '--version ([0-9][^\\s\\\\]*)',
            source: 'github-release:pulumi/pulumi',
        };

        it('should report a pinned tool behind its upstream [REQ-IMG-018]', async () => {
            const { ctx } = harness(
                'FROM scratch\nRUN curl -fsSL https://get.pulumi.com | sh -s -- --version 3.178.0\n',
                { baseImages: {}, toolPins: [pulumiPin] },
                { 'github-release:pulumi/pulumi': fakeResolved('3.201.0') },
            );
            const findings = byKind(
                (await new ImagesCollector().collect(ctx)).findings,
                'image-tool-outdated',
            );
            expect(findings).toHaveLength(1);
            expect(findings[0]).toMatchObject({
                subject: { kind: 'image-tool', id: `${DOCKERFILE}#pulumi` },
                versions: { declared: '3.178.0', latest: '3.201.0', bump: 'minor' },
                evidence: [{ type: 'file', path: DOCKERFILE, line: 2 }],
            });
        });

        it('should compare at major precision when the pin asks for it', async () => {
            const { ctx } = harness(
                'FROM scratch\nRUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash -\n',
                {
                    baseImages: {},
                    toolPins: [
                        {
                            id: 'nodejs',
                            pattern: 'setup_([0-9]+)\\.x',
                            source: 'github-release:nodejs/node',
                            compare: 'major',
                        },
                    ],
                },
                { 'github-release:nodejs/node': fakeResolved('22.14.0') },
            );
            // 22 is the current major, so comparing against 22.14.0 exactly would be a
            // false positive.
            expect((await new ImagesCollector().collect(ctx)).findings).toEqual([]);
        });

        it('should emit an unresolved finding when the tool upstream cannot be reached', async () => {
            const { ctx } = harness(
                'FROM scratch\nRUN sh -s -- --version 3.178.0\n',
                { baseImages: {}, toolPins: [pulumiPin] },
                { 'github-release:pulumi/pulumi': fakeUnresolved('rate limited') },
            );
            const findings = byKind(
                (await new ImagesCollector().collect(ctx)).findings,
                'image-tool-outdated',
            );
            expect(findings).toHaveLength(1);
            expect(findings[0]).toMatchObject({ unresolved: true });
            expect(findings[0].title).toBe('pulumi could not be checked against upstream');
            expect(findings[0].detail).toContain('rate limited');
            expect(findings[0].remediationHint).toBeNull();
        });

        it('should prefer a comparable pin over one whose capture is not a version', async () => {
            const loosePin = { ...pulumiPin, pattern: '--version (\\S+)' };
            const { ctx } = harness(
                'FROM scratch\nRUN sh -s -- --version 3.178.0\nRUN sh -s -- --version latest\n',
                { baseImages: {}, toolPins: [loosePin] },
                { 'github-release:pulumi/pulumi': fakeResolved('3.201.0') },
            );
            const findings = byKind(
                (await new ImagesCollector().collect(ctx)).findings,
                'image-tool-outdated',
            );
            expect(findings[0].versions.declared).toBe('3.178.0');
        });

        it('should keep the comparable pin whichever order the installs appear in', async () => {
            const loosePin = { ...pulumiPin, pattern: '--version (\\S+)' };
            const { ctx } = harness(
                'FROM scratch\nRUN sh -s -- --version latest\nRUN sh -s -- --version 3.178.0\n',
                { baseImages: {}, toolPins: [loosePin] },
                { 'github-release:pulumi/pulumi': fakeResolved('3.201.0') },
            );
            const findings = byKind(
                (await new ImagesCollector().collect(ctx)).findings,
                'image-tool-outdated',
            );
            expect(findings[0].versions.declared).toBe('3.178.0');
        });

        it('should report an uncomparable pin rather than drop it', async () => {
            const loosePin = { ...pulumiPin, pattern: '--version (\\S+)' };
            const { ctx } = harness(
                'FROM scratch\nRUN sh -s -- --version latest\n',
                { baseImages: {}, toolPins: [loosePin] },
                { 'github-release:pulumi/pulumi': fakeResolved('3.201.0') },
            );
            const findings = byKind(
                (await new ImagesCollector().collect(ctx)).findings,
                'image-tool-outdated',
            );
            expect(findings[0].versions).toMatchObject({ declared: 'latest', bump: 'unknown' });
        });

        it('should emit nothing and not error when a pin matches no line [REQ-IMG-019]', async () => {
            const { ctx } = harness('FROM scratch\nRUN echo hi\n', {
                baseImages: {},
                toolPins: [pulumiPin],
            });
            expect(await new ImagesCollector().collect(ctx)).toEqual({ findings: [], errors: [] });
        });

        it('should merge repeated installs into one finding on the oldest pin', async () => {
            const { ctx } = harness(
                'FROM scratch\nRUN sh -s -- --version 3.178.0\nRUN sh -s -- --version 3.100.0\n',
                { baseImages: {}, toolPins: [pulumiPin] },
                { 'github-release:pulumi/pulumi': fakeResolved('3.201.0') },
            );
            const findings = byKind(
                (await new ImagesCollector().collect(ctx)).findings,
                'image-tool-outdated',
            );
            // Two findings here would share a fingerprint, which the publish stage could
            // not tell apart.
            expect(findings).toHaveLength(1);
            expect(findings[0].versions.declared).toBe('3.100.0');
            expect(findings[0].evidence.map((e) => (e.type === 'file' ? e.line : null))).toEqual([
                2, 3,
            ]);
            expect(findings[0].detail).toContain('also pinned to 3.178.0');
        });

        it('should give every finding in a run a distinct fingerprint [REQ-ID-001]', async () => {
            const { ctx } = harness(
                [
                    `FROM ${NODE_IMAGE}:22.9.0`,
                    'RUN sh -s -- --version 3.178.0',
                    'RUN sh -s -- --version 3.100.0',
                ].join('\n'),
                { baseImages: { [NODE_IMAGE]: nodeBase }, toolPins: [pulumiPin] },
                {
                    [`oci:${NODE_IMAGE}`]: fakeResolved('22.14.0', 'oci-registry'),
                    'github-release:pulumi/pulumi': fakeResolved('3.201.0'),
                },
            );
            const { findings } = await new ImagesCollector().collect(ctx);
            expect(findings.length).toBeGreaterThan(1);
            expect(new Set(findings.map((f) => f.fingerprint)).size).toBe(findings.length);
        });
    });

    describe('reporting on its own inputs', () => {
        it('should report a base image the inventory never declared [REQ-IMG-020]', async () => {
            const { ctx } = harness(`FROM ${NODE_IMAGE}:22.9.0\n`, { baseImages: {} });
            const findings = byKind(
                (await new ImagesCollector().collect(ctx)).findings,
                'config-stale',
            );
            expect(findings).toHaveLength(1);
            expect(findings[0]).toMatchObject({
                subject: {
                    kind: 'maintenance-config',
                    id: `maintenance.config.yaml#collectors.images.${DOCKERFILE}.baseImages.${NODE_IMAGE}`,
                },
                severity: { severity: 'medium' },
            });
            // Both where it was seen and where it should be declared.
            expect(findings[0].evidence.map((e) => (e.type === 'file' ? e.path : null))).toEqual([
                DOCKERFILE,
                'maintenance.config.yaml',
            ]);
        });

        it('should nag when the distribution calendar has gone stale [REQ-IMG-021]', async () => {
            const { ctx } = harness(
                'FROM scratch\n',
                { baseImages: {} },
                {},
                { clock: new FixedClock('2027-06-01T00:00:00.000Z') },
            );
            const findings = byKind(
                (await new ImagesCollector().collect(ctx)).findings,
                'config-stale',
            );
            expect(findings).toHaveLength(1);
            expect(findings[0].title).toContain('last verified 273 days ago');
        });

        it('should stay quiet while the calendar is inside its freshness window', async () => {
            const { ctx } = harness('FROM scratch\n', { baseImages: {} });
            expect((await new ImagesCollector().collect(ctx)).findings).toEqual([]);
        });

        it('should not check freshness when no calendar is configured', async () => {
            const ctx = fakeContext({
                config: {
                    version: 1,
                    collectors: { images: { dockerfiles: [{ path: DOCKERFILE }] } },
                },
                files: new InMemoryFileProvider({ [DOCKERFILE]: 'FROM scratch\n' }),
            });
            expect((await new ImagesCollector().collect(ctx)).findings).toEqual([]);
        });
    });

    describe('failure handling', () => {
        it('should record an unreadable Dockerfile and continue', async () => {
            const ctx = fakeContext({
                config: config({ baseImages: {} }),
                files: new InMemoryFileProvider({}),
            });
            const { errors } = await new ImagesCollector().collect(ctx);
            expect(errors).toEqual([
                {
                    code: 'not-found',
                    message: `File not found: ${DOCKERFILE}`,
                    target: DOCKERFILE,
                    retryable: false,
                },
            ]);
        });

        it('should reject an invalid tag filter as a configuration error', async () => {
            const { ctx } = harness(`FROM ${NODE_IMAGE}:22.9.0\n`, {
                baseImages: { [NODE_IMAGE]: { ...nodeBase, tagPattern: '([' } },
            });
            const { errors } = await new ImagesCollector().collect(ctx);
            expect(errors[0]).toMatchObject({
                code: 'config-error',
                target: `oci:${NODE_IMAGE}`,
            });
        });
    });
});
