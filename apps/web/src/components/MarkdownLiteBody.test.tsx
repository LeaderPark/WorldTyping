// @vitest-environment jsdom
// spec: WT-AUTH-06 — 공용 markdown-lite 렌더러(PrivacyPage/markdown-lite.ts 파서 재사용)
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { MarkdownLiteBody } from './MarkdownLiteBody';

afterEach(() => cleanup());

const SAMPLE = `# 제목

첫 문단 **강조** 텍스트입니다.

## 2. 소제목

- 항목 하나
- 항목 둘

| 열A | 열B |
|---|---|
| 1 | 2 |
`;

describe('MarkdownLiteBody', () => {
  it('renders headings, paragraphs (with bold), lists, and tables from the markdown-lite subset', () => {
    render(<MarkdownLiteBody source={SAMPLE} testId="md-body" />);
    const root = screen.getByTestId('md-body');

    const headings = within(root).getAllByRole('heading').map((h) => h.textContent);
    expect(headings).toContain('제목');
    expect(headings).toContain('2. 소제목');

    expect(within(root).getByText('강조').tagName).toBe('STRONG');

    const list = within(root).getByRole('list');
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);

    const table = within(root).getByRole('table');
    expect(table.textContent).toContain('열A');
    expect(table.textContent).toContain('1');
  });
});
