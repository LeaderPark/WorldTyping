// spec: docs/01 §10.1(S1 홈/S2 언어 게이트)·§10.2(S1 와이어프레임 전문)·§11.1(온보딩 1단계
//       "싱글플레이 카드 펄스 하이라이트"), docs/03 §4.2(HomePage 트리)·§8.1(lang 동기화),
//       WT-M2-05(언어 게이트 골격), WT-M2-07(히어로 지도/모드 카드/데일리 뱃지/티커 채움)
//
// 랜딩 → 첫 타이핑 3클릭·15초 여정의 1번째 클릭 지점(§11.1 목표). 언어 게이트(S2)는 WT-M2-05가
// 이미 완성한 그대로 유지한다.
//
// [WT-M3-06] 데일리 뱃지 실데이터(alreadyPlayed·dailyNo)와 티커(전체 1위)를 서버에서 채운다.
// 조회 실패(오프라인 등)는 화면을 깨뜨리지 않고 조용히 placeholder/미표시로 폴백한다 — 이
// 페이지는 "3클릭·15초" 여정의 첫 화면이라 네트워크 대기로 렌더를 막지 않는다(§11.1).
//
// [WT-M5-01b, docs/00 §11-D45] HeroMap(d3-geo/topojson/geo-index, vendor-geo 청크)을
// React.lazy로 분리한다 — entry 정적 import 그래프에 vendor-geo가 남아있으면 그 청크의
// fetch·parse가 끝날 때까지 첫 페인트(제목/모드 카드 포함) 자체가 지연돼 LCP 예산(§8.5)을
// 초과한다(§11-D45 실측 2.64s). Suspense fallback은 HeroMapPlaceholder — HeroMap 내부의
// "위상 데이터 fetch 중" placeholder와 동일 마크업이라 청크 도착 시점 스왑에 레이아웃
// 시프트가 없다. 게임 라우트(GamePage)의 WorldMap 로딩 경로는 이 변경과 무관(불변).
import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { hasChosenLanguage, useSettingsStore } from '../../stores/settings';
import { useMetaStore } from '../../stores/meta';
import { ensureSession, fetchDailyMe, fetchDailyToday, fetchLbPage, type LbEntry } from '../../net/api-client';
import { useModalA11y } from '../../lib/useModalA11y';
import { HeroMapPlaceholder } from './HeroMapPlaceholder';

const HeroMap = lazy(() => import('./HeroMap'));

/** useCountries.ts의 데일리 세트 키 계산과 동일 규약(UTC 자정 기준 ISO 날짜) — 이 페이지는
 *  링크만 구성하므로 국가 데이터셋 없이도 같은 키를 재현할 수 있어야 한다(중복 최소화를 위해
 *  useCountries 내부로 옮기기엔 이 훅이 getBootData()를 요구해 부팅 전 홈 렌더와 상충한다). */
function todayDailyKey(): string {
  return new Date().toISOString().slice(0, 10);
}

/** 2026-01-01 KST를 D#1로 삼는 임시 placeholder 카운터. 서버 권위 데일리 회차 번호(M3, /daily)가
 *  나오기 전까지의 표시용 근사치일 뿐 랭킹/판정에는 전혀 쓰이지 않는다. */
function placeholderDailyNumber(): number {
  const epoch = Date.UTC(2026, 0, 1);
  const days = Math.floor((Date.now() - epoch) / 86_400_000) + 1;
  return Math.max(1, days);
}

