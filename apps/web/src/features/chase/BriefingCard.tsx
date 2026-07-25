// spec: docs/09-chase-mode-goldrunner.md §7.1(보딩 화면 — "지명수배 전단 브리핑")·§8.1(온보딩)·
//       §3.2(선택지 3장)·§3.5(금·몰아 배송 배수)·§3.3(수배 상승/도주 감소)·§3.6·§11-D92(S/A는
//       배송 ≥1)·D94(체포 시 미배송 금 50%)·D95(스킵·일시정지 부재, ESC=자수), docs/00 §11-D90·D111,
//       WT-CH-08 → WT-CH-DEV-2.
//
// ── WT-CH-DEV-2(§11-D111 ①) 첫인상·직관성: "게임 방법" 안내 섹션 ────────────────────────────
// 종전에는 localStorage 플래그로 첫 판 1회만 3줄 압축 규칙("타이핑 = 이동")을 보여줬다. 리드 스코프
// 상향으로 **시작 전 충분한 설명**을 목표로 5항목(도주/금/수배/체포/등급) 안내 섹션으로 확장한다.
//   · 첫 진입(플래그 없음)에는 **펼친 상태**, 이후에는 접힌 "게임 방법 보기" 토글(디스클로저 패턴,
//     aria-expanded/aria-controls) — 언제든 다시 펼쳐 볼 수 있다.
//   · 안내 섹션은 클릭-투-스타트 카드의 **형제 노드**다(카드 안이 아니라 아래). 카드 자체가
//     role="button"인 구조라 그 안에 버튼을 중첩하면 (a) 토글 클릭이 카드로 버블링해 게임이 시작되고
//     (b) 인터랙티브 중첩이라는 a11y 위반이 된다. 형제로 두면 §03-7.2 "탭 → 동기 focus → 카운트다운"
//     계약과 START 접근성이 100% 그대로 유지된다("설명이 시작을 막지 않게" — 카드는 항상 안내 위에
//     먼저 보인다).
//   · **수치 하드코딩 금지**: 배송 보너스 배수·수배 감소 거리/시간·경찰 증가량 등은 전부
//     ChaseConstants(KV `config:chase` 핫스왑 대상, §9.4)라 문구는 "보너스 배수"·"멀리 떨어져"류
//     일반 표현만 쓴다. 유일하게 구체값이 들어간 "후보 3개국"은 구조 상수(§3.2 선택지 3장 — 칩
//     레이아웃·판정이 3에 묶인 설계)고, "절반만 인정"은 D94 본문 표현을 그대로 옮긴 것이다.
// "첫 판 1회성" 스캐폴딩 자체는 인게임 코치마크(ChaseFirstRunTips.tsx, wt:chase:tipsSeen)가 별도로
// 전담한다 — 이 카드의 플래그(wt:chase:howtoSeen)는 "안내를 접어둘지"만 결정한다.
//
// GamePage(mode=chase)의 idle 단계 카드. 기존 BoardingPass(§03-7.2 "탭 → hidden input 동기 focus →
// 카운트다운")의 클릭-투-스타트 계약은 그대로 재사용하되(입력 계층 무수정 원칙 — 이 컴포넌트는 그
// 계약을 준수하는 새 마크업일 뿐 BoardingPass 자체를 재사용하지 않는다: 그 컴포넌트의 props(모드/
// 노선/고스트 토글 등)는 "완주 가능한 고정 세트" 전제라 무한 생존 chase에 맞지 않는다), 시각은
// WANTED 전단(크라프트지 텍스처)으로 갈아입는다. 카드 프레임(.wt-boarding__card)은 기존 5모드와
// 공유하는 전역 클래스를 그대로 재사용하고(§8 "다른 모드 화면에 픽셀 영향 0" — 이 파일은 신규
// 페이지에서만 쓰이므로 공유 클래스 재사용이 다른 화면에 영향을 주지 않는다), 새 accent 수식자
// 하나(.wt-boarding__card--chase)만 globals.css에 더한다.
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';

/** BoardingPass.tsx의 PUNCH_MS와 동일 취지 — 스탬프 낙하(§7.1 "300ms")를 화면에 완주시킨 뒤 start(). */
const STAMP_FALL_MS = 300;

/** 안내를 이미 펼쳐 본 적 있는지(첫 진입 판정) — 값이 있으면 접힌 상태로 시작한다. */
const HOWTO_SEEN_KEY = 'wt:chase:howtoSeen';

const HOWTO_PANEL_ID = 'wt-chase-howto-panel';

/** "게임 방법" 5항목(§11-D111 ①). 아이콘은 순수 장식이라 i18n 대상이 아니고 aria-hidden으로
 *  스크린리더에서 제외한다(제목·본문이 이미 의미를 전달). 키 이름이 `runTitle/runBody`인 이유:
 *  i18n 키 규약이 `영역.의미[.상세]` **최대 3단계**라(packages/i18n keys.test.ts CI 게이트)
 *  `chase.howto.run.title`(4단계)은 쓸 수 없다 — 그룹 접두사 `chase.howto.`는 유지하고 마지막
 *  세그먼트에서 항목·역할을 합성한다. */
