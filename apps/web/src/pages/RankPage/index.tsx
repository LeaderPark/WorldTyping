// spec: docs/01 §10.2(S8 리더보드 와이어프레임), docs/03 §4.1(lazy route)·§4.3(leaderboard 스토어),
//       docs/06 §1.1(board_key 4차원)·§1.4(조회 계약 — keyset·rank-of-me), docs/00 §11-D9·D68,
//       WT-M2-05(스텁) → WT-M3-06(실 배선) → WT-AUTH-04(랭킹 게이팅) → WT-RANK-SIMPLIFY(필터 단순화)
//
// [WT-RANK-SIMPLIFY] 기간/기기/지역 필터 UI를 삭제하고 단일 보드만 노출한다 — board_key의 4차원
// 자체는 그대로(docs/06 §1.1)이되 기간은 'all' 고정, 플랫폼은 마운트 시점의 사용자 기기
// (settingsPlatform) 고정, 지역(scope)은 항상 global(geo 파라미터 미전송)이다. 모드·언어(KO/EN)만
// 사용자가 바꿀 수 있다. keyset 커서 무한 스크롤 + 내 행 고정 표시(§8 wireframe
// "841 나 (GUEST_4821) … ← 고정 표시")는 그대로 유지한다.
//
// [WT-AUTH-04] 랭킹 등재는 로그인 계정 전용(§11-D68-①) — 비로그인은 "내 순위" 고정 표시 자리에
// 로그인 CTA(rank-login-cta)를 대신 그린다(비로그인 제출은 항상 practice 강등이라 onBoard일 수
// 없다).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Continent, DifficultyTier } from '@wt/shared';
import { selectIsLoggedIn, useAuthStore } from '../../stores/auth';
import { useSettingsStore } from '../../stores/settings';
import { PageHeader } from '../../components/PageHeader';
import {
  buildBoardKey,
  ensureSession,
  fetchLbMe,
  fetchLbPage,
  fetchSessionMe,
  type LbEntry,
  type LbMeRes,
} from '../../net/api-client';

const CONTINENTS: readonly Continent[] = ['asia', 'europe', 'africa', 'north-america', 'south-america', 'oceania'];
const TIERS: readonly DifficultyTier[] = [1, 2, 3, 4, 5];

interface ModeOption {
  key: string;
  label: string;
}

