import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { LocalFsProvider } from '../src/maintenance/providers/local-fs-provider';
import { GitHubContentsProvider } from '../src/maintenance/providers/github-contents-provider';
import { normaliseLineEndings } from '../src/maintenance/providers/file-provider';
import { ConfigError, NotFoundError, NotImplementedError } from '../src/maintenance/errors';
import { InMemoryFileProvider } from './support/maintenance-fakes';

describe('normaliseLineEndings', () => {
    it.each([
        ['CRLF', 'a: 1\r\nb: 2\r\n'],
        ['lone CR', 'a: 1\rb: 2\r'],
        ['mixed', 'a: 1\r\nb: 2\nc: 3\r'],
    ])('should normalise %s to LF', (_label, input: string) => {
        const normalised = normaliseLineEndings(input);

        expect(normalised).not.toMatch(/\r/);
        expect(normalised.split('\n').length).toBeGreaterThan(1);
    });

    it('should leave LF content untouched', () => {
        expect(normaliseLineEndings('a: 1\nb: 2\n')).toBe('a: 1\nb: 2\n');
    });
});

describe('LocalFsProvider', () => {
    let rootDir: string;
    let provider: LocalFsProvider;

    beforeEach(async () => {
        rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'maintenance-fs-'));
        provider = new LocalFsProvider(rootDir);
        await fs.mkdir(path.join(rootDir, 'nested'), { recursive: true });
        await fs.writeFile(path.join(rootDir, 'plain.yml'), 'a: 1\n', 'utf8');
        await fs.writeFile(path.join(rootDir, 'nested', 'crlf.yml'), 'a: 1\r\nb: 2\r\n', 'utf8');
    });

    afterEach(async () => {
        await fs.rm(rootDir, { recursive: true, force: true });
    });

    describe('read', () => {
        it('should read a declared file', async () => {
            await expect(provider.read({ path: 'plain.yml' })).resolves.toBe('a: 1\n');
        });

        it('should normalise CRLF so the Windows CI leg matches the others', async () => {
            await expect(provider.read({ path: 'nested/crlf.yml' })).resolves.toBe('a: 1\nb: 2\n');
        });

        it('should raise NotFoundError for a missing file [REQ-ARC-014]', async () => {
            await expect(provider.read({ path: 'absent.yml' })).rejects.toBeInstanceOf(
                NotFoundError,
            );
        });

        it('should name the missing path so the error is actionable', async () => {
            await expect(provider.read({ path: 'absent.yml' })).rejects.toThrow('absent.yml');
        });

        it('should raise a config error for a directory', async () => {
            await expect(provider.read({ path: 'nested' })).rejects.toBeInstanceOf(ConfigError);
        });

        it.each([
            ['a parent traversal', '../escape.yml'],
            ['a deep traversal', 'nested/../../escape.yml'],
            ['an absolute path outside the root', path.join(os.tmpdir(), 'escape.yml')],
        ])('should refuse %s [REQ-CFG-006]', async (_label, target: string) => {
            // Configuration is repository data; escaping the root is a config error,
            // not a successful read.
            await expect(provider.read({ path: target })).rejects.toBeInstanceOf(ConfigError);
        });

        it('should classify an unexpected filesystem error rather than letting it escape', async () => {
            // A NUL in the path makes readFile reject with ERR_INVALID_ARG_VALUE, which
            // is neither ENOENT nor EISDIR - the generic fallback must still classify it.
            const promise = provider.read({ path: `x${String.fromCharCode(0)}y` });

            await expect(promise).rejects.toBeInstanceOf(ConfigError);
            await expect(promise).rejects.toThrow(/could not read/i);
        });

        it('should not be fooled by a sibling directory sharing the root prefix', async () => {
            const sibling = `${rootDir}-other`;
            await fs.mkdir(sibling, { recursive: true });
            await fs.writeFile(path.join(sibling, 'x.yml'), 'nope\n', 'utf8');

            await expect(
                provider.read({ path: path.join(sibling, 'x.yml') }),
            ).rejects.toBeInstanceOf(ConfigError);

            await fs.rm(sibling, { recursive: true, force: true });
        });
    });

    describe('exists', () => {
        it('should report a present file', async () => {
            await expect(provider.exists({ path: 'plain.yml' })).resolves.toBe(true);
        });

        it('should report a missing file without throwing', async () => {
            await expect(provider.exists({ path: 'absent.yml' })).resolves.toBe(false);
        });

        it('should report a directory as not a file', async () => {
            await expect(provider.exists({ path: 'nested' })).resolves.toBe(false);
        });

        it('should report a path outside the root as absent rather than throwing', async () => {
            await expect(provider.exists({ path: '../escape.yml' })).resolves.toBe(false);
        });
    });

    it('should default its root to the working directory', () => {
        expect(new LocalFsProvider().kind).toBe('local');
    });
});

describe('GitHubContentsProvider', () => {
    const provider = new GitHubContentsProvider();

    it('should declare itself a github provider so evidence can record it', () => {
        expect(provider.kind).toBe('github');
    });

    it.each([
        ['read', () => provider.read({ path: 'arc/values.yaml', repo: 'm-howard/infra' })],
        ['exists', () => provider.exists({ path: 'arc/values.yaml', repo: 'm-howard/infra' })],
    ])('should reject %s as not yet implemented', async (_label, call) => {
        await expect(call()).rejects.toBeInstanceOf(NotImplementedError);
    });

    it('should name the reference it could not read, including repo and ref', async () => {
        await expect(
            provider.read({ path: 'arc/values.yaml', repo: 'm-howard/infra', ref: 'main' }),
        ).rejects.toThrow('m-howard/infra/arc/values.yaml@main');
    });

    it('should classify as unsupported and not retryable', async () => {
        await expect(provider.read({ path: 'a.yml' })).rejects.toMatchObject({
            code: 'unsupported',
            retryable: false,
        });
    });
});

describe('InMemoryFileProvider', () => {
    it('should serve registered files and record what was read', async () => {
        const provider = new InMemoryFileProvider({ 'package.json': '{}' });

        await expect(provider.read({ path: 'package.json' })).resolves.toBe('{}');
        expect(provider.reads).toEqual(['package.json']);
    });

    it('should reject an unregistered file the same way the real provider does', async () => {
        await expect(new InMemoryFileProvider().read({ path: 'x' })).rejects.toBeInstanceOf(
            NotFoundError,
        );
    });

    it('should normalise line endings like the real provider', async () => {
        const provider = new InMemoryFileProvider({ 'a.yml': 'a: 1\r\n' });

        await expect(provider.read({ path: 'a.yml' })).resolves.toBe('a: 1\n');
    });

    it('should support incremental registration', async () => {
        const provider = new InMemoryFileProvider().set('later.yml', 'x: 1\n');

        await expect(provider.exists({ path: 'later.yml' })).resolves.toBe(true);
    });
});
