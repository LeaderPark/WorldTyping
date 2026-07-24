// spec: docs/06 §6.5(정적 단일 페이지 렌더링 방식), docs/00 §11-D68-⑨(/terms·/support 신설,
//       PrivacyPage와 동일한 md?raw + markdown-lite 파이프라인 재사용), WT-AUTH-06
//
// PrivacyPage/index.tsx(WT-M6-01)가 이미 markdown-lite.ts(순수 파서)를 소비하는 JSX 렌더러
// (BlockView/MarkdownBody)를 로컬로 갖고 있다 — 이 태스크(WT-AUTH-06)의 파일 소유권은
// "PrivacyPage(md)"로 한정되어 그 파일의 컴포넌트 코드를 옮기거나 export를 넓힐 수 없다
// (privacy.{ko,en}.md만 대상). 그래서 새로 생기는 TermsPage/SupportPage 두 곳이 함께 쓸 렌더러를
// 여기 components/에 둔다 — 파서(parseMarkdownLite/parseInlineSegments)는 PrivacyPage/markdown-lite.ts를
// 그대로 import해 재사용하고("markdown-lite 재구현 금지"), 그 결과 블록을 JSX로 그리는 표현
// 계층만 새로 둔다. PrivacyPage 자신은 이 컴포넌트를 쓰도록 바뀌지 않는다(그 파일은 이 태스크
// 범위 밖 — 무수정).
import { parseInlineSegments, parseMarkdownLite, type MdBlock } from '../pages/PrivacyPage/markdown-lite';

function InlineText({ line }: { line: string }) {
  return (
    <>
      {parseInlineSegments(line).map((seg, i) =>
        seg.bold ? <strong key={i}>{seg.text}</strong> : <span key={i}>{seg.text}</span>,
      )}
    </>
  );
}

function BlockView({ block, keyPrefix }: { block: MdBlock; keyPrefix: string }) {
  switch (block.kind) {
    case 'heading': {
      const Tag = (`h${Math.min(block.level + 1, 6)}`) as 'h2' | 'h3' | 'h4';
      return (
        <Tag className={block.level === 1 ? 'mt-8 text-xl font-bold' : 'mt-6 text-lg font-semibold'}>
          <InlineText line={block.text} />
        </Tag>
      );
    }
    case 'paragraph':
      return (
        <p className="mt-2 text-sm leading-relaxed">
          {block.lines.map((line, i) => (
            <span key={i}>
              {i > 0 && <br />}
              <InlineText line={line} />
            </span>
          ))}
        </p>
      );
    case 'list':
      return (
        <ul className="mt-2 list-disc pl-6 text-sm leading-relaxed">
          {block.items.map((item, i) => (
            <li key={i}>
              <InlineText line={item} />
            </li>
          ))}
        </ul>
      );
    case 'table':
      return (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr>
                {block.header.map((cell, i) => (
                  <th key={i} className="border-b px-2 py-1 text-left font-semibold">
                    <InlineText line={cell} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, ri) => (
                <tr key={`${keyPrefix}-row-${ri}`}>
                  {row.map((cell, ci) => (
                    <td key={ci} className="border-b px-2 py-1">
                      <InlineText line={cell} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
  }
}

/** md?raw 소스 1건을 markdown-lite 서브셋으로 파싱해 렌더한다(PrivacyPage/TermsPage/SupportPage 공용). */
export function MarkdownLiteBody({ source, testId }: { source: string; testId: string }) {
  const blocks = parseMarkdownLite(source);
  return (
    <div data-testid={testId}>
      {blocks.map((block, i) => (
        <BlockView key={i} block={block} keyPrefix={`b${i}`} />
      ))}
    </div>
  );
}