export function RankPage() {
  const { t } = useTranslation();
  const guestId = useSettingsStore((s) => s.guestId);
  const settingsLang = useSettingsStore((s) => s.lang);
  const settingsPlatform = useSettingsStore((s) => s.platform);
  // [WT-AUTH-04] 랭킹 등재는 로그인 계정만 대상(§11-D68-①) — 비로그인은 "내 순위"에 등재된 값이
  // 있을 수 없으므로(guest 제출은 항상 practice 강등) 그 자리에 로그인 CTA를 대신 그린다.
  const isLoggedIn = useAuthStore(selectIsLoggedIn);
  const openLogin = useAuthStore((s) => s.openLogin);

  const modeOptions = useMemo<ModeOption[]>(
    () => [
      ...CONTINENTS.map((c) => ({ key: `continent:${c}`, label: `${t('mode.continent.title')} · ${t(`continent.${c}`)}` })),
      ...TIERS.map((tier) => ({ key: `tier:${tier}`, label: t('rank.tierOption', { tier }) })),
      { key: 'worldtour', label: t('rank.worldtourOption') },
    ],
    [t],
  );

  const [modeKey, setModeKey] = useState<string>('worldtour');
  const [lang, setLang] = useState<'ko' | 'en'>(settingsLang);
  // [WT-RANK-SIMPLIFY] 기기 필터 UI 삭제 — 마운트 시점의 사용자 기기(settingsPlatform)로 1회
  // 고정한다(반응형 재조회 불필요).
  const [platform] = useState<'desktop' | 'mobile'>(settingsPlatform);

  // [WT-RANK-SIMPLIFY] 기간은 'all' 고정.
  const board = useMemo(() => buildBoardKey(modeKey, lang, platform, 'all'), [modeKey, lang, platform]);

  const [entries, setEntries] = useState<LbEntry[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [total, setTotal] = useState(0);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [me, setMe] = useState<LbMeRes | null>(null);
  const [myPlayerId, setMyPlayerId] = useState<string | null>(null);

  // 내 pid 자기 조회(행 하이라이트 판정용) — 마운트 1회. 세션이 아직 없으면(직접 진입 등)
  // ensureSession으로 확보를 시도하고, 그래도 실패(오프라인)하면 조용히 하이라이트를 생략한다.
  useEffect(() => {
    let cancelled = false;
    void ensureSession(guestId)
      .then(() => fetchSessionMe())
      .then((res) => {
        if (cancelled) return;
        setMyPlayerId(res.playerId);
      })
      .catch(() => {
        // 비로그인 조회(랭킹은 비인증 GET도 허용) — 하이라이트만 못 할 뿐 화면은 정상 동작.
      });
    return () => {
      cancelled = true;
    };
    // guestId는 세션 수명 동안 불변(설정 스토어 1회 생성값) — 마운트 시 1회만 시도.
  }, []);

  // 필터가 바뀌면 첫 페이지부터 다시 조회.
  useEffect(() => {
    let cancelled = false;
    setStatus('loading');
    setEntries([]);
    setNextCursor(null);
    setMe(null);

    fetchLbPage(board, {})
      .then((res) => {
        if (cancelled) return;
        setEntries(res.entries);
        setNextCursor(res.nextCursor);
        setTotal(res.total);
        setStatus('ready');
      })
      .catch(() => {
        if (!cancelled) setStatus('error');
      });

    // fetchLbMe는 인증 필요(requireAuth) — 부팅의 세션 부트스트랩과의 경합을 피하려고 먼저
    // ensureSession으로 확정 짓는다(이미 성공했다면 즉시 resolve, 위 pid 자기 조회와 동일 이유).
    void ensureSession(guestId)
      .then(() => fetchLbMe(board, {}))
      .then((res) => {
        if (!cancelled) setMe(res);
      })
      .catch(() => {
        // 내 순위 조회 실패는 비치명적 — 목록만으로도 화면은 유효하다.
      });

    return () => {
      cancelled = true;
    };
  }, [board]);

  const loadMore = useCallback(() => {
    if (!nextCursor) return;
    fetchLbPage(board, { cursor: nextCursor })
      .then((res) => {
        setEntries((prev) => [...prev, ...res.entries]);
        setNextCursor(res.nextCursor);
      })
      .catch(() => {
        // 추가 페이지 실패는 조용히 무시 — "더 보기" 버튼이 남아 재시도 가능.
      });
  }, [board, nextCursor]);

  // 무한 스크롤(§4.3): sentinel이 뷰포트에 들어오면 자동으로 다음 페이지를 당긴다.
  // IntersectionObserver 미지원 환경(구형 브라우저·일부 테스트 환경)에서는 조용히 no-op —
  // "더 보기" 버튼이 항상 동일 loadMore를 트리거하는 폴백이라 기능은 그대로 보존된다.
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || typeof IntersectionObserver !== 'function') return;
    const obs = new IntersectionObserver((obsEntries) => {
      if (obsEntries.some((e) => e.isIntersecting)) loadMore();
    });
    obs.observe(el);
    return () => obs.disconnect();
  }, [loadMore, entries.length]);

  const myRowInPage = myPlayerId ? entries.find((e) => e.userId === myPlayerId) : undefined;
  // [§11-D88] 고정 "내 순위" 행 표시명 = 계정(Google) 닉네임. 이 행은 me?.onBoard(로그인 계정)일
  // 때만 렌더되므로(아래 조건) 실질 항상 계정 닉이며, GUEST_ 폴백은 표시 전용 방어다(서버 전송 없음).
  const nickname = useAuthStore((s) => s.nickname) ?? `GUEST_${guestId.slice(0, 4).toUpperCase()}`;

  return (
    <main className="wt-rank-page wt-page" data-testid="rank-page">
      <PageHeader title={t('rank.title')} />

      <div className="wt-rank-page__filters" data-testid="rank-filters">
        <select
          className="wt-rank-page__mode-select"
          data-testid="rank-filter-mode"
          value={modeKey}
          onChange={(e) => setModeKey(e.target.value)}
          aria-label={t('rank.modeFilter', { route: '' })}
        >
          {modeOptions.map((o) => (
            <option key={o.key} value={o.key}>
              {o.label}
            </option>
          ))}
        </select>

        <div role="group" aria-label="lang" data-testid="rank-filter-lang">
          {(['ko', 'en'] as const).map((l) => (
            <button
              key={l}
              type="button"
              className={`wt-pill${lang === l ? ' wt-pill--active' : ''}`}
              aria-pressed={lang === l}
              data-testid={`rank-lang-${l}`}
              onClick={() => setLang(l)}
            >
              {t(`settings.inputLang.${l}`)}
            </button>
          ))}
        </div>
      </div>

      {status === 'error' && (
        <p className="wt-rank-page__error" data-testid="rank-error">
          {t('rank.error')}
        </p>
      )}
      {status === 'ready' && entries.length === 0 && (
        <p className="wt-rank-page__empty" data-testid="rank-empty">
          {t('rank.empty')}
        </p>
      )}

      {entries.length > 0 && (
        <table className="wt-rank-table wt-card" data-testid="rank-table">
          <thead>
            <tr>
              <th>{t('rank.col.rank')}</th>
              <th>{t('rank.col.nickname')}</th>
              <th>{t('rank.col.score')}</th>
              <th>{t('rank.col.time')}</th>
              <th>{t('rank.col.accuracy')}</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((row) => (
              <tr
                key={row.userId}
                data-testid={`rank-row-${row.userId}`}
                className={row.userId === myPlayerId ? 'wt-rank-table__row--me' : undefined}
              >
                <td>{row.rank}</td>
                <td>{row.userId === myPlayerId ? t('rank.me', { nickname: row.nickname }) : row.nickname}</td>
                <td>{row.score}</td>
                <td>{(row.elapsedMs / 1000).toFixed(1)}s</td>
                <td>{(row.accMilli / 10).toFixed(1)}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {/* [WT-AUTH-04] 비로그인은 등재된 "내 순위"가 있을 수 없다 — 로그인 CTA로 대체(§11-D68-①). */}
      {!isLoggedIn ? (
        <button
          type="button"
          data-testid="rank-login-cta"
          className="wt-pill"
          onClick={() => openLogin('ranking')}
        >
          {t('rank.loginCta')}
        </button>
      ) : (
        // 내 행이 현재 페이지 밖(상위 50 밖)이면 순위 요약만 고정 표시(§8 wireframe "← 고정 표시").
        !myRowInPage &&
        me?.onBoard &&
        me.rank !== null && (
          <p className="wt-rank-page__my-row" data-testid="rank-my-row-pinned">
            {t('rank.me', { nickname })} — {t('result.rank.value', { rank: me.rank, percent: me.percentile !== null ? Math.round(me.percentile * 100) : 0 })}
          </p>
        )
      )}

      {nextCursor && (
        <button type="button" className="wt-pill wt-rank-page__load-more" data-testid="rank-load-more" onClick={loadMore}>
          {t('rank.loadMore')}
        </button>
      )}
      <div ref={sentinelRef} data-testid="rank-scroll-sentinel" aria-hidden="true" />

      <p className="wt-rank-page__total" data-testid="rank-total">
        {total}
      </p>
    </main>
  );
}

// React Router v6.4+ lazy route 계약: 모듈이 `Component`를 named export해야 한다(router.tsx).
export { RankPage as Component };
