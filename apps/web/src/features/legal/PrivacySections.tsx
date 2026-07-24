// spec: docs/00 §11-D72(footer 법적 모달 — privacy 구성은 페이지·모달 동일), §11-D68-⑥(데이터
//       열람/삭제 셀프서비스 의무 UI), docs/06 §6.3, 설계 §3.2
//
// PrivacyPage/index.tsx에 있던 MyDataSection·크레딧 섹션을 그대로 이동한다(로직·testid·i18n 키·
// 2단계 확인 계약 무변경). LegalArticle이 doc==='privacy'일 때 이 두 섹션을 렌더하므로, footer
// 모달과 /privacy 페이지가 동일한 데이터 열람/삭제 의무 UI를 공유한다(중복 0).
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { deleteMyAccount, fetchMyDataExport } from '../../net/api-client';
import { downloadJson } from '../../lib/download-json';

/**
 * [WT-AUTH-03, §11-D68-⑥] 데이터 열람/삭제 셀프서비스(docs/06 §6.3). 이전 S12 SettingsOverlay에서
 * PrivacyPage 하단으로 이전됐고(WT-AUTH-03), 다시 여기(features/legal)로 이동해 페이지·모달이
 * 공유한다 — testid/로직/2단계 확인 계약은 그대로 승계한다. "내 데이터 내려받기"는 즉시 다운로드,
 * "데이터 초기화 및 삭제"는 2단계 확인 후 DELETE /users/me + localStorage 전체 삭제 + 새로고침으로
 * 새 신원처럼 부팅되게 한다.
 */
export function MyDataSection() {
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

/**
 * 크레딧 최소 고지 섹션. notice.disputed(i18n) + ODbL/Natural Earth/flag-icons 고지(docs/02 §2·§12).
 * 전체 크레딧 페이지(라이선스 전문 링크 포함)는 /credits(WT-M6-06)가 신설했다 — 여기는 방침에
 * 요구되는 최소 고지 + 그 페이지로의 링크만 유지한다. 모달에서 이 링크를 누르면 라우트가 바뀌고
 * LegalModal의 pathname effect가 모달을 자동으로 닫는다(자연스러운 "전체 크레딧 페이지로 이동").
 */
export function PrivacyCreditsSection() {
  const { t } = useTranslation();
  return (
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
  );
}
