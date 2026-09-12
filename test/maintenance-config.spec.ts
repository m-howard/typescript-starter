import * as YAML from 'yaml';
import { MaintenanceConfigSchema } from '../src/maintenance/schema/config';
import { DEFAULT_CONFIG_PATH, loadConfig } from '../src/maintenance/config/load-config';
import { LocalFsProvider } from '../src/maintenance/providers/local-fs-provider';
import { ConfigError, NotFoundError, ParseError } from '../src/maintenance/errors';
import { InMemoryFileProvider } from './support/maintenance-fakes';
import * as path from 'path';

const REPO_ROOT = path.join(__dirname, '..');

/** A minimal but complete config, as YAML, so the specs exercise the real path. */
const MINIMAL_YAML = [
    'version: 1',
    'collectors:',
    '    npm:',
    '        manifest: package.json',
].join('\n');

function load(yaml: string) {
    return loadConfig(new InMemoryFileProvider({ 'maintenance.config.yaml': yaml }));
}

describe('MaintenanceConfigSchema', () => {
    describe('defaults', () => {
        it('should fill every default from a bare version marker', () => {
            const result = MaintenanceConfigSchema.safeParse({ version: 1 });

            expect(result.success).toBe(true);
            if (result.success) {
                expect(result.data.defaults.httpTimeoutMs).toBe(15_000);
                expect(result.data.defaults.offline).toBe(false);
                expect(result.data.sources.npm.registryUrl).toBe('https://registry.npmjs.org');
                expect(result.data.sources.github.tokenEnv).toBe('GITHUB_TOKEN');
                expect(result.data.severity.overrides).toEqual([]);
            }
        });

        it('should treat an absent collector as not configured, not as an error', () => {
            const result = MaintenanceConfigSchema.safeParse({ version: 1 });

            expect(result.success).toBe(true);
            if (result.success) {
                expect(result.data.collectors.arc).toBeUndefined();
                expect(result.data.collectors.eks).toBeUndefined();
            }
        });

        it('should let a declared value override its default', () => {
            const result = MaintenanceConfigSchema.safeParse({
                version: 1,
                defaults: { httpTimeoutMs: 500 },
            });

            expect(result.success).toBe(true);
            if (result.success) {
                expect(result.data.defaults.httpTimeoutMs).toBe(500);
                expect(result.data.defaults.httpRetries).toBe(2);
            }
        });
    });

    describe('strictness', () => {
        it('should reject an unrecognised key rather than ignoring it [REQ-CFG-004]', () => {
            const result = MaintenanceConfigSchema.safeParse({ version: 1, collectrs: {} });

            expect(result.success).toBe(false);
        });

        it('should reject an unrecognised key inside a collector block', () => {
            const result = MaintenanceConfigSchema.safeParse({
                version: 1,
                collectors: { npm: { manifest: 'package.json', typo: true } },
            });

            expect(result.success).toBe(false);
        });

        it('should pin the config schema version', () => {
            expect(MaintenanceConfigSchema.safeParse({ version: 2 }).success).toBe(false);
        });
    });

    describe('version strings', () => {
        it('should reject an unquoted version and say how to fix it', () => {
            // YAML turns an unquoted 1.30 into the number 1.3 before Zod sees it, so the
            // trailing zero is already gone and coercion cannot recover it.
            const parsed = YAML.parse('version: "1.30"\nbare: 1.30');
            expect(parsed.bare).toBe(1.3);

            const result = MaintenanceConfigSchema.safeParse({
                version: 1,
                collectors: {
                    eks: {
                        inventoryFile: 'infra/eks/cluster.yaml',
                        supportCalendar: {
                            lastVerified: '2026-09-01',
                            source: 'https://docs.aws.amazon.com/eks/',
                            defaultVersion: 1.3,
                            versions: [
                                {
                                    version: '1.33',
                                    endOfStandardSupport: '2026-07-28',
                                    status: 'standard-support',
                                },
                            ],
                        },
                    },
                },
            });

            expect(result.success).toBe(false);
            if (!result.success) {
                const message = result.error.issues.map((issue) => issue.message).join(' ');
                expect(message).toMatch(/must be quoted/i);
                expect(message).toMatch(/1\.30/);
            }
        });

        it('should fall back to the default message for a non-numeric wrong type', () => {
            // The quoting advice is only useful for a number; anything else gets Zod's
            // ordinary message rather than misleading guidance.
            const result = MaintenanceConfigSchema.safeParse({
                version: 1,
                collectors: {
                    eks: {
                        inventoryFile: 'infra/eks/cluster.yaml',
                        supportCalendar: {
                            lastVerified: '2026-09-01',
                            source: 'https://docs.aws.amazon.com/eks/',
                            defaultVersion: null,
                            versions: [
                                {
                                    version: '1.33',
                                    endOfStandardSupport: '2026-07-28',
                                    status: 'standard-support',
                                },
                            ],
                        },
                    },
                },
            });

            expect(result.success).toBe(false);
            if (!result.success) {
                const message = result.error.issues.map((issue) => issue.message).join(' ');
                expect(message).not.toMatch(/must be quoted/i);
            }
        });

        it('should accept a quoted version', () => {
            const result = MaintenanceConfigSchema.safeParse({
                version: 1,
                collectors: {
                    eks: {
                        inventoryFile: 'infra/eks/cluster.yaml',
                        supportCalendar: {
                            lastVerified: '2026-09-01',
                            source: 'https://docs.aws.amazon.com/eks/',
                            defaultVersion: '1.33',
                            versions: [
                                {
                                    version: '1.33',
                                    endOfStandardSupport: '2026-07-28',
                                    status: 'standard-support',
                                },
                            ],
                        },
                    },
                },
            });

            expect(result.success).toBe(true);
        });
    });

    describe('severity overrides', () => {
        const base = {
            severity: 'low' as const,
            reason: 'Tracked elsewhere.',
            expiresAt: '2026-12-31',
        };

        it('should accept an override matched by id', () => {
            const result = MaintenanceConfigSchema.safeParse({
                version: 1,
                severity: { overrides: [{ ...base, id: 'npm/dependency-outdated/typescript' }] },
            });

            expect(result.success).toBe(true);
        });

        it('should accept an override matched by fingerprint', () => {
            const result = MaintenanceConfigSchema.safeParse({
                version: 1,
                severity: { overrides: [{ ...base, fingerprint: 'a'.repeat(32) }] },
            });

            expect(result.success).toBe(true);
        });

        it('should reject an override that matches nothing', () => {
            const result = MaintenanceConfigSchema.safeParse({
                version: 1,
                severity: { overrides: [base] },
            });

            expect(result.success).toBe(false);
        });

        it.each([
            ['a reason', { id: 'x', severity: 'low', expiresAt: '2026-12-31' }],
            ['an expiry', { id: 'x', severity: 'low', reason: 'because' }],
        ])('should require %s [REQ-SEV-053]', (_label, override) => {
            const result = MaintenanceConfigSchema.safeParse({
                version: 1,
                severity: { overrides: [override] },
            });

            expect(result.success).toBe(false);
        });
    });

    describe('source references', () => {
        it.each([
            ['npm:typescript'],
            ['github-release:actions/runner'],
            ['github-tag:kubernetes/kubernetes'],
            ['oci:ghcr.io/actions/actions-runner'],
            ['helm:ghcr.io/actions/actions-runner-controller-charts/gha-runner-scale-set'],
            ['static:v1.11.4-eksbuild.2'],
        ])('should accept %s', (source: string) => {
            const result = MaintenanceConfigSchema.safeParse({
                version: 1,
                collectors: {
                    images: {
                        dockerfiles: [
                            {
                                path: 'Dockerfile',
                                baseImages: { 'some/image': { source, tagPattern: '^v?\\d+$' } },
                            },
                        ],
                    },
                },
            });

            expect(result.success).toBe(true);
        });

        it('should reject a reference with no scheme', () => {
            const result = MaintenanceConfigSchema.safeParse({
                version: 1,
                collectors: {
                    images: {
                        dockerfiles: [
                            {
                                path: 'Dockerfile',
                                baseImages: {
                                    'some/image': { source: 'actions/runner', tagPattern: '^v' },
                                },
                            },
                        ],
                    },
                },
            });

            expect(result.success).toBe(false);
        });
    });
});

