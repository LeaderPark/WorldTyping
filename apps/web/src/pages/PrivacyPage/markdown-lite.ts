// spec: docs/06 §6.5(방침 페이지는 정적 단일 페이지 — 별도 CMS/렌더러 불요), WT-M6-01
//
// privacy.{ko,en}.md는 순수 텍스트 자산(?raw import)이라 렌더링을 위한 최소 파서가 필요하다.
// react-markdown류 의존성을 새로 들이는 대신(법률 문서 1페이지에 그정도 무게는 과함) ATX 헤딩
// (#/##/###) · 문단 · "- " 불릿 리스트 · "|"로 시작하는 파이프 테이블 · **볼드** 인라인만 지원하는
// 최소 서브셋 파서를 직접 둔다. 이 파일은 순수 함수만 담아 index.tsx(JSX 렌더) 없이도
// 단위 테스트가 가능하다.

export type MdBlock =
  | { kind: "heading"; level: 1 | 2 | 3; text: string }
  | { kind: "paragraph"; lines: string[] }
  | { kind: "list"; items: string[] }
  | { kind: "table"; header: string[]; rows: string[][] };

export interface InlineSegment {
  text: string;
  bold: boolean;
}

const BOLD_RE = /\*\*(.+?)\*\*/g;

/** "**볼드**" 구간만 분리한다(그 외 인라인 마크다운은 지원 범위 밖 — 법률 문서 서식에 불요). */
export function parseInlineSegments(line: string): InlineSegment[] {
  const segments: InlineSegment[] = [];
  let lastIndex = 0;
  for (const match of line.matchAll(BOLD_RE)) {
    const idx = match.index ?? 0;
    if (idx > lastIndex) segments.push({ text: line.slice(lastIndex, idx), bold: false });
    segments.push({ text: match[1] ?? "", bold: true });
    lastIndex = idx + match[0].length;
  }
  if (lastIndex < line.length) segments.push({ text: line.slice(lastIndex), bold: false });
  if (segments.length === 0) segments.push({ text: line, bold: false });
  return segments;
}

function splitTableRow(line: string): string[] {
  const trimmed = line.trim();
  const inner = trimmed.startsWith("|") ? trimmed.slice(1) : trimmed;
  const withoutTrailing = inner.endsWith("|") ? inner.slice(0, -1) : inner;
  return withoutTrailing.split("|").map((cell) => cell.trim());
}

const SEPARATOR_ROW_RE = /^-+$/;

/**
 * 빈 줄로 구분된 블록 단위로 나눈 뒤 각 블록을 4종 중 하나로 분류한다. 순서 무관 — 실제
 * privacy.*.md 본문이 항상 이 서브셋 안에 있도록 작성한다(콘텐츠 쪽 책임, 파서는 관대하게
 * 실패하지 않고 최대한 paragraph로 폴백한다).
 */
export function parseMarkdownLite(source: string): MdBlock[] {
  const blocks: MdBlock[] = [];
  const rawBlocks = source.trim().split(/\n\s*\n/);

  for (const raw of rawBlocks) {
    const lines = raw
      .split("\n")
      .map((l) => l.trimEnd())
      .filter((l) => l.length > 0);
    if (lines.length === 0) continue;
    const first = lines[0] ?? "";

    const headingMatch = /^(#{1,3})\s+(.*)$/.exec(first);
    if (headingMatch && lines.length === 1) {
      const level = (headingMatch[1] ?? "#").length as 1 | 2 | 3;
      blocks.push({ kind: "heading", level, text: headingMatch[2] ?? "" });
      continue;
    }

    if (lines.every((l) => l.startsWith("|"))) {
      const rows = lines.map(splitTableRow);
      const header = rows[0] ?? [];
      const dataRows = rows.slice(1).filter((r) => !r.every((cell) => SEPARATOR_ROW_RE.test(cell)));
      blocks.push({ kind: "table", header, rows: dataRows });
      continue;
    }

    if (lines.every((l) => l.startsWith("- "))) {
      blocks.push({ kind: "list", items: lines.map((l) => l.slice(2)) });
      continue;
    }

    blocks.push({ kind: "paragraph", lines });
  }

  return blocks;
}
