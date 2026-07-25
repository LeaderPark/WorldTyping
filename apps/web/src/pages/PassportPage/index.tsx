// spec: docs/01 §10.1(S13 여권)·§10.2("펼친 여권 2페이지 — 좌: 커버/닉네임/스트릭/PI 최고,
//       우: 스탬프 그리드")·§9.3(언락 트리)·§9.4(커버 12종·스탬프), docs/06 §4.3(서버 권위 unlock),
//       docs/00 §11-D9 + WT-M5-03
//
// 여권 = 서버가 확정한 unlock 목록의 읽기 전용 뷰(+커버 선택만 쓰기). 로컬 meta.ts 캐시는 참고용
// 표시 최적화일 뿐 이 화면의 진실 소스가 아니다 — 항상 GET /users/:id/passport를 다시 조회한다
// (docs/06 §4.3 "판정은 기록 제출 핸들러에서 서버 재계산 결과 기준으로만" — 조회도 동일 원칙).
import { useCallback, useEffect, useState } from 'react';
import type { CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import { Navigate } from 'react-router-dom';
import type { Continent, DifficultyTier } from '@wt/shared';
import { useSettingsStore } from '../../stores/settings';
import { selectIsLoggedIn, useAuthStore } from '../../stores/auth';
import { PageHeader } from '../../components/PageHeader';
import {
  ensureSession,
  fetchPassport,
  fetchSessionMe,
  putPassportCover,
  type PassportRes,
} from '../../net/api-client';
import { humanizeUnlockId } from '../../lib/format';

const CONTINENTS: readonly Continent[] = ['asia', 'europe', 'africa', 'north-america', 'south-america', 'oceania'];
const TIERS: readonly DifficultyTier[] = [1, 2, 3, 4, 5];

/** 고정 12노선(대륙 6 + 티어 5 + 세계일주 1) — achievements.ts가 이 범위만 stamp를 발급한다
 *  (구현 결정, 최종 보고 escalations 참조). */
const STAMP_ROUTES: readonly string[] = [
  ...CONTINENTS.map((c) => `continent:${c}`),
  ...TIERS.map((t) => `tier:${t}`),
  'worldtour',
];

/** WT-DC-06 ① — 스탬프 원(소유 시) 링/배경색 + 글리프. 대륙=대륙색, 티어=--grade-b, 일주=--grade-s
 *  (디자인 참조 L1620~1626의 색 배정을 시맨틱 토큰으로 옮긴 것 — 배경은 디자인의 리터럴 #ffffff
 *  대신 var(--surface)로 mix해 다크 테마에서도 성립하게 한다, .wt-rank-table__row--me와 동일 기법).
 *  잠금 상태는 --stamp-ring/--stamp-bg를 아예 지정하지 않아 globals.css 쪽 기본값
 *  (--border/--surface-sunken)으로 폴백한다. */
function stampOwnedVisual(route: string): { ring: string; bg: string; glyph: string } {
  if (route.startsWith('continent:')) {
    const continent = route.slice('continent:'.length);
    const color = `var(--continent-${continent})`;
    return { ring: color, bg: `color-mix(in srgb, ${color} 16%, var(--surface))`, glyph: '✓' };
  }
  if (route.startsWith('tier:')) {
    return {
      ring: 'var(--grade-b)',
      bg: 'color-mix(in srgb, var(--grade-b) 14%, var(--surface))',
      glyph: '✓',
    };
  }
  // 'worldtour'
  return {
    ring: 'var(--grade-s)',
    bg: 'color-mix(in srgb, var(--grade-s) 18%, var(--surface))',
    glyph: '✈',
  };
}

/** WT-DC-06 ① — 결정적 회전(±6deg). route id 문자열의 단순 해시로 -6~6deg를 얻는다(디자인
 *  L1620 공식 "((cid.length*7) % 13) - 6" 등의 값 범위를 일반화한 것, Math.random 금지 — 핵심
 *  함정 5의 "시드 결정성" 원칙과 같은 정신: 같은 route는 항상 같은 각도). */
function stampRotationDeg(route: string): number {
  let hash = 0;
  for (let i = 0; i < route.length; i += 1) {
    hash = (hash * 31 + route.charCodeAt(i)) | 0;
  }
  return (Math.abs(hash) % 13) - 6;
}

const DEFAULT_COVER = 'basic-green';
/** achievements.ts의 GRANTABLE_COVERS와 동일 목록(런타임 중복 정의 — @wt/shared 밖 서버 전용
 *  모듈이라 클라에서 import할 수 없다, workers/api/src/lib/achievements.ts 참조). */
const ALL_COVERS: readonly string[] = [
  DEFAULT_COVER,
  'continent-asia',
  'continent-europe',
  'continent-africa',
  'continent-north-america',
  'continent-south-america',
  'continent-oceania',
  'gold',
  'hologram',
  'streak-30',
  'streak-100',
];

type Status = 'loading' | 'ready' | 'error';

export function PassportPage() {
  const { t } = useTranslation();
  const guestId = useSettingsStore((s) => s.guestId);
  // [WT-PASSPORT-LOGIN-GATE v3, 리드 확정] 여권은 로그인 전용 기능(docs/00 §11-D68 계정 로그인 위) —
  // 정상 진입로는 HomePage의 카드 클릭 게이트(비로그인이면 네비게이션 자체를 막고 모달만 연다)라 이
  // 컴포넌트는 로그인 상태에서만 마운트되는 것이 보통이다. 그래도 딥링크/새로고침/뒤로가기 등으로
  // 비로그인 상태로 직접 도달할 수 있어(라우팅 차단은 HomePage 링크뿐 — 라우트 자체는 열려 있다),
  // 그 경우 렌더 자체를 하지 않고 즉시 홈으로 송환 + 로그인 모달을 연다(아래 렌더 분기).
  const isLoggedIn = useAuthStore(selectIsLoggedIn);
  const openLogin = useAuthStore((s) => s.openLogin);

  const [status, setStatus] = useState<Status>('loading');
  const [data, setData] = useState<PassportRes | null>(null);
  const [coverError, setCoverError] = useState(false);

  // 비로그인으로 도달한 마운트 1회만 로그인 모달을 "passport" 사유로 연다 — 아래서 즉시 <Navigate>로
  // 대체되어 이 컴포넌트가 언마운트되므로 재실행/재오픈 루프 우려가 없다(마운트 1회 = 인스턴스 수명 전체).
  useEffect(() => {
    if (!isLoggedIn) openLogin('passport');
  }, [isLoggedIn, openLogin]);

  useEffect(() => {
    if (!isLoggedIn) return; // 잠금 상태 — 서버 조회 자체를 하지 않는다.
    let cancelled = false;
    setStatus('loading');
    void ensureSession(guestId)
      .then(() => fetchSessionMe())
      .then((me) => fetchPassport(me.playerId))
      .then((res) => {
        if (cancelled) return;
        setData(res);
        setStatus('ready');
      })
      .catch(() => {
        if (!cancelled) setStatus('error');
      });
    return () => {
      cancelled = true;
    };
    // guestId는 세션 수명 동안 불변(설정 스토어 1회 생성값, RankPage와 동일 전제). isLoggedIn 전이
    // (로그인 성공)에 재실행되어 그 시점에 조회를 시작한다.
  }, [guestId, isLoggedIn]);

  const ownedCovers = new Set(
    (data?.unlocks ?? []).filter((u) => u.type === 'cover').map((u) => u.id.replace(/^cover:/, '')),
  );
  const ownedStampRoutes = new Set(
    (data?.unlocks ?? [])
      .filter((u) => u.type === 'stamp')
      .map((u) => u.id.split(':').slice(1, -1).join(':')), // 'stamp:continent:asia:A' → 'continent:asia'
  );
  const achievements = (data?.unlocks ?? []).filter((u) => u.type === 'achievement');

  const selectCover = useCallback(
    (coverId: string) => {
      setCoverError(false);
      putPassportCover(coverId)
        .then((res) => {
          setData((prev) => (prev ? { ...prev, passportCover: res.passportCover } : prev));
        })
        .catch(() => setCoverError(true));
    },
    [],
  );

  // 비로그인 도달 방어(위 주석) — 여권 화면은 렌더 자체를 하지 않고 홈으로 송환한다(라우팅 차단이
  // 아니라 게이트: 홈 카드가 이미 로그인 상태에서만 여기로 보내므로 정상 경로에서는 도달하지 않는다).
  if (!isLoggedIn) return <Navigate to="/" replace />;

  return (
    <main className="wt-passport-page wt-page" data-testid="passport-page">
      <PageHeader title={t('passport.title')} />

      {status === 'loading' && (
        <p data-testid="passport-loading">{t('passport.loading')}</p>
      )}
      {status === 'error' && (
        <p role="alert" data-testid="passport-error">
          {t('passport.error')}
        </p>
      )}

      {status === 'ready' && data && (
        <div className="wt-passport-page__spread">
          <section className="wt-passport-page__left" data-testid="passport-left">
            <p className="wt-passport-page__nickname" data-testid="passport-nickname">
              {data.nickname}
            </p>
            <p className="wt-passport-page__stat" data-testid="passport-streak">
              {t('passport.streak', { count: data.streakDaily })}
            </p>
            <p className="wt-passport-page__stat" data-testid="passport-best-pi">
              {data.bestPi !== null ? t('passport.bestPi', { pi: data.bestPi }) : t('passport.bestPi.none')}
            </p>

            <h2 className="wt-kicker">{t('passport.covers.title')}</h2>
            <ul className="wt-passport-page__covers" data-testid="passport-covers">
              {ALL_COVERS.map((coverId) => {
                const owned = coverId === DEFAULT_COVER || ownedCovers.has(coverId);
                const isCurrent = data.passportCover === coverId;
                return (
                  <li key={coverId}>
                    <button
                      type="button"
                      className={`wt-btn wt-cover-swatch wt-cover-swatch--${coverId}${isCurrent ? ' wt-btn--active' : ''}`}
                      data-testid={`passport-cover-${coverId}`}
                      disabled={!owned}
                      aria-pressed={isCurrent}
                      title={owned ? humanizeUnlockId(coverId) : t('passport.cover.locked')}
                      onClick={() => selectCover(coverId)}
                    >
                      {isCurrent ? t('passport.cover.current') : owned ? t('passport.cover.selectBtn') : t('passport.cover.locked')}
                    </button>
                  </li>
                );
              })}
            </ul>
            {coverError && (
              <p role="alert" data-testid="passport-cover-error">
                {t('passport.error')}
              </p>
            )}
          </section>

          <section className="wt-passport-page__right" data-testid="passport-right">
            <h2 className="wt-kicker">{t('passport.stamps.title')}</h2>
            {ownedStampRoutes.size === 0 ? (
              <p data-testid="passport-stamps-empty">{t('passport.stamps.empty')}</p>
            ) : (
              <ul className="wt-passport-page__stamps" data-testid="passport-stamps">
                {STAMP_ROUTES.map((route) => {
                  const owned = ownedStampRoutes.has(route);
                  const visual = owned ? stampOwnedVisual(route) : null;
                  const circleStyle = visual
                    ? ({
                        '--stamp-ring': visual.ring,
                        '--stamp-bg': visual.bg,
                        transform: `rotate(${stampRotationDeg(route)}deg)`,
                      } as CSSProperties)
                    : undefined;
                  return (
                    <li
                      key={route}
                      data-testid={`passport-stamp-${route}`}
                      className={`wt-token wt-passport-page__stamp${owned ? ' wt-passport-page__stamp--owned' : ' wt-token--locked'}`}
                    >
                      <span className="wt-token__circle" aria-hidden="true" style={circleStyle}>
                        {visual ? visual.glyph : '🔒'}
                      </span>
                      <span className="wt-token__label">{humanizeUnlockId(route)}</span>
                    </li>
                  );
                })}
              </ul>
            )}

            <h2 className="wt-kicker">{t('passport.achievements.title')}</h2>
            <p className="wt-passport-page__stat" data-testid="passport-achievements-count">
              {t('passport.achievements.count', { count: achievements.length })}
            </p>
            {achievements.length === 0 ? (
              <p data-testid="passport-achievements-empty">{t('passport.achievements.empty')}</p>
            ) : (
              <ul className="wt-passport-page__achievements" data-testid="passport-achievements">
                {achievements.map((a) => (
                  <li key={a.id} data-testid={`passport-achievement-${a.id}`}>
                    {humanizeUnlockId(a.id)}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      )}
    </main>
  );
}

// React Router v6.4+ lazy route 계약: 모듈이 `Component`를 named export해야 한다(router.tsx).
export { PassportPage as Component };
