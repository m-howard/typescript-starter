/**
 * Reading declared values out of a YAML inventory file.
 *
 * The ARC and EKS collectors are pointed at a dotted path inside a values file —
 * `controller.chartVersion`, `cluster.version` — rather than at a fixed schema, because
 * the shape of a Helm values file is the chart's business and changes between releases.
 *
 * Every read reports the line the value sits on. A finding that says "the controller
 * chart is behind" without saying where to change it makes the reader grep for it, and a
 * values file has several version-shaped fields (REQ-ARC-013).
 */

import * as YAML from 'yaml';
import { ParseError } from '../errors';
import { LineIndex } from '../text/line-index';

/** A value found at a dotted path, with where it was found. */
export interface ValueAtPath {
    /** The dotted path that was asked for. */
    path: string;
    /** The scalar as written. Numbers and booleans are rendered back to their text. */
    value: string;
    line: number;
    snippet: string;
}

/** A parsed values file, ready to be read from repeatedly. */
export class ValuesDocument {
    private readonly document: YAML.Document.Parsed;
    private readonly index: LineIndex;

    constructor(
        text: string,
        public readonly path: string,
    ) {
        // parseDocument collects errors rather than throwing, so `errors` is the only
        // real failure path here.
        this.document = YAML.parseDocument(text, { version: '1.2' });
        if (this.document.errors.length > 0) {
            throw new ParseError(`${path} is not valid YAML: ${this.document.errors[0].message}`, {
                target: path,
            });
        }
        this.index = new LineIndex(text);
    }

    /**
     * The scalar at a dotted path, or null when the path does not resolve.
     *
     * Null rather than an exception: a path that does not resolve is a configuration
     * mistake the collector reports as such, naming both the file and the path, which is
     * more use to the reader than a stack (REQ-ARC-015).
     */
    public readString(path: string): ValueAtPath | null {
        const node = this.document.getIn(segments(path), true);
        if (!YAML.isScalar(node) || node.value === null || node.value === undefined) {
            return null;
        }
        const offset = node.range?.[0];
        const line = offset === undefined ? 1 : this.index.offsetToLineCol(offset).line;
        return {
            path,
            // A YAML scalar may parse as a number or a boolean; the declared text is what
            // the collector compares and records, so it is rendered back rather than
            // carried as whatever type the parser chose.
            value: String(node.value),
            line,
            snippet: this.index.snippetAt(line),
        };
    }

    /**
     * The entries of a mapping at a dotted path, each with its own line.
     *
     * Used for the addon table, where the keys are addon names the collector does not
     * know in advance.
     */
    public readMap(path: string): ValueAtPath[] | null {
        const node = this.document.getIn(segments(path), true);
        if (!YAML.isMap(node)) {
            return null;
        }
        const entries: ValueAtPath[] = [];
        for (const item of node.items) {
            if (!YAML.isScalar(item.key) || typeof item.key.value !== 'string') {
                continue;
            }
            const child = this.readString(`${path}.${item.key.value}`);
            if (child !== null) {
                entries.push(child);
            }
        }
        return entries;
    }

    /** Whether a path resolves to anything at all, mapping or scalar. */
    public has(path: string): boolean {
        return this.document.hasIn(segments(path));
    }
}

/**
 * Split a dotted path into node keys.
 *
 * A numeric segment addresses an array element, which is how a values file names one
 * entry of a list (`nodeGroups.0.amiVersion`).
 */
function segments(path: string): Array<string | number> {
    return path.split('.').map((segment) => (/^\d+$/.test(segment) ? Number(segment) : segment));
}
