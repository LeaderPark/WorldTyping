// spec: docs/01 §10.1(S1 홈/S2 언어 게이트)·§10.2(S1 와이어프레임 전문)·§11.1(온보딩 1단계
//       "싱글플레이 카드 펄스 하이라이트"), docs/03 §4.2(HomePage 트리)·§8.1(lang 동기화),
//       docs/00 §11-D45(lazy 배경 청크 경계 원칙)·D50(브랜드 색은 장식·지도 fill 전용)·
//       D67-⑦(평면 WorldMap·HeroMap·RouteMotifBackdrop 홈 배선 폐기, 파일 존치)·D68-⑦(홈 배경 =
//       GlobeMap 자동 데모), WT-M2-05(언어 게이트 골격), WT-M2-07(모드 카드/데일리 뱃지/티커
//       채움), WT-UI-04(홈 리뉴얼 — 로고 카드+컬러 메뉴 행 5+데일리 뱃지+언어 게이트 라이트),
//       WT-AUTH-07(이 태스크 — 홈 배경을 HomeGlobe 전체화면 자동 데모로 교체)
//
// 랜딩 → 첫 타이핑 3클릭·15초 여정의 1번째 클릭 지점(§11.1 목표). 언어 게이트(S2)는 WT-M2-05가
// 이미 완성한 골격(role/aria-label/testid/localStorage 시맨틱)을 그대로 유지하고, WT-UI-04는
// 다이얼로그 표면만 .wt-card로 라이트 재도장한다 — 문구는 손대지 않았다(index.html의 정적
// 크리티컬 셸이 이 문구를 그대로 복제하고 있어, 카피를 바꾸면 그 파일도 동기해야 한다).
//
// [WT-M3-06 / D75 → §11-D87] 홈 중앙 서버 리더보드 "전체 1위" 티커(home-ticker-top1)는 D87에서
// 제거됐다 — 홈 중앙에는 메뉴 nav 5개만 남는다. 티커 렌더·top1 상태·리더보드 조회 useEffect·
// 미사용 i18n(home.ticker.*)이 함께 폐지됐다(판정/점수/서버 API·/rank 리더보드 페이지는 불변).
//
// [WT-AUTH-07, docs/00 §11-D67-⑦·D68-⑦] 홈 배경을 HeroMap(축소된 실루엣 지도)+
// RouteMotifBackdrop(정적 장식 아크)에서 HomeGlobe(GlobeMap 자동 데모 — idle spin + 8±3s 랜덤
// 홉)로 전면 교체한다. HeroMap.tsx/HeroMapPlaceholder.tsx/RouteMotifBackdrop.tsx 자체는
// 무수정으로 존치(다른 화면이 재사용할 수 있게)하되, 이 파일의 배선(import·렌더)만 제거한다.
// HomeGlobe도 HeroMap과 동일한 이유(D45 — vendor-geo 청크가 entry 정적 import 그래프에 남으면
// 첫 페인트가 지연돼 LCP 예산을 넘긴다)로 React.lazy 청크 경계를 유지한다. Suspense fallback
// (HomeGlobePlaceholder)은 HomeGlobe 내부의 "지구본 인덱스 아직 없음" 상태와 동일 마크업이라
// 청크 도착 시점 스왑에 레이아웃 시프트가 없다.
import { lazy, Suspense, useEffect, useRef, useState, type MouseEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { hasChosenLanguage, useSettingsStore } from '../../stores/settings';
import { useMetaStore } from '../../stores/meta';
import { selectIsLoggedIn, useAuthStore } from '../../stores/auth';
import { useModalA11y } from '../../lib/useModalA11y';
import { Mascot } from '../../components/Mascot';
import { BrandMark } from '../../components/BrandMark';
import { AuthChip } from '../../features/auth/AuthChip';
import { ThemeToggle } from '../../features/auth/ThemeToggle';
import { HomeGlobePlaceholder } from './HomeGlobePlaceholder';

const HomeGlobe = lazy(() => import('./HomeGlobe'));

/** [WT-DC-02] 스토어에 별도 'muted' 필드를 새로 두지 않고 기존 volume.master(설정 스토어 기존
 *  필드, sound-manager.ts의 play()가 이미 master*sfx로 게인을 계산한다)를 0으로 두는 것을
 *  "음소거"로 취급한다 — sound-manager API(setVolume) 안에서 해결 가능해 스토어 확장이 필요
 *  없었다(태스크 에스컬레이션 조건 불충족). 세션 중 마지막 비0 볼륨을 기억해 해제 시 복원하고,
 *  기억한 값이 없으면(예: 이미 음소거된 채로 새로고침) 스토어 최초 기본값(0.8)으로 복원한다. */
const DEFAULT_MASTER_VOLUME = 0.8;

/** useCountries.ts의 데일리 세트 키 계산과 동일 규약(UTC 자정 기준 ISO 날짜) — 이 페이지는
 *  링크만 구성하므로 국가 데이터셋 없이도 같은 키를 재현할 수 있어야 한다(중복 최소화를 위해
 *  useCountries 내부로 옮기기엔 이 훅이 getBootData()를 요구해 부팅 전 홈 렌더와 상충한다). */
function todayDailyKey(): string {
  return new Date().toISOString().slice(0, 10);
}

export function HomePage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const lang = useSettingsStore((s) => s.lang);
  const setLang = useSettingsStore((s) => s.setLang);
  const hasAnyStamp = useMetaStore((s) => Object.keys(s.stamps).length > 0);

  // [WT-PASSPORT-LOGIN-GATE v3, 리드 확정] 여권 카드 게이트 — 비로그인 클릭은 네비게이션을 막고
  // 로그인 모달만 연다(홈에 머무름). 로그인이 성립하면(같은 탭에서 모달로 성공한 경우) 보류해 둔
  // /passport 이동을 자동 재개한다 — LobbyPage의 withLoginGate/pendingActionRef 패턴 준용.
  // redirect(GIS ux_mode:'redirect') 로그인은 전체 페이지 이동이라 이 컴포넌트 인스턴스가 사라지므로
  // 이 재개는 발화하지 않는다 — 착지 후에도 자동 이동을 원하면 sessionStorage 보류 플래그로 확장이
  // 필요하지만(리드 지시), 착지 경로가 이미 홈이라 사용자가 카드 하나만 다시 누르면 되는 저비용
  // 갭이라 이번 배치 범위에서는 제외한다(같은 탭 로그인 성립 케이스만 커버).
  const isLoggedIn = useAuthStore(selectIsLoggedIn);
  const openLogin = useAuthStore((s) => s.openLogin);
  const loginReason = useAuthStore((s) => s.loginReason);
  const passportPendingRef = useRef(false);

  useEffect(() => {
    if (isLoggedIn && passportPendingRef.current) {
      passportPendingRef.current = false;
      navigate('/passport');
    }
  }, [isLoggedIn, navigate]);

  // 모달을 취소했는데(닫혔는데) 여전히 비로그인이면 보류를 폐기한다(홈 언마운트는 ref가 인스턴스와
  // 함께 사라지므로 별도 처리가 필요 없다).
  useEffect(() => {
    if (loginReason === null && !isLoggedIn) passportPendingRef.current = false;
  }, [loginReason, isLoggedIn]);

  function handlePassportClick(e: MouseEvent<HTMLAnchorElement>): void {
    if (isLoggedIn) return; // 로그인 상태 — 기존 네비게이션 그대로.
    e.preventDefault();
    passportPendingRef.current = true;
    openLogin('passport');
  }

  // [WT-DC-02] 사운드 토글(②) — 저빈도 사용자 설정 변경이라 §4.5 핫패스 규약(고빈도 값 금지)과
  // 무관하다. 클릭 자체가 pointerdown이라 sound-manager의 첫 제스처 unlock()도 함께 트리거된다.
  const masterVolume = useSettingsStore((s) => s.volume.master);
  const setVolume = useSettingsStore((s) => s.setVolume);
  const isSoundMuted = masterVolume <= 0;
  const lastMasterRef = useRef(masterVolume > 0 ? masterVolume : DEFAULT_MASTER_VOLUME);
  useEffect(() => {
    if (masterVolume > 0) lastMasterRef.current = masterVolume;
  }, [masterVolume]);
  const toggleSound = () => {
    setVolume({ master: isSoundMuted ? lastMasterRef.current || DEFAULT_MASTER_VOLUME : 0 });
  };

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

  return (
    <main className="wt-home" data-testid="home-page">
      {/* [WT-AUTH-07] 홈 전체 화면 배경 지구본(00 §11-D67-⑦·D68-⑦) — GlobeMap 자동 데모(idle
          spin + 주기 홉). RouteMotifBackdrop/HeroMap의 홈 배선을 대체한다. */}
      <Suspense fallback={<HomeGlobePlaceholder />}>
        <HomeGlobe />
      </Suspense>

      <div className="wt-home__content">
        <header className="wt-home__header">
          {/* [D74] 좌상단 브랜드. [WT-TWEAK-BRAND-LINK] 홈에서도 클릭 가능한 `/` 링크로 통일
              (D74의 "홈=비링크 span" 조항 대체 — 같은 경로 네비라 무해). [D75] 헤더 데일리 뱃지는
              제거 — 데일리 진입은 아래 메뉴 카드(home-card-daily)가 유지한다. */}
          <BrandMark />
          <div className="wt-home__header-actions">
            <button
              type="button"
              data-testid="home-lang-toggle"
              className="wt-pill wt-pill--compact"
              onClick={() => setLang(lang === 'ko' ? 'en' : 'ko')}
            >
              {lang === 'ko' ? t('settings.inputLang.ko') : t('settings.inputLang.en')}
            </button>
            <button
              type="button"
              data-testid="home-sound-toggle"
              aria-pressed={!isSoundMuted}
              className="wt-pill wt-pill--compact wt-home__sound-toggle"
              onClick={toggleSound}
            >
              {isSoundMuted ? t('home.soundToggle.off') : t('home.soundToggle.on')}
            </button>
            {/* [WT-AUTH-03] 로그인/프로필 칩(§11-D68-⑥). */}
            <AuthChip />
            {/* [WT-AUTH-03] 기어 딥링크(?modal=settings) 폐기 → 테마 토글(§11-D68-⑥). */}
            <ThemeToggle className="wt-home__settings-btn" />
          </div>
        </header>

        {/* 로고 카드(①) — 배경은 이제 홈 전체를 덮는 HomeGlobe(위에서 마운트)가 담당한다. */}
        <div className="wt-card wt-home__logo-card">
          <Mascot width={56} tail="var(--continent-asia)" blush bob />
          <h1 className="wt-home__title wt-home__title--brand" tabIndex={-1}>{t('app.title')}</h1>
          <p className="wt-home__tagline">{t(`app.tagline.${lang}`)}</p>
        </div>

        {/* 메뉴 행 5(②): 싱글/멀티/데일리/랭킹/여권 — .wt-menu-row(WT-UI-01)를 그대로 쓰고
            행마다 대륙색 좌측 바 + 아이콘 타일 + 킥커 + 제목 + 위트 카피 + 셰브런을 채운다. */}
        <nav className="wt-home__menu" aria-label={t('home.menu.navLabel')}>
          <Link
            to="/play"
            data-testid="home-card-single"
            className={`wt-menu-row wt-home__menu-row--single${!hasAnyStamp ? ' wt-home__menu-row--pulse' : ''}`}
          >
            <span className="wt-icon-tile" aria-hidden="true">▶</span>
            <span className="wt-menu-row__body">
              <span className="wt-kicker wt-kicker--asia">{t('home.menu.singleKicker')}</span>
              <span className="wt-menu-row__title">{t('menu.single')}</span>
              <span className="wt-menu-row__copy">{t('home.menu.singleCopy')}</span>
            </span>
            <span className="wt-menu-row__chevron" aria-hidden="true">›</span>
          </Link>

          {/* 멀티는 M4 소관 — 스텁 페이지로 링크만 연결(작업 특이 조정 "멀티/랭킹 카드 링크는
              스텁 페이지로"). */}
          <Link to="/multi" data-testid="home-card-multi" className="wt-menu-row wt-home__menu-row--multi">
            <span className="wt-icon-tile" aria-hidden="true">⚔</span>
            <span className="wt-menu-row__body">
              <span className="wt-kicker wt-kicker--europe">{t('home.menu.multiKicker')}</span>
              <span className="wt-menu-row__title">{t('menu.multi')}</span>
              <span className="wt-menu-row__copy">{t('home.menu.multiCopy')}</span>
            </span>
            <span className="wt-menu-row__chevron" aria-hidden="true">›</span>
          </Link>

          <Link
            to={`/play/daily/${todayDailyKey()}`}
            data-testid="home-card-daily"
            className="wt-menu-row wt-home__menu-row--daily"
          >
            <span className="wt-icon-tile" aria-hidden="true">📅</span>
            <span className="wt-menu-row__body">
              <span className="wt-kicker wt-kicker--south-america">{t('home.menu.dailyKicker')}</span>
              <span className="wt-menu-row__title">{t('home.daily.title')}</span>
              <span className="wt-menu-row__copy">{t('home.menu.dailyCopy', { count: 20 })}</span>
            </span>
            <span className="wt-menu-row__chevron" aria-hidden="true">›</span>
          </Link>

          <Link to="/rank" data-testid="home-nav-rank" className="wt-menu-row wt-home__menu-row--ranking">
            <span className="wt-icon-tile" aria-hidden="true">🏆</span>
            <span className="wt-menu-row__body">
              <span className="wt-kicker wt-kicker--africa">{t('home.menu.rankingKicker')}</span>
              <span className="wt-menu-row__title">{t('menu.ranking')}</span>
              <span className="wt-menu-row__copy">{t('home.menu.rankingCopy')}</span>
            </span>
            <span className="wt-menu-row__chevron" aria-hidden="true">›</span>
          </Link>

          <Link
            to="/passport"
            data-testid="home-nav-passport"
            className="wt-menu-row wt-home__menu-row--passport"
            onClick={handlePassportClick}
          >
            <span className="wt-icon-tile" aria-hidden="true">🛂</span>
            <span className="wt-menu-row__body">
              <span className="wt-kicker wt-kicker--oceania">{t('home.menu.passportKicker')}</span>
              <span className="wt-menu-row__title">{t('menu.passport')}</span>
              <span className="wt-menu-row__copy">{t('home.menu.passportCopy')}</span>
            </span>
            <span className="wt-menu-row__chevron" aria-hidden="true">›</span>
          </Link>
        </nav>
      </div>

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
      {/* [WT-UI-04] .wt-card 라이트 다이얼로그 — 문구·testid·localStorage 시맨틱은 무변경. */}
      <div className="wt-card mx-4 max-w-sm p-6 text-center">
        <p>{t('lang.selectPrompt.ko')}</p>
        <p>{t('lang.selectPrompt.en')}</p>
        <div className="mt-4 flex justify-center gap-3">
          <button type="button" data-testid="lang-ko" className="wt-pill" onClick={() => choose('ko')}>
            {t('lang.selectOption.ko')}
          </button>
          <button type="button" data-testid="lang-en" className="wt-pill" onClick={() => choose('en')}>
            {t('lang.selectOption.en')}
          </button>
        </div>
        <p className="mt-3 text-xs opacity-70">{t('lang.select.hint')}</p>
      </div>
    </div>
  );
}
