// spec: docs/01 §10.1(S1 홈/S2 언어 게이트)·§10.2(S1 와이어프레임 전문)·§11.1(온보딩 1단계
//       "싱글플레이 카드 펄스 하이라이트"), docs/03 §4.2(HomePage 트리)·§8.1(lang 동기화),
//       WT-M2-05(언어 게이트 골격), WT-M2-07(히어로 지도/모드 카드/데일리 뱃지/티커 채움)
//
// 랜딩 → 첫 타이핑 3클릭·15초 여정의 1번째 클릭 지점(§11.1 목표). 언어 게이트(S2)는 WT-M2-05가
// 이미 완성한 그대로 유지한다.
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { hasChosenLanguage, useSettingsStore } from '../../stores/settings';
import { useMetaStore } from '../../stores/meta';
import { HeroMap } from './HeroMap';

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
  const bestPI = useMetaStore((s) => s.bestPI);
  const hasAnyStamp = useMetaStore((s) => Object.keys(s.stamps).length > 0);

  return (
    <main className="wt-home" data-testid="home-page">
      <header className="wt-home__header">
        <h1 className="wt-home__title">{t('app.title')}</h1>
        <nav className="wt-home__nav">
          <Link to={`/play/daily/${todayDailyKey()}`} data-testid="home-daily-badge" className="wt-home__daily-badge">
            {t('home.daily.badge', { n: placeholderDailyNumber() })}
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

      <HeroMap />

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

      {/* 오늘의 1위(서버 리더보드)는 M3 소관 — 여기서는 로컬 개인 최고 PI만 표시한다(연동 전
          까지 허위 데이터를 만들지 않는다). */}
      {bestPI !== null && (
        <p className="wt-home__ticker" data-testid="home-ticker">
          {t('home.ticker.myBest', { pi: bestPI })}
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

  if (dismissed || hasChosenLanguage()) return null;

  const choose = (l: 'ko' | 'en') => {
    setLang(l);
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