export function HomePage() {
  const { t } = useTranslation();
  const lang = useSettingsStore((s) => s.lang);
  const setLang = useSettingsStore((s) => s.setLang);
  const guestId = useSettingsStore((s) => s.guestId);
  const bestPI = useMetaStore((s) => s.bestPI);
  const hasAnyStamp = useMetaStore((s) => Object.keys(s.stamps).length > 0);

  // 데일리 뱃지 실데이터(alreadyPlayed·dailyNo)와 티커(전체 1위) — 조회 실패는 조용히 무시하고
  // placeholder/미표시로 남는다(파일 상단 주석 — 첫 화면 렌더를 네트워크로 막지 않는다).
  const [dailyNo, setDailyNo] = useState<number | null>(null);
  const [alreadyPlayed, setAlreadyPlayed] = useState(false);
  const [top1, setTop1] = useState<LbEntry | null>(null);

  // §8.3 "홈 렌더 완료 후 … 수동 prefetch로 game 청크 예열(첫 판 진입 지연 0 목표)". router.tsx의
  // lazy(() => import('../pages/GamePage'))와 동일한 모듈 지정자를 써야 Vite가 같은 청크로
  // 식별해 중복 다운로드 없이 브라우저 캐시를 예열한다. requestIdleCallback 미지원 브라우저는
  // setTimeout으로 폴백(첫 페인트를 막지 않는 것이 목적이라 즉시 실행은 피한다).
  useEffect(() => {
    const idle =
      typeof requestIdleCallback === 'function'
        ? requestIdleCallback
        : (cb: () => void) => setTimeout(cb, 200);
    const handle = idle(() => {
      void import('../GamePage');
    });
    return () => {
      if (typeof cancelIdleCallback === 'function' && typeof handle === 'number') {
        cancelIdleCallback(handle);
      }
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetchDailyToday()
      .then((res) => {
        if (!cancelled) setDailyNo(res.dailyNo);
      })
      .catch(() => {});
    // fetchDailyMe는 인증 필요(requireAuth) — bootLoader의 세션 부트스트랩이 아직 안 끝났을 수
    // 있어(부팅은 non-blocking) 여기서 먼저 확정 짓는다(이미 성공했다면 즉시 resolve).
    void ensureSession(guestId)
      .then(() => fetchDailyMe())
      .then((res) => {
        if (!cancelled) setAlreadyPlayed(res.alreadyPlayed);
      })
      .catch(() => {});
    fetchLbPage('worldtour|ko|desktop|all')
      .then((res) => {
        if (!cancelled) setTop1(res.entries[0] ?? null);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
    // guestId는 세션 수명 동안 불변 — 마운트 시 1회만 실행.
  }, []);

  return (
    <main className="wt-home" data-testid="home-page">
      <header className="wt-home__header">
        <h1 className="wt-home__title" tabIndex={-1}>{t('app.title')}</h1>
        <nav className="wt-home__nav">
          <Link
            to={`/play/daily/${todayDailyKey()}`}
            data-testid="home-daily-badge"
            className={`wt-home__daily-badge${alreadyPlayed ? ' wt-home__daily-badge--played' : ''}`}
            data-played={alreadyPlayed}
          >
            {t('home.daily.badge', { n: dailyNo ?? placeholderDailyNumber() })}
          </Link>
          <Link to="/rank" data-testid="home-nav-rank">{t('menu.ranking')}</Link>
          <Link to="/passport" data-testid="home-nav-passport">{t('menu.passport')}</Link>
          <button
            type="button"
            data-testid="home-lang-toggle"
            onClick={() => setLang(lang === 'ko' ? 'en' : 'ko')}
          >
            {lang === 'ko' ? t('settings.inputLang.ko') : t('settings.inputLang.en')}
          </button>
          <Link to="/?modal=settings" data-testid="home-nav-settings" aria-label={t('menu.settings')}>
            ⚙
          </Link>
        </nav>
      </header>

      <Suspense fallback={<HeroMapPlaceholder />}>
        <HeroMap />
      </Suspense>

      <div className="wt-home__cards">
        <Link
          to="/play"
          data-testid="home-card-single"
          className={`wt-mode-card${!hasAnyStamp ? ' wt-mode-card--pulse' : ''}`}
        >
          <p className="wt-mode-card__title">{t('menu.single')}</p>
          <p className="wt-mode-card__desc">{t('home.single.desc')}</p>
        </Link>
        {/* 멀티는 M4 소관 — 스텁 페이지로 링크만 연결(작업 특이 조정 "멀티/랭킹 카드 링크는
            스텁 페이지로"). */}
        <Link to="/multi" data-testid="home-card-multi" className="wt-mode-card">
          <p className="wt-mode-card__title">{t('menu.multi')}</p>
          <p className="wt-mode-card__desc">{t('home.multi.desc')}</p>
        </Link>
        <Link to={`/play/daily/${todayDailyKey()}`} data-testid="home-card-daily" className="wt-mode-card">
          <p className="wt-mode-card__title">{t('home.daily.title')}</p>
          <p className="wt-mode-card__desc">{t('home.daily.desc', { count: 20 })}</p>
        </Link>
      </div>

      {bestPI !== null && (
        <p className="wt-home__ticker" data-testid="home-ticker">
          {t('home.ticker.myBest', { pi: bestPI })}
        </p>
      )}
      {/* 서버 리더보드 전체 1위(WT-M3-06) — 조회 실패/빈 보드는 조용히 미표시. */}
      {top1 && (
        <p className="wt-home__ticker" data-testid="home-ticker-top1">
          {t('home.ticker.top1', { nickname: top1.nickname, score: top1.score })}
        </p>
      )}

      <LanguageGateOverlay />
    </main>
  );
}

/** S2 — localStorage 'wt:lang' 부재 시 1회 표시(docs/03 §4.2). WT-M2-05 그대로. */
function LanguageGateOverlay() {
  const { t } = useTranslation();
  const setLang = useSettingsStore((s) => s.setLang);
  const [dismissed, setDismissed] = useState(false);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const isOpen = !dismissed && !hasChosenLanguage();
  // 닫기 버튼이 없는 필수 게이트라 ESC 처리는 없다 — 배경 inert + 포커스 트랩만(§7.3).
  useModalA11y(dialogRef, isOpen);

  if (!isOpen) return null;

  const choose = (l: 'ko' | 'en') => {
    setLang(l);
    setDismissed(true);
  };

  return (
    <div
      ref={dialogRef}
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
