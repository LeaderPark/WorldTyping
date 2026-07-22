// spec: WT-M6-01 — markdown-lite.ts 파서 단위 테스트(순수 함수, DOM 불요).
import { describe, expect, it } from 'vitest';
import { parseInlineSegments, parseMarkdownLite } from './markdown-lite';

describe('parseInlineSegments', () => {
  it('returns a single non-bold segment when there is no **bold** marker', () => {
    expect(parseInlineSegments('plain text')).toEqual([{ text: 'plain text', bold: false }]);
  });

  it('splits leading/trailing text around a **bold** span', () => {
    expect(parseInlineSegments('before **loud** after')).toEqual([
      { text: 'before ', bold: false },
      { text: 'loud', bold: true },
      { text: ' after', bold: false },
    ]);
  });

  it('handles multiple bold spans in one line', () => {
    expect(parseInlineSegments('**a** mid **b**')).toEqual([
      { text: 'a', bold: true },
      { text: ' mid ', bold: false },
      { text: 'b', bold: true },
    ]);
  });
});

describe('parseMarkdownLite', () => {
  it('classifies a lone "# " line as an h1 heading', () => {
    expect(parseMarkdownLite('# Title')).toEqual([{ kind: 'heading', level: 1, text: 'Title' }]);
  });

  it('classifies "## "/"### " as h2/h3', () => {
    const blocks = parseMarkdownLite('## Section\n\n### Sub');
    expect(blocks).toEqual([
      { kind: 'heading', level: 2, text: 'Section' },
      { kind: 'heading', level: 3, text: 'Sub' },
    ]);
  });

  it('joins consecutive non-list/table lines into one paragraph block', () => {
    const blocks = parseMarkdownLite('line one\nline two');
    expect(blocks).toEqual([{ kind: 'paragraph', lines: ['line one', 'line two'] }]);
  });

  it('collects "- " lines into a list block, stripping the marker', () => {
    const blocks = parseMarkdownLite('- item a\n- item b\n- item c');
    expect(blocks).toEqual([{ kind: 'list', items: ['item a', 'item b', 'item c'] }]);
  });

  it('parses a pipe table (header + separator + rows), dropping the separator row', () => {
    const md = '| A | B |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |';
    const blocks = parseMarkdownLite(md);
    expect(blocks).toEqual([
      {
        kind: 'table',
        header: ['A', 'B'],
        rows: [
          ['1', '2'],
          ['3', '4'],
        ],
      },
    ]);
  });

  it('separates blocks on blank lines and preserves block order', () => {
    const md = '# Title\n\nsome paragraph\n\n- a\n- b\n\n| H |\n|---|\n| v |';
    const blocks = parseMarkdownLite(md);
    expect(blocks.map((b) => b.kind)).toEqual(['heading', 'paragraph', 'list', 'table']);
  });
});
