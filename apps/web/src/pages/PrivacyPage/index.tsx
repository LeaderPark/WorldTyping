// spec: docs/06 §6.5(개인정보처리방침 페이지 아웃라인 11항 — ko/en 병기 정적 단일 페이지),
//       docs/00 §11-D18(런칭명 TypeTrip), WT-M2-05(스텁 대체) + WT-M6-01
//
// 정적 단일 페이지 — 한국어 본문 전체 다음 영문 본문 전체를 그대로 이어 붙인다(metrotyping.kr/privacy
// 관행과 동일, §6.5 아웃라인 지시). 본문(privacy.{ko,en}.md)은 §6.5의 11항 + 부칙을 실문안으로
// 담고, 운영 주체·연락처는 리드/사용자가 확정할 때까지 {PLACEHOLDER} 마커로 남겨둔다(§3 세션
// 조정 지시). 라우팅은 이전과 동일하게 non-lazy `element`(router.tsx, router-config.test.ts
// "Home/ModeSelect/TrackSelect/Privacy는 eager" 불변식 유지) — 텍스트 위주 페이지라 엔트리
// 예산(<170KB gzip)에 미치는 영향이 미미해 별도 청크 분리 이득이 적다.
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import privacyKo from './privacy.ko.md?raw';
import privacyEn from './privacy.en.md?raw';
import { parseInlineSegments, parseMarkdownLite, type MdBlock } from './markdown-lite';

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

function MarkdownBody({ source, testId }: { source: string; testId: string }) {
  const blocks = parseMarkdownLite(source);
  return (
    <div data-testid={testId}>
      {blocks.map((block, i) => (
        <BlockView key={i} block={block} keyPrefix={`b${i}`} />
      ))}
    </div>
  );
}

export function PrivacyPage() {
  const { t } = useTranslation();

  return (
    <div className="mx-auto max-w-2xl p-6">
      <h1 className="text-2xl font-bold" tabIndex={-1}>
        {t('settings.privacy')}
      </h1>

      <section aria-label={t('privacy.lang.ko')}>
        <h2 className="mt-4 text-base font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
          {t('privacy.lang.ko')}
        </h2>
        <MarkdownBody source={privacyKo} testId="privacy-body-ko" />
      </section>

      <hr className="my-8 border-slate-300 dark:border-slate-700" />

      <section aria-label={t('privacy.lang.en')}>
        <h2 className="mt-4 text-base font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
          {t('privacy.lang.en')}
        </h2>
        <MarkdownBody source={privacyEn} testId="privacy-body-en" />
      </section>

      <hr className="my-8 border-slate-300 dark:border-slate-700" />

      {/* 크레딧: notice.disputed(i18n) + ODbL/Natural Earth/flag-icons 고지(docs/02 §2·§12).
          전체 크레딧 페이지(라이선스 전문 링크 포함)는 WT-M6-06이 /credits로 신설했다 — 여기는
          방침 페이지에 요구되는 최소 고지 + 그 페이지로의 링크만 유지한다. */}
      <section aria-label={t('privacy.credits.heading')} data-testid="privacy-credits">
        <h2 className="text-base font-semibold">{t('privacy.credits.heading')}</h2>
        <ul className="mt-2 list-disc pl-6 text-sm leading-relaxed">
          <li>{t('privacy.credits.worldCountries')}</li>
          <li>{t('privacy.credits.naturalEarth')}</li>
          <li>{t('privacy.credits.flagIcons')}</li>
        </ul>
        <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">{t('notice.disputed')}</p>
        <p className="mt-1 text-sm">
          <Link to="/credits" data-testid="privacy-credits-link" className="underline">
            {t('credits.title')}
          </Link>
        </p>
      </section>
    </div>
  );
}
