/**
 * Character-offset to line/column mapping.
 *
 * Findings must point at the exact line that declares a version, because a reviewer
 * has to be able to check the claim (REQ-EVI-002). The YAML parser reports positions
 * as character offsets, so something has to turn those into line numbers; Dockerfile
 * and manifest parsing needs the reverse lookup from a matched string.
 */

import { truncate } from './truncate';

/** A one-based position within a text document, as editors and reviewers count. */
export interface LineCol {
    line: number;
    column: number;
}

/**
 * A precomputed index over the line starts of a document.
 *
 * Built once per file and queried per finding, so lookups are a binary search rather
 * than a scan — a workflow file can produce many findings.
 */
export class LineIndex {
    private readonly text: string;
    /** Character offset at which each line begins. Always starts with 0. */
    private readonly lineStarts: readonly number[];

    constructor(text: string) {
        this.text = text;
        this.lineStarts = LineIndex.computeLineStarts(text);
    }

    /** Number of lines, counting a trailing newline as ending the last line. */
    public get lineCount(): number {
        return this.lineStarts.length;
    }

    /** Length of the indexed text, which is the largest valid offset. */
    public get length(): number {
        return this.text.length;
    }

    /**
     * Convert a character offset to a one-based line and column.
     *
     * @throws RangeError if the offset falls outside `[0, length]`. An out-of-range
     * offset means a parser produced a position for a different document, and silently
     * clamping it would put a wrong line number into evidence.
     */
    public offsetToLineCol(offset: number): LineCol {
        if (!Number.isInteger(offset) || offset < 0 || offset > this.text.length) {
            throw new RangeError(
                `Offset ${offset} is outside the document (length ${this.text.length})`,
            );
        }
        const index = this.lineIndexOf(offset);
        return { line: index + 1, column: offset - this.lineStarts[index] + 1 };
    }

    /** One-based line number containing `offset`. */
    public lineOf(offset: number): number {
        return this.offsetToLineCol(offset).line;
    }

    /**
     * Text of a one-based line, without its terminator.
     *
     * A trailing carriage return is stripped so a file checked out with CRLF endings
     * yields the same snippet as one with LF — the test matrix includes Windows.
     */
    public lineAt(line: number): string {
        if (!Number.isInteger(line) || line < 1 || line > this.lineStarts.length) {
            throw new RangeError(`Line ${line} is outside the document (${this.lineCount} lines)`);
        }
        const start = this.lineStarts[line - 1];
        const end = line < this.lineStarts.length ? this.lineStarts[line] : this.text.length;
        return stripLineTerminator(this.text.slice(start, end));
    }

    /**
     * Text of a one-based line, trimmed and truncated for use as evidence.
     *
     * @param maxLength Maximum length of the returned snippet, ellipsised when exceeded.
     */
    public snippetAt(line: number, maxLength = 200): string {
        return truncate(this.lineAt(line).trim(), maxLength);
    }

    /** Index into {@link lineStarts} of the line containing `offset`. */
    private lineIndexOf(offset: number): number {
        let low = 0;
        let high = this.lineStarts.length - 1;
        while (low < high) {
            const mid = (low + high + 1) >> 1;
            if (this.lineStarts[mid] <= offset) {
                low = mid;
            } else {
                high = mid - 1;
            }
        }
        return low;
    }

    private static computeLineStarts(text: string): number[] {
        const starts = [0];
        for (let i = 0; i < text.length; i += 1) {
            if (text.charCodeAt(i) === 0x0a) {
                starts.push(i + 1);
            }
        }
        return starts;
    }
}

/**
 * One-based line number of the first line matching `needle`, or null.
 *
 * Used where a value has no parser-reported position — a dependency key in a manifest,
 * a pinned version inside a Dockerfile `RUN`. Returning null rather than throwing lets
 * a collector emit the finding with a null line instead of dropping it (REQ-ERR-030).
 *
 * @param needle A literal substring, or a pattern. A non-global pattern is matched per
 * line; a global one is reset before each line so it cannot skip matches.
 */
export function findLineOf(text: string, needle: string | RegExp): number | null {
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
        const line = stripLineTerminator(lines[i]);
        if (typeof needle === 'string' ? line.includes(needle) : matches(needle, line)) {
            return i + 1;
        }
    }
    return null;
}

/**
 * One-based line numbers of every line matching `needle`, in order.
 *
 * A Dockerfile can pin the same tool more than once across build stages, and each
 * occurrence is separately maintainable.
 */
export function findAllLinesOf(text: string, needle: string | RegExp): number[] {
    const lines = text.split('\n');
    const found: number[] = [];
    for (let i = 0; i < lines.length; i += 1) {
        const line = stripLineTerminator(lines[i]);
        if (typeof needle === 'string' ? line.includes(needle) : matches(needle, line)) {
            found.push(i + 1);
        }
    }
    return found;
}

/** Test a pattern against a line, resetting `lastIndex` so a global flag is harmless. */
function matches(pattern: RegExp, line: string): boolean {
    pattern.lastIndex = 0;
    return pattern.test(line);
}

/** Remove a trailing LF and/or CR, so CRLF and LF documents behave identically. */
function stripLineTerminator(value: string): string {
    let end = value.length;
    if (end > 0 && value.charCodeAt(end - 1) === 0x0a) {
        end -= 1;
    }
    if (end > 0 && value.charCodeAt(end - 1) === 0x0d) {
        end -= 1;
    }
    return end === value.length ? value : value.slice(0, end);
}
