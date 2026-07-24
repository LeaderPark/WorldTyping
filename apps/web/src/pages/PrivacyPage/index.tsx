// spec: docs/06 §6.5(개인정보처리방침 페이지 아웃라인 11항 — ko/en 병기 정적 단일 페이지),
//       docs/00 §11-D18(런칭명 TypeTrip), WT-M2-05(스텁 대체) + WT-M6-01
//
// 정적 단일 페이지 — 한국어 본문 전체 다음 영문 본문 전체를 그대로 이어 붙인다(metrotyping.kr/privacy
// 관행과 동일, §6.5 아웃라인 지시). 본문(privacy.{ko,en}.md)은 §6.5의 11항 + 부칙을 실문안으로
// 담고, 운영 주체·연락처는 리드/사용자가 확정할 때까지 {PLACEHOLDER} 마커로 남겨둔다(§3 세션
// 조정 지시). 라우팅은 이전과 동일하게 non-lazy `element`(router.tsx, router-config.test.ts
// "Home/ModeSelect/TrackSelect/Privacy는 eager" 불변식 유지) — 텍스트 위주 페이지라 엔트리
// 예산(<170KB gzip)에 미치는 영향이 미미해 별도 청크 분리 이득이 적다.
//
// [WT-UI-09 라이트 스킴 점검] 구분선 두 곳이 border-slate-300/dark:border-slate-700 원색을
// 직접 하드코딩하고 있었다(D57 이전 잔재 — 다른 하드코딩은 이미 WT-UI-01/D62가 --text-muted로
// 정리했지만 이 두 <hr>은 그때 누락됐다). tokens.css --border(라이트 #e3e6db/다크 #334155)를
// 참조하는 border-border 유틸로 교체 — 값 자체는 슬레이트와 육안상 거의 동일해 시각 델타는
// 미세하지만, 토큰 회귀 가드(테마 전환·향후 팔레트 조정)에 편입된다는 점이 핵심이다.
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { deleteMyAccount, fetchMyDataExport } from '../../net/api-client';
import { downloadJson } from '../../lib/download-json';
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

/**
 * [WT-AUTH-03, §11-D68-⑥] 데이터 열람/삭제 셀프서비스(docs/06 §6.3). 이전 S12 SettingsOverlay에서
 * 이 페이지 하단으로 이전됐다 — testid/로직/2단계 확인 계약은 그대로 승계한다. "내 데이터 내려받기"는
 * 즉시 다운로드, "데이터 초기화 및 삭제"는 2단계 확인 후 DELETE /users/me + localStorage 전체 삭제
 * + 새로고침으로 새 신원처럼 부팅되게 한다.
 */
function MyDataSection() {
  const { t } = useTranslation();
  const [status, setStatus] = useState<
    'idle' | 'exporting' | 'confirmingReset' | 'deleting' | 'deleted' | 'error'
  >('idle');

  const handleExport = async () => {
    setStatus('exporting');
    try {
      const data = await fetchMyDataExport();
      downloadJson(`typetrip-data-${Date.now()}.json`, data);
      setStatus('idle');
    } catch {
      setStatus('error');
    }
  };

  const handleResetConfirm = async () => {
    setStatus('deleting');
    try {
      await deleteMyAccount();
      setStatus('deleted');
      localStorage.clear();
      setTimeout(() => {
        window.location.reload();
      }, 1500);
    } catch {
      setStatus('error');
    }
  };

  return (
    <section aria-label={t('privacy.myData.heading')} data-testid="privacy-my-data">
      <h2 className="text-base font-semibold">{t('privacy.myData.heading')}</h2>
      <div className="mt-2 flex flex-col gap-2">
        <button
          type="button"
          data-testid="settings-data-export"
          className="rounded border px-3 py-1 text-left"
          disabled={status === 'exporting'}
          onClick={() => void handleExport()}
        >
          {t('settings.data.export')}
        </button>

        {status === 'confirmingReset' ? (
          <div className="rounded border border-red-400 p-3">
            <p className="text-sm font-semibold">{t('settings.resetConfirm.title')}</p>
            <p className="mt-1 text-sm">{t('settings.resetConfirm.body')}</p>
            <div className="mt-2 flex gap-2">
              <button
                type="button"
                data-testid="settings-data-reset-confirm"
                className="rounded border border-red-500 px-3 py-1 text-red-700 dark:text-red-400"
                onClick={() => void handleResetConfirm()}
              >
                {t('settings.resetConfirm.confirm')}
              </button>
              <button
                type="button"
                data-testid="settings-data-reset-cancel"
                className="rounded border px-3 py-1"
                onClick={() => setStatus('idle')}
              >
                {t('settings.resetConfirm.cancel')}
              </button>
            </div>
          </div>
        ) : status === 'deleting' || status === 'deleted' ? (
          <p role="status" data-testid="settings-data-reset-done" className="text-sm">
            {t('settings.resetConfirm.done')}
          </p>
        ) : (
          <button
            type="button"
            data-testid="settings-data-reset"
            className="rounded border px-3 py-1 text-left text-red-700 dark:text-red-400"
            onClick={() => setStatus('confirmingReset')}
          >
            {t('settings.data.reset')}
          </button>
        )}

        {status === 'error' && (
          <p role="alert" data-testid="settings-data-error" className="text-sm text-red-700 dark:text-red-400">
            {t('settings.data.error')}
          </p>
        )}
      </div>
    </section>
  );
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

  // WT-UI-01 독립 검증 FAIL 수정: 하드코딩 text-slate-500/dark:text-slate-400(#64748b on
  // --bg #f4f5ef = 4.34:1, WCAG AA 4.5:1 미달 — pnpm e2e의 e10-a11y.spec.ts가 axe
  // color-contrast serious로 실측 검출)를 --text-muted 토큰(tailwind.config.ts var() 매핑)으로
  // 교체한다. --text-muted 라이트 값 자체도 이 검증으로 재조정됨(tokens.css 주석 참조, D62) —
  // dark: 변형은 더 이상 필요 없다(토큰이 [data-theme='dark']에서 이미 반전).
  return (
    <div className="mx-auto max-w-2xl p-6">
      <h1 className="text-2xl font-bold" tabIndex={-1}>
        {t('settings.privacy')}
      </h1>

      <section aria-label={t('privacy.lang.ko')}>
        <h2 className="mt-4 text-base font-semibold uppercase tracking-wide text-text-muted">
          {t('privacy.lang.ko')}
        </h2>
        <MarkdownBody source={privacyKo} testId="privacy-body-ko" />
      </section>

      <hr className="my-8 border-border" />

      <section aria-label={t('privacy.lang.en')}>
        <h2 className="mt-4 text-base font-semibold uppercase tracking-wide text-text-muted">
          {t('privacy.lang.en')}
        </h2>
        <MarkdownBody source={privacyEn} testId="privacy-body-en" />
      </section>

      <hr className="my-8 border-border" />

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
        <p className="mt-2 text-sm text-text-muted">{t('notice.disputed')}</p>
        <p className="mt-1 text-sm">
          <Link to="/credits" data-testid="privacy-credits-link" className="underline">
            {t('credits.title')}
          </Link>
        </p>
      </section>

      <hr className="my-8 border-border" />

      {/* [WT-AUTH-03, §11-D68-⑥] 데이터 열람/삭제 셀프서비스(구 S12 설정 오버레이에서 이전). */}
      <MyDataSection />
    </div>
  );
}