describe('loadConfig', () => {
    it('should load, validate and digest a config [REQ-CFG-005]', async () => {
        const loaded = await load(MINIMAL_YAML);

        expect(loaded.path).toBe(DEFAULT_CONFIG_PATH);
        expect(loaded.sha256).toMatch(/^[0-9a-f]{64}$/);
        expect(loaded.config.collectors.npm?.manifest).toBe('package.json');
    });

    it('should produce the same digest for the same content', async () => {
        const first = await load(MINIMAL_YAML);
        const second = await load(MINIMAL_YAML);

        expect(second.sha256).toBe(first.sha256);
    });

    it('should digest normalised text, so a CRLF checkout matches an LF one', async () => {
        const lf = await load(MINIMAL_YAML);
        const crlf = await load(MINIMAL_YAML.replace(/\n/g, '\r\n'));

        expect(crlf.sha256).toBe(lf.sha256);
    });

    it('should change the digest when the content changes', async () => {
        const first = await load(MINIMAL_YAML);
        const second = await load(`${MINIMAL_YAML}\n        runAudit: false`);

        expect(second.sha256).not.toBe(first.sha256);
    });

    describe('failures', () => {
        it('should raise NotFoundError for a missing config', async () => {
            await expect(loadConfig(new InMemoryFileProvider())).rejects.toBeInstanceOf(
                NotFoundError,
            );
        });

        it('should raise ParseError for malformed YAML', async () => {
            await expect(load('version: 1\n  bad: [indent')).rejects.toBeInstanceOf(ParseError);
        });

        it('should raise ParseError for duplicate keys rather than taking the last', async () => {
            // Two npm blocks is a mistake in an inventory, not a merge.
            await expect(load('version: 1\nversion: 2')).rejects.toBeInstanceOf(ParseError);
        });

        it('should raise ConfigError and name the file when validation fails [REQ-CFG-003]', async () => {
            const promise = load('version: 99');

            await expect(promise).rejects.toBeInstanceOf(ConfigError);
            await expect(promise).rejects.toThrow('maintenance.config.yaml');
        });

        it('should report the path of each invalid field, for a human editing YAML', async () => {
            const promise = load('version: 1\ndefaults:\n    httpRetries: -1');

            await expect(promise).rejects.toThrow(/defaults\.httpRetries/);
        });

        it('should report a root-level problem as (root)', async () => {
            await expect(load('version: 1\nunknownKey: true')).rejects.toThrow(/\(root\)/);
        });
    });
});

