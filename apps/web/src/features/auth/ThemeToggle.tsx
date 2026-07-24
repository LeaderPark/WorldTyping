// spec: docs/00 §11-D68-⑥(기어 위치=라이트/다크 토글, SettingsOverlay 제거)·D57(라이트 기본) +
//       WT-AUTH-03
//
// 상단바/홈 헤더 공용 테마 토글 버튼. 라이트일 때 달(🌙 — 누르면 다크로), 다크일 때 해(☀ — 누르면
// 라이트로)를 보여준다. aria-pressed=다크 활성 여부. 설정 스토어 theme만 읽고 토글하는 저빈도 액션.

import { useTranslation } from 'react-i18next';
import { useSettingsStore } from '../../stores/settings';

export function ThemeToggle({ className }: { className?: string }) {
  const { t } = useTranslation();
  const theme = useSettingsStore((s) => s.theme);
  const setTheme = useSettingsStore((s) => s.setTheme);
  const isDark = theme === 'dark';

  return (
    <button
      type="button"
      data-testid="theme-toggle"
      aria-pressed={isDark}
      aria-label={t('theme.toggle')}
      className={`wt-icon-tile${className ? ` ${className}` : ''}`}
      onClick={() => setTheme(isDark ? 'light' : 'dark')}
    >
      <span aria-hidden="true">{isDark ? '☀' : '🌙'}</span>
    </button>
  );
}
