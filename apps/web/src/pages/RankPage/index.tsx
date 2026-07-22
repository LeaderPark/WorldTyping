// spec: docs/01 §10.2(S8 리더보드 와이어프레임), docs/03 §4.1(lazy route)·§4.3(leaderboard 스토어),
//       docs/06 §1.1(board_key 4차원)·§1.4(조회 계약 — keyset·rank-of-me), docs/00 §11-D9,
//       WT-M2-05(스텁) → WT-M3-06(실 배선)
//
// [일간|주간|전체]×[모드]×[KO|EN]×[플랫폼] 필터 + keyset 커서 무한 스크롤 + 내 행 고정 표시(§8
// wireframe "841 나 (GUEST_4821) … ← 고정 표시"). 지역(scope) 탭은 v1 UI 요구사항(docs/03 §1.1
// "Global/내 지역(자동 감지) 두 탭")이나, 현재 세션 응답(GET /session/me)이 geo를 노출하지 않아
// "내 지역"은 비활성 스텁으로 남긴다(최종 보고 escalations 참조 — 세션 응답에 geo 필드 추가는
// 이 태스크의 산출물 범위(net/api-client.ts 등) 밖의 백엔드 변경이 필요하다).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Continent, DifficultyTier } from '@wt/shared';
import { useSettingsStore } from '../../stores/settings';
import {
  buildBoardKey,
  ensureSession,
  fetchLbMe,
  fetchLbPage,
  fetchSessionMe,
  type LbEntry,
  type LbMeRes,
  type LbPeriod,
} from '../../net/api-client';
import { kstDate, kstIsoWeek } from '../../lib/kst';

type PeriodTab = 'daily' | 'weekly' | 'alltime';

const CONTINENTS: readonly Continent[] = ['asia', 'europe', 'africa', 'north-america', 'south-america', 'oceania'];
const TIERS: readonly DifficultyTier[] = [1, 2, 3, 4, 5];

interface ModeOption {
  key: string;
  label: string;
}

function periodKeyFor(period: PeriodTab): LbPeriod {
  if (period === 'daily') return `d:${kstDate()}`;
  if (period === 'weekly') return `w:${kstIsoWeek()}`;
  return 'all';
}

export function RankPage() {
  const { t } = useTranslation();
  const guestId = useSettingsStore((s) => s.guestId);
  const settingsLang = useSettingsStore((s) => s.lang);
  const settingsPlatform = useSettingsStore((s) => s.platform);

  const modeOptions = useMemo<ModeOption[]>(
    () => [
      ...CONTINENTS.map((c) => ({ key: `continent:${c}`, label: `${t('mode.continent.title')} · ${t(`continent.${c}`)}` })),
      ...TIERS.map((tier) => ({ key: `tier:${tier}`, label: t('rank.tierOption', { tier }) })),
      { key: 'worldtour', label: t('rank.worldtourOption') },
    ],
    [t],
  );

  const [period, setPeriod] = useState<PeriodTab>('alltime');
  const [modeKey, setModeKey] = useState<string>('worldtour');
  const [lang, setLang] = useState<'ko' | 'en'>(settingsLang);
  const [platform, setPlatform] = useState<'desktop' | 'mobile'>(settingsPlatform);

  const board = useMemo(() => buildBoardKey(modeKey, lang, platform, periodKeyFor(period)), [modeKey, lang, platform, period]);

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
        if (!cancelled) setMyPlayerId(res.playerId);
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

    fetchLbPage(board)
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
      .then(() => fetchLbMe(board))
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
  const nickname = useSettingsStore((s) => s.nickname) || `GUEST_${guestId.slice(0, 4).toUpperCase()}`;

  return (
    <main className="wt-rank-page" data-testid="rank-page">
      <h1 className="wt-rank-page__title" tabIndex={-1}>{t('rank.title')}</h1>

      <div className="wt-rank-page__filters" data-testid="rank-filters">
        <div role="group" aria-label="period" data-testid="rank-filter-period">
          {(['daily', 'weekly', 'alltime'] as const).map((p) => (
            <button
              key={p}
              type="button"
              className={`wt-btn${period === p ? ' wt-btn--active' : ''}`}
              aria-pressed={period === p}
              data-testid={`rank-period-${p}`}
              onClick={() => setPeriod(p)}
            >
              {t(`rank.period.${p}`)}
            </button>
          ))}
        </div>

        <select
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
              className={`wt-btn${lang === l ? ' wt-btn--active' : ''}`}
              aria-pressed={lang === l}
              data-testid={`rank-lang-${l}`}
              onClick={() => setLang(l)}
            >
              {t(`settings.inputLang.${l}`)}
            </button>
          ))}
        </div>

        <div role="group" aria-label="platform" data-testid="rank-filter-platform">
          {(['desktop', 'mobile'] as const).map((p) => (
            <button
              key={p}
              type="button"
              className={`wt-btn${platform === p ? ' wt-btn--active' : ''}`}
              aria-pressed={platform === p}
              data-testid={`rank-platform-${p}`}
              onClick={() => setPlatform(p)}
            >
              {t(`rank.platformOpt.${p}`)}
            </button>
          ))}
        </div>

        <div role="group" aria-label="scope" data-testid="rank-filter-scope">
          <button type="button" className="wt-btn wt-btn--active" aria-pressed disabled>
            {t('rank.scope.global')}
          </button>
          {/* 지역 보드는 세션 응답에 geo가 없어 v1은 비활성 — 파일 상단 주석/escalations 참조. */}
          <button type="button" className="wt-btn" disabled title={t('rank.scope.mine')} data-testid="rank-scope-mine">
            {t('rank.scope.mine')}
          </button>
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
        <table className="wt-rank-table" data-testid="rank-table">
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

      {/* 내 행이 현재 페이지 밖(상위 50 밖)이면 순위 요약만 고정 표시(§8 wireframe "← 고정 표시"). */}
      {!myRowInPage && me?.onBoard && me.rank !== null && (
        <p className="wt-rank-page__my-row" data-testid="rank-my-row-pinned">
          {t('rank.me', { nickname })} — {t('result.rank.value', { rank: me.rank, percent: me.percentile !== null ? Math.round(me.percentile * 100) : 0 })}
        </p>
      )}

      {nextCursor && (
        <button type="button" className="wt-btn" data-testid="rank-load-more" onClick={loadMore}>
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
