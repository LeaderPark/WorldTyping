// spec: docs/03 §8.1(i18next 정적 import, settings.lang → i18n.changeLanguage 단방향 동기화),
//       docs/00 §11-D20(i18next+react-i18next 확정), WT-M2-05
//
// 카탈로그는 @wt/i18n 배럴을 그대로 정적 import(동적 로드 불요 — 합계 15KB 미만, §8.2).
// 동기화는 항상 단방향(settings → i18n). i18n 쪽에서 settings로 되돌리는 경로는 없다 —
// 언어 변경 UI는 항상 setLang()을 호출하고, i18n.changeLanguage는 그 결과를 반영만 한다.

import i18next from 'i18next';
import { type ReactNode, useEffect } from 'react';
import { I18nextProvider, initReactI18next } from 'react-i18next';
import { catalogs } from '@wt/i18n';
import { useSettingsStore } from '../stores/settings';

if (!i18next.isInitialized) {
  void i18next.use(initReactI18next).init({
    resources: {
      ko: { translation: catalogs.ko },
      en: { translation: catalogs.en },
    },
    lng: useSettingsStore.getState().lang,
    fallbackLng: 'en',
    // docs/03 §8.1: 카탈로그는 ICU 스타일 단일 중괄호 플레이스홀더(`{var}`) — i18next-icu 없이
    // 기본 interpolation의 prefix/suffix만 `{`/`}`로 맞추면 충분하다(i18next 기본값은 `{{var}}`).
    interpolation: { escapeValue: false, prefix: '{', suffix: '}' },
    returnNull: false,
  });
}

export function AppProviders({ children }: { children: ReactNode }) {
  const lang = useSettingsStore((s) => s.lang);

  useEffect(() => {
    void i18next.changeLanguage(lang);
  }, [lang]);

  return <I18nextProvider i18n={i18next}>{children}</I18nextProvider>;
}
