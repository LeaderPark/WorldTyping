// spec: docs/01 §10.1(S1 홈/S2 언어 게이트), docs/03 §4.2(HomePage 트리 — LanguageGateOverlay
//       nested), §8.1(lang 설정 동기화), WT-M2-05
//
// M2-05는 골격만 — 지도 히어로/모드카드/데일리뱃지/티커는 이후 홈 화면 작업이 채운다.
// 여기서는 라우트 진입점 + S2 언어 게이트만 완성한다(acceptance: "언어 게이트 1회 표시 후
// 재방문 시 미표시").

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { hasChosenLanguage, useSettingsStore } from '../stores/settings';

export function HomePage() {
  const { t } = useTranslation();
  return (
    <main className="p-8">
      <h1 className="text-2xl font-bold">{t('app.title')}</h1>
      <LanguageGateOverlay />
    </main>
  );
}

/** S2 — localStorage 'wt:lang' 부재 시 1회 표시(docs/03 §4.2). */
function LanguageGateOverlay() {
  const { t } = useTranslation();
  const setLang = useSettingsStore((s) => s.setLang);
  const [dismissed, setDismissed] = useState(false);

  if (dismissed || hasChosenLanguage()) return null;

  const choose = (lang: 'ko' | 'en') => {
    setLang(lang);
    setDismissed(true);
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="language-gate"
      data-testid="language-gate"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
    >
      <div className="rounded-lg bg-white p-6 text-center dark:bg-slate-800">
        <p>{t('lang.selectPrompt.ko')}</p>
        <p>{t('lang.selectPrompt.en')}</p>
        <div className="mt-4 flex gap-3">
          <button type="button" data-testid="lang-ko" className="rounded border px-3 py-1" onClick={() => choose('ko')}>
            {t('lang.selectOption.ko')}
          </button>
          <button type="button" data-testid="lang-en" className="rounded border px-3 py-1" onClick={() => choose('en')}>
            {t('lang.selectOption.en')}
          </button>
        </div>
        <p className="mt-3 text-xs opacity-70">{t('lang.select.hint')}</p>
      </div>
    </div>
  );
}
