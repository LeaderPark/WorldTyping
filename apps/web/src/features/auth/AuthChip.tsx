// spec: docs/00 §11-D68-⑥(크롬 — 로그인/프로필) + WT-AUTH-03(TopBar: [로그인 버튼|프로필 칩])
//
// 상단바/홈 헤더 공용 인증 컨트롤. 비로그인 → 로그인 버튼(topbar-login, openLogin). 로그인 →
// 프로필 칩(topbar-profile: 아바타+닉네임) 클릭 시 드롭다운으로 로그아웃(topbar-logout). 드롭다운은
// 바깥 클릭/ESC로 닫힌다. 저빈도 UI 상태(open)라 로컬 useState로 충분(§4.5 무관).

import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { selectIsLoggedIn, useAuthStore } from '../../stores/auth';

export function AuthChip({ className }: { className?: string }) {
  const { t } = useTranslation();
  const isLoggedIn = useAuthStore(selectIsLoggedIn);
  const nickname = useAuthStore((s) => s.nickname);
  const picture = useAuthStore((s) => s.profile?.picture ?? null);
  const openLogin = useAuthStore((s) => s.openLogin);
  const logout = useAuthStore((s) => s.logout);

  const [menuOpen, setMenuOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (e: PointerEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [menuOpen]);

  if (!isLoggedIn) {
    return (
      <button
        type="button"
        data-testid="topbar-login"
        className={`wt-pill wt-pill--compact${className ? ` ${className}` : ''}`}
        onClick={() => openLogin('general')}
      >
        {t('auth.login')}
      </button>
    );
  }

  const label = nickname ?? '';
  const initial = label.slice(0, 1).toUpperCase() || '?';

  return (
    <div ref={rootRef} className={`wt-auth-chip${className ? ` ${className}` : ''}`} style={{ position: 'relative' }}>
      <button
        type="button"
        data-testid="topbar-profile"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        className="wt-pill wt-pill--compact"
        onClick={() => setMenuOpen((v) => !v)}
      >
        {picture ? (
          <img
            src={picture}
            alt=""
            width={20}
            height={20}
            referrerPolicy="no-referrer"
            style={{ borderRadius: '9999px', display: 'inline-block', verticalAlign: 'middle' }}
          />
        ) : (
          <span
            aria-hidden="true"
            style={{
              display: 'inline-flex',
              width: 20,
              height: 20,
              borderRadius: '9999px',
              alignItems: 'center',
              justifyContent: 'center',
              background: 'var(--accent)',
              color: '#fff',
              fontSize: 12,
              fontWeight: 700,
            }}
          >
            {initial}
          </span>
        )}
        <span style={{ marginInlineStart: 6 }}>{label}</span>
      </button>

      {menuOpen && (
        <div
          role="menu"
          className="wt-card"
          style={{ position: 'absolute', insetInlineEnd: 0, top: 'calc(100% + 6px)', zIndex: 40, padding: 8, minWidth: 140 }}
        >
          <button
            type="button"
            role="menuitem"
            data-testid="topbar-logout"
            className="wt-pill wt-pill--compact"
            style={{ width: '100%' }}
            onClick={() => {
              setMenuOpen(false);
              logout();
            }}
          >
            {t('auth.logout')}
          </button>
        </div>
      )}
    </div>
  );
}
