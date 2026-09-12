/**
 * Reads declared files from the local working tree.
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import { ConfigError, NotFoundError, toError } from '../errors';
import { FileProvider, FileRef, normaliseLineEndings } from './file-provider';

interface NodeError extends Error {
    code?: string;
}

export class LocalFsProvider implements FileProvider {
    public readonly kind = 'local' as const;

    /** Absolute path every read is resolved against and confined to. */
    private readonly rootDir: string;

    constructor(rootDir: string = process.cwd()) {
        this.rootDir = path.resolve(rootDir);
    }

    public async read(ref: FileRef): Promise<string> {
        const target = this.resolveWithinRoot(ref);
        try {
            return normaliseLineEndings(await fs.readFile(target, 'utf8'));
        } catch (error: unknown) {
            throw this.describe(error, ref);
        }
    }

    public async exists(ref: FileRef): Promise<boolean> {
        let target: string;
        try {
            target = this.resolveWithinRoot(ref);
        } catch {
            // A path outside the root does not exist as far as callers are concerned.
            return false;
        }
        try {
            const stats = await fs.stat(target);
            return stats.isFile();
        } catch {
            return false;
        }
    }

    /**
     * Resolve a reference against the root, refusing to escape it.
     *
     * The configuration is repository data, and a path such as `../../etc/passwd`
     * should be a configuration error rather than a successful read.
     */
    private resolveWithinRoot(ref: FileRef): string {
        const target = path.resolve(this.rootDir, ref.path);
        const prefix = this.rootDir.endsWith(path.sep)
            ? this.rootDir
            : `${this.rootDir}${path.sep}`;
        if (target !== this.rootDir && !target.startsWith(prefix)) {
            throw new ConfigError(`Path ${ref.path} resolves outside the repository root`, {
                target: ref.path,
            });
        }
        return target;
    }

    /** Turn a filesystem error into a classified maintenance error. */
    private describe(error: unknown, ref: FileRef): Error {
        const code = (error as NodeError).code;
        if (code === 'ENOENT' || code === 'ENOTDIR') {
            return new NotFoundError(`File not found: ${ref.path}`, { target: ref.path });
        }
        if (code === 'EISDIR') {
            return new ConfigError(`Expected a file but found a directory: ${ref.path}`, {
                target: ref.path,
            });
        }
        return new ConfigError(`Could not read ${ref.path}: ${toError(error).message}`, {
            target: ref.path,
            cause: error,
        });
    }
}