const HOWTO_ROWS: ReadonlyArray<{ icon: string; titleKey: string; bodyKey: string }> = [
  { icon: '✈️', titleKey: 'chase.howto.runTitle', bodyKey: 'chase.howto.runBody' },
  { icon: '💰', titleKey: 'chase.howto.goldTitle', bodyKey: 'chase.howto.goldBody' },
  { icon: '🚨', titleKey: 'chase.howto.wantedTitle', bodyKey: 'chase.howto.wantedBody' },
  { icon: '🚓', titleKey: 'chase.howto.arrestTitle', bodyKey: 'chase.howto.arrestBody' },
  { icon: '🏅', titleKey: 'chase.howto.gradeTitle', bodyKey: 'chase.howto.gradeBody' },
];

function hasSeenHowto(): boolean {
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem(HOWTO_SEEN_KEY) === '1';
  } catch {
    return true; // 접근 불가(사생활 모드 등) — 매번 펼침을 강요하지 않는다.
  }
}

function markHowtoSeen(): void {
  try {
    localStorage?.setItem(HOWTO_SEEN_KEY, '1');
  } catch {
    /* 저장 실패해도 이번 노출은 이미 끝났다 — 무시. */
  }
}

export interface BriefingCardProps {
  /** simulateChase(seed, moveLog:[], endMs:0)로 미리 peek한 홈 국가 표시명(§7.1 미션 텍스트 원천). */
  homeName: string;
  /** 서버 시드/그래프 로딩 중이면 카드를 잠근다(runs/start와 동일한 "connecting" 톤, WT-M3-06 관례). */
  locked?: boolean;
  focusInput(): void;
  onStart(): void;
}

export function BriefingCard({ homeName, locked = false, focusInput, onStart }: BriefingCardProps) {
  const { t } = useTranslation();
  const [punching, setPunching] = useState(false);
  // 첫 진입이면 펼친 상태로 시작한다(플래그는 마운트 즉시 기록 — 이 판에서 접었다 폈다 해도
  // 다음 진입은 접힌 상태가 기본).
  const [howtoOpen, setHowtoOpen] = useState(() => !hasSeenHowto());
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    markHowtoSeen();
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const depart = useCallback(() => {
    if (punching || locked) return;
    // §03-7.2: 반드시 이 동기 핸들러 안에서 focus — setTimeout 뒤로 미루면 iOS가 소프트키보드를 열지 않는다.
    focusInput();
    setPunching(true);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      onStart();
    }, STAMP_FALL_MS);
  }, [punching, locked, focusInput, onStart]);

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      if (e.key === ' ' || e.key === 'Enter') {
        e.preventDefault();
        depart();
      }
    },
    [depart],
  );

  const cardClassName = `wt-boarding__card wt-boarding__card--chase${punching ? ' wt-boarding__card--punch' : ''}${locked ? ' wt-boarding__card--locked' : ''}`;

  return (
    <div className="wt-boarding" data-testid="chase-briefing">
      <div
        className={cardClassName}
        role="button"
        tabIndex={locked ? -1 : 0}
        aria-disabled={locked}
        aria-label={t('chase.briefing.cta')}
        data-testid="chase-briefing-card"
        data-locked={locked}
        onClick={depart}
        onKeyDown={onKeyDown}
      >
        <span className="wt-boarding__accent" aria-hidden="true" />
        <div className="wt-boarding__main">
          <p className="wt-boarding__label">{t('chase.briefing.title')}</p>
          <p className="wt-boarding__route" data-testid="chase-briefing-mission">
            {t('chase.briefing.mission', { home: homeName })}
          </p>
          <p className="wt-boarding__cta wt-chase-briefing__cta">
            {punching ? t('boarding.punching') : locked ? t('boarding.connecting') : t('chase.briefing.cta')}
          </p>
        </div>
      </div>

      {/* "게임 방법" 디스클로저 — 카드(클릭-투-스타트)의 형제 노드다(파일 헤더 참조: 중첩 금지).
          START는 위 카드로 항상 접근 가능하며, 이 섹션은 펼침 여부와 무관하게 시작을 막지 않는다. */}
      <section className="wt-chase-howto" data-testid="chase-howto">
        <button
          type="button"
          className="wt-chase-howto__toggle"
          aria-expanded={howtoOpen}
          aria-controls={HOWTO_PANEL_ID}
          data-testid="chase-howto-toggle"
          onClick={() => setHowtoOpen((open) => !open)}
        >
          <span className="wt-chase-howto__chevron" aria-hidden="true">
            {howtoOpen ? '▾' : '▸'}
          </span>
          {howtoOpen ? t('chase.howto.title') : t('chase.howto.toggle')}
        </button>

        {/* 조건부 언마운트가 아니라 hidden 토글이다 — aria-controls가 항상 실재하는 id를 가리켜야
            보조기술이 토글↔패널 관계를 읽을 수 있다(접힘 상태에서 hidden은 a11y 트리에서도 제외). */}
        <ul
          id={HOWTO_PANEL_ID}
          className="wt-chase-howto__list"
          data-testid="chase-howto-panel"
          hidden={!howtoOpen}
        >
          {HOWTO_ROWS.map((row) => (
            <li key={row.titleKey} className="wt-chase-howto__item">
              <span className="wt-chase-howto__icon" aria-hidden="true">
                {row.icon}
              </span>
              <span className="wt-chase-howto__text">
                <b className="wt-chase-howto__item-title">{t(row.titleKey)}</b>
                <span className="wt-chase-howto__item-body">{t(row.bodyKey)}</span>
              </span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