describe('the committed maintenance.config.yaml', () => {
    it('should load and validate, so the repository always has a working inventory', async () => {
        const loaded = await loadConfig(new LocalFsProvider(REPO_ROOT));

        expect(loaded.config.version).toBe(1);
    });

    it('should configure the collectors that have real inputs in this repository', async () => {
        const { config } = await loadConfig(new LocalFsProvider(REPO_ROOT));

        expect(config.collectors.npm?.enabled).toBe(true);
        expect(config.collectors.githubActions?.enabled).toBe(true);
    });

    it('should name only workflow files that exist [REQ-CFG-006]', async () => {
        const provider = new LocalFsProvider(REPO_ROOT);
        const { config } = await loadConfig(provider);

        for (const workflow of config.collectors.githubActions?.workflows ?? []) {
            await expect(provider.exists({ path: workflow })).resolves.toBe(true);
        }
    });

    it('should name a manifest and lockfile that exist', async () => {
        const provider = new LocalFsProvider(REPO_ROOT);
        const { config } = await loadConfig(provider);

        await expect(
            provider.exists({ path: config.collectors.npm?.manifest ?? '' }),
        ).resolves.toBe(true);
        await expect(
            provider.exists({ path: config.collectors.npm?.lockfile ?? '' }),
        ).resolves.toBe(true);
    });
});
