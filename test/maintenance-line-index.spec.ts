import { LineIndex, findAllLinesOf, findLineOf } from '../src/maintenance/text/line-index';

const DOCUMENT = ['jobs:', '  lint:', '    steps:', '      - uses: actions/checkout@v4', ''].join(
    '\n',
);

describe('LineIndex', () => {
    describe('offsetToLineCol', () => {
        it('should report one-based line and column, as a reviewer counts [REQ-EVI-002]', () => {
            const index = new LineIndex(DOCUMENT);

            expect(index.offsetToLineCol(0)).toEqual({ line: 1, column: 1 });
            expect(index.offsetToLineCol(DOCUMENT.indexOf('lint:'))).toEqual({
                line: 2,
                column: 3,
            });
            expect(index.offsetToLineCol(DOCUMENT.indexOf('actions/checkout@v4'))).toEqual({
                line: 4,
                column: 15,
            });
        });

        it('should accept the end-of-document offset', () => {
            const index = new LineIndex(DOCUMENT);

            expect(() => index.offsetToLineCol(DOCUMENT.length)).not.toThrow();
        });

        it.each([
            ['a negative offset', -1],
            ['an offset past the end', DOCUMENT.length + 1],
            ['a fractional offset', 1.5],
        ])('should reject %s rather than guess a line', (_label, offset: number) => {
            expect(() => new LineIndex(DOCUMENT).offsetToLineCol(offset)).toThrow(RangeError);
        });

        it('should handle a document with no newline at all', () => {
            const index = new LineIndex('single line');

            expect(index.lineCount).toBe(1);
            expect(index.offsetToLineCol(6)).toEqual({ line: 1, column: 7 });
        });

        it('should handle an empty document', () => {
            const index = new LineIndex('');

            expect(index.lineCount).toBe(1);
            expect(index.length).toBe(0);
            expect(index.offsetToLineCol(0)).toEqual({ line: 1, column: 1 });
        });

        it('should expose the largest valid offset as its length', () => {
            const index = new LineIndex(DOCUMENT);

            expect(index.length).toBe(DOCUMENT.length);
            expect(() => index.offsetToLineCol(index.length)).not.toThrow();
        });

        it('should stay correct across many lines, where the binary search matters', () => {
            const text = Array.from({ length: 500 }, (_unused, i) => `line ${i + 1}`).join('\n');
            const index = new LineIndex(text);

            expect(index.lineOf(text.indexOf('line 250'))).toBe(250);
            expect(index.lineOf(text.indexOf('line 500'))).toBe(500);
        });
    });

    describe('lineAt', () => {
        it('should return the line without its terminator', () => {
            expect(new LineIndex(DOCUMENT).lineAt(2)).toBe('  lint:');
        });

        it('should return the final line when the file has no trailing newline', () => {
            const index = new LineIndex('first\nlast line');

            expect(index.lineCount).toBe(2);
            expect(index.lineAt(2)).toBe('last line');
        });

        it('should strip a carriage return so CRLF checkouts match LF ones', () => {
            const crlf = new LineIndex('jobs:\r\n  lint:\r\n');

            expect(crlf.lineAt(1)).toBe('jobs:');
            expect(crlf.lineAt(2)).toBe('  lint:');
        });

        it.each([
            ['line zero', 0],
            ['a line past the end', 99],
        ])('should reject %s', (_label, line: number) => {
            expect(() => new LineIndex(DOCUMENT).lineAt(line)).toThrow(RangeError);
        });
    });

    describe('snippetAt', () => {
        it('should trim surrounding whitespace for use as evidence [REQ-EVI-002]', () => {
            expect(new LineIndex(DOCUMENT).snippetAt(4)).toBe('- uses: actions/checkout@v4');
        });

        it('should truncate a long line to the requested budget', () => {
            const snippet = new LineIndex(`${'x'.repeat(500)}\n`).snippetAt(1, 50);

            expect(snippet).toHaveLength(50);
            expect(snippet.endsWith('…')).toBe(true);
        });

        it('should leave a line within budget untouched', () => {
            expect(new LineIndex('short\n').snippetAt(1, 50)).toBe('short');
        });
    });
});

describe('findLineOf', () => {
    it('should return the one-based line of the first match', () => {
        expect(findLineOf(DOCUMENT, 'actions/checkout')).toBe(4);
    });

    it('should return null when absent, so a collector can emit a null line [REQ-ERR-030]', () => {
        expect(findLineOf(DOCUMENT, 'actions/setup-node')).toBeNull();
    });

    it('should accept a pattern as well as a literal', () => {
        expect(findLineOf(DOCUMENT, /uses:\s+\S+@v\d+/)).toBe(4);
    });

    it('should not let a global pattern skip matches', () => {
        const pattern = /v\d+/g;

        expect(findLineOf(DOCUMENT, pattern)).toBe(4);
        expect(findLineOf(DOCUMENT, pattern)).toBe(4);
    });

    it('should match against CRLF documents identically', () => {
        expect(findLineOf('a: 1\r\nb: 2\r\n', 'b: 2')).toBe(2);
    });
});

describe('findAllLinesOf', () => {
    const dockerfile = [
        'FROM base AS build',
        'ENV KUBECTL_VERSION=v1.31.4',
        'FROM base AS runtime',
        'ENV KUBECTL_VERSION=v1.31.4',
    ].join('\n');

    it('should return every matching line in order', () => {
        expect(findAllLinesOf(dockerfile, 'KUBECTL_VERSION')).toEqual([2, 4]);
    });

    it('should return an empty array when nothing matches', () => {
        expect(findAllLinesOf(dockerfile, 'HELM_VERSION')).toEqual([]);
    });

    it('should accept a pattern', () => {
        expect(findAllLinesOf(dockerfile, /^FROM /)).toEqual([1, 3]);
    });
});
