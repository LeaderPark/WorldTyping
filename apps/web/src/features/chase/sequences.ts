// spec: docs/09-chase-mode-goldrunner.md §7.6(이벤트 시퀀스 연출 타임라인 전문 — globe-centric
//       개정: 플로팅 피드백은 발생 국가 투영 좌표 위)·§7.4(수배 발령 특별 연출, 1회성)·§8.3(z-순서:
//       플로팅 텍스트 < HUD)·§8.9, docs/00 §11-D96(체포 히트스톱 250ms — 유일 블로킹 예외)·
//       D67(비블로킹·강등 계약), WT-CH-07.
//
// 이 파일은 4종 이벤트 시퀀스(금 획득 900ms / 배송 1,600ms / 체포 2,800ms / 수배발령 최초 1회
// 600ms)의 **ms 오프셋 상수 테이블**과, `ChaseSessionEngine.subscribe`를 구독해 그 오프셋대로
// GlobeChaseHandle 마커 훅 + ChaseAudio SFX + 플로팅 텍스트(이 파일이 직접 그리는 오버레이 DOM)를
// 트리거하는 `createChaseSequences()` 팩토리를 내보낸다. React 비의존(순수 TS) — use-chase-juice.ts가
// 마운트/언마운트를 배선한다.
//
// [비블로킹 불변(D67·D96)] 체포의 히트스톱 250ms만 유일한 예외이며, 그마저도 "블로킹"은 UX적
// 개념(프리즈 프레임 느낌)이지 실제 JS 메인 스레드 차단이 아니다 — 체포 시점엔 이미 엔진이
// finished 상태로 전이해 입력을 더 받지 않으므로(chase-session.ts handleInput의 phase 가드),
// setTimeout 체인으로 구현해도 "입력을 막는다"는 우려가 애초에 발생하지 않는다. 그 외 픽업/배송/
// 수배발령 3종은 진행 중에도 다음 홉 타이핑이 100% 그대로 반영된다(전부 setTimeout 오프셋일 뿐,
// 아무 것도 동기적으로 대기하지 않는다).
//
// [플로팅 텍스트 레이어] CandidateCallouts.tsx(§8.5)와 동일한 명령형 오버레이 패턴을 재사용한다:
// 좌표는 GlobeChaseHandle.projectAnchor(viewBox 960×500)를 그대로 쓰고, 컨테이너 실픽셀 변환은
// callout-layout.ts의 fitViewBoxToContainer/toContainerPx(순수 함수, 재구현 아님)를 그대로
// import한다. DOM 레이어 자체(.wt-chase-fx)는 이 파일이 소유하는 신규 계층 — CandidateCallouts의
// `.wt-candidate-overlay`(CH-06 소유)와는 별개 형제 노드다(use-chase-juice.ts가 layerRef로 마운트
// 지점만 내준다, GamePage/CH-08이 실제 DOM 트리에 삽입).
import type { ChaseSessionEngine, ChaseEngineEvent } from '@wt/engine';
import type { Country, CountryId } from '@wt/shared';
import i18next from 'i18next';
import type { GlobeChaseHandle } from '../map/globe/globe-chase';
import { fitViewBoxToContainer, toContainerPx } from './callout-layout';
import type { ChaseAudio } from './chase-audio';

// ── §7.6 타임라인 상수(ms 오프셋 — 표와 diff 대조 가능하도록 필드명에 표의 트리거를 그대로 반영) ──

/** 금 획득(playPickup) — 총 900ms, 비블로킹. */
export const PICKUP_TIMELINE_MS = {
  /** 0ms: 국가 폴리곤 금색 플래시(GlobeChaseHandle.playPickup — 마커 레벨 효과, CH-05 소관). */
  polygonFlash: 0,
  /** 80ms: 금괴 아이콘 20px 라이즈 + 스파클(이 파일이 그리는 플로팅 아이콘으로 근사). */
  riseSparkle: 80,
  /** 240ms: 금화 짤랑 2연(SFX) + 코인 HUD 흡수 시작(포물선 500ms). */
  coinSfxAbsorb: 240,
  /** 740ms: 가방 카운터 바운스 + "+1" 플로팅 텍스트(발생국 좌표 위, §7.6 개정). */
  badgeFloatingText: 740,
  /** 총 지속시간. */
  total: 900,
} as const;

/** 배송(playDelivery) — 총 1,600ms, 비블로킹(다음 선택지 콜아웃 등장과 병행). */
export const DELIVERY_TIMELINE_MS = {
  /** 0ms: 홈 비컨 3겹 파열(GlobeChaseHandle.playDelivery) + 금고 "철컹" SFX. */
  burstClunk: 0,
  /** 150ms: 소지 금 개수만큼 순차(80ms 간격) 낙하 스탬프 — 시각 카운트만(과도 구현 방지, 최종 보고). */
  goldDropStamps: 150,
  /** 500ms: 정산 점수 롤업(800ms) — "+payout" 플로팅을 홈 좌표 위에. */
  scoreRollup: 500,
  /** 900ms: 수배 별 −2 하강 연출과 오버랩(별 시각/사운드는 WantedHud(CH-06)·wantedChanged 배선
   *  소관 — 이 값은 타이밍 참조용 상수일 뿐 이 파일이 직접 트리거하지 않는다). */
  starDescendOverlapRef: 900,
  /** 1,300ms: 케이퍼 팡파레(0.6s). */
  fanfare: 1300,
  /** 총 지속시간. */
  total: 1600,
} as const;

/** 체포(playArrest) — 유일한 블로킹 허용 연출(게임 이미 종료), 총 2,800ms. */
export const ARREST_TIMELINE_MS = {
  /** 0ms: 히트스톱 250ms(D96) — 지구본·HUD 프리즈 신호(정지 클래스) + 사운드 순간 뮤트. */
  hitstop: 0,
  /** 250ms: 적청 풀스크린 플래시 3연(각 90ms) + 사이렌 최대 볼륨. */
  flashTriple: 250,
  /** 520ms: 체포국 폴리곤 적색 점등(GlobeChaseHandle.playArrest) + 수갑 "철컥" SFX. */
  polygonHandcuffs: 520,
  /** 800ms: 카메라 미세 셰이크(±0.8°, 400ms 감쇠) — CSS 클래스 트리거만(캔버스 재그리기 없음). */
  cameraShake: 800,
  /** 1,200ms: 톤다운(채도 −40%) + "ARRESTED" 스탬프(200ms) + "국가명에서 검거" 잔글씨. */
  tonedownStamp: 1200,
  /** 1,800ms: WANTED 전단 재하강 + 취소선/ARRESTED 덧찍힘. */
  wantedRedo: 1800,
  /** 2,800ms: 결과 카드 슬라이드 인 지점(onArrestComplete 콜백 — CH-08 옵션 소비). */
  resultSlide: 2800,
  /** 총 지속시간. */
  total: 2800,
} as const;

/** 체포 reduced-motion 대체 타임라인(§7.6 "reduced-motion: 히트스톱·플래시·셰이크 생략, 톤다운+
 *  스탬프 정적 표시 후 1s 뒤 결과"). */
export const ARREST_REDUCED_TIMELINE_MS = {
  /** 0ms: 톤다운+스탬프 정적 표시(애니메이션 없이 즉시). */
  staticDisplay: 0,
  /** 1,000ms: 결과 진입. */
  result: 1000,
  total: 1000,
} as const;

/** 수배 발령(최초 ★1) — 1회성 특별 연출, 총 600ms(§7.6 "레이더 스윕 라인 1회전"). */
export const WANTED_ISSUANCE_TIMELINE_MS = {
  /** 0ms: 레이더 스윕(SVG 오버레이 부채꼴) + 무전 음성풍 SFX. */
  radarSweep: 0,
  total: 600,
} as const;

/** 체포 플래시 1개 지속(§7.6 "각 90ms" — flashTriple 오프셋부터 3연). */
const ARREST_FLASH_STEP_MS = 90;

export interface ChaseSequencesDeps {
  engine: ChaseSessionEngine;
  globe: GlobeChaseHandle;
  audio: ChaseAudio;
  /** 국가명 해석 원천(countries.json nameKo/nameEn만 — CLAUDE.md 규약). */
  countries: readonly Country[];
  lang: 'ko' | 'en';
  /** 플로팅 텍스트/체포 오버레이를 그릴 컨테이너 — 아직 마운트 전이면 null(그 프레임의 시각 효과만
   *  생략, SFX/엔진 상태는 좌표 무관이라 정상 진행). 매 호출 시점 최신값을 읽는다(레이아웃 참조 참고). */
  getLayer(): HTMLElement | null;
  /** true면 파티클/글로우/셰이크 off + 체포 히트스톱·플래시 생략(§7 헤더 강등표 + D96). 매 호출
   *  시점 재평가(설정 변경 즉시 반영 — 리렌더 불요). */
  isReduced(): boolean;
  /** 체포 시퀀스 종료(§7.6 "2,800ms 결과 카드 슬라이드 인" 또는 reduced 1,000ms) 알림 — CH-08이
   *  결과 뷰 전환 타이밍에 참고용으로만 쓸 수 있는 선택적 훅(엔진 phase는 arrested 즉시 'finished'로
   *  이미 전이돼 있으므로 이 콜백이 없어도 결과 화면 표시 자체는 막히지 않는다). */
  onArrestComplete?: () => void;
}

export interface ChaseSequencesController {
  /** 등록된 모든 setTimeout을 취소하고 구독을 해제한다(누수 금지 — 언마운트/재도전 시 반드시 호출). */
  dispose(): void;
}

function reduce(v: number): number {
  return Math.round(v * 1000) / 1000;
}

/** 후보/국가 도트와 동일한 좌표 매핑(§7.5·§8.5) — 컨테이너가 아직 0×0(레이아웃 전/jsdom)이면
 *  fitViewBoxToContainer가 scale=0을 반환해 toContainerPx가 (offsetX,offsetY)로 수렴, 화면 밖으로는
 *  가지 않는다(방어적 — 실사용에서는 겹치지 않음, 테스트 편의). */
function anchorToPx(layer: HTMLElement, globe: GlobeChaseHandle, id: CountryId): { x: number; y: number } {
  const rect = layer.getBoundingClientRect();
  const fit = fitViewBoxToContainer(rect.width, rect.height);
  const anchor = globe.projectAnchor(id);
  return toContainerPx(anchor, fit);
}

/**
 * 플로팅 텍스트 1개 생성 — WAAPI로 라이즈+페이드(비-reduced) 또는 정적 표시 후 고정 시간 뒤 제거
 * (reduced, §7 헤더 "duration 0·펄스 정지"를 "정적 표시"로 해석 — globe-chase.ts popEffect와 동일
 * 관례: el.animate 지원 확인 후 실패 시 즉시 정리).
 */
function spawnFloatingText(
  layer: HTMLElement,
  px: { x: number; y: number },
  text: string,
  variant: 'gold' | 'siren',
  reduced: boolean,
): void {
  const el = document.createElement('div');
  el.className = `wt-chase-fx__text wt-chase-fx__text--${variant}`;
  el.textContent = text;
  el.style.transform = `translate(${reduce(px.x)}px, ${reduce(px.y)}px)`;
  layer.appendChild(el);
  const cleanup = (): void => {
    if (el.parentNode === layer) layer.removeChild(el);
  };
  if (reduced || typeof el.animate !== 'function') {
    setTimeout(cleanup, 600);
    return;
  }
  const anim = el.animate(
    [
      { transform: `${el.style.transform} translateY(0)`, opacity: 1 },
      { transform: `${el.style.transform} translateY(-28px)`, opacity: 0 },
    ],
    { duration: 900, easing: 'ease-out', fill: 'none' },
  );
  anim.onfinish = cleanup;
  anim.oncancel = cleanup;
}

/** 체포 풀스크린 오버레이(히트스톱·플래시·셰이크·톤다운·스탬프) — 단일 DOM 노드를 클래스 토글로
 *  단계 전환한다(§8.5/GlobeMap 관례 "고정 생성 후 클래스만"과 동일 원칙). CSS는 globals.css
 *  `.wt-chase-arrest-overlay`(WT-CH-07 신규)가 담당 — :root[data-reduced] 및 reduced 인자 양쪽에서
 *  애니메이션 클래스를 아예 추가하지 않는 것으로 이중 방어한다. */
function ensureArrestOverlay(layer: HTMLElement): HTMLDivElement {
  let el = layer.querySelector<HTMLDivElement>('.wt-chase-arrest-overlay');
  if (!el) {
    el = document.createElement('div');
    el.className = 'wt-chase-arrest-overlay';
    el.setAttribute('aria-hidden', 'true');
    layer.appendChild(el);
  }
  return el;
}

export function createChaseSequences(deps: ChaseSequencesDeps): ChaseSequencesController {
  const { engine, globe, audio, countries, lang } = deps;
  const countryById = new Map<CountryId, Country>();
  for (const c of countries) countryById.set(c.id, c);

  const pending = new Set<ReturnType<typeof setTimeout>>();
  function after(ms: number, fn: () => void): void {
    const id = setTimeout(() => {
      pending.delete(id);
      fn();
    }, ms);
    pending.add(id);
  }
  function clearPending(): void {
    for (const id of pending) clearTimeout(id);
    pending.clear();
  }

  let hasIssuedWanted = false;

  function nameOf(id: CountryId): string {
    const c = countryById.get(id);
    if (!c) return id;
    return lang === 'ko' ? c.nameKo : c.nameEn;
  }

  /** i18next.t 래퍼 — **명시적으로 `lng: lang`을 넘긴다**(전역 i18next.language에 암묵 의존 금지).
   *  이유: 이 모듈은 React 트리 밖(AppProviders의 changeLanguage 동기화 이펙트 밖)에서 호출될 수
   *  있고, deps.lang(=엔진 생성 시 넘긴 언어)이 이미 신뢰 가능한 원천이므로 그것으로 고정한다 —
   *  전역 상태가 아직 전환 중이거나(레이스) 테스트 환경의 기본 언어(navigator.language 추정)와
   *  달라도 항상 올바른 언어로 렌더링된다. */
  function tr(key: string, params?: Record<string, unknown>): string {
    return i18next.t(key, { lng: lang, ...params });
  }

  function floatAt(id: CountryId, text: string, variant: 'gold' | 'siren'): void {
    const layer = deps.getLayer();
    if (!layer) return;
    const px = anchorToPx(layer, globe, id);
    spawnFloatingText(layer, px, text, variant, deps.isReduced());
  }

  // ── 픽업(§7.6, 900ms) ────────────────────────────────────────────────────
  function runPickup(at: CountryId): void {
    globe.playPickup(at); // 0ms: 폴리곤 플래시(마커 레벨 — CH-05)
    after(PICKUP_TIMELINE_MS.coinSfxAbsorb, () => audio.goldCoin());
    after(PICKUP_TIMELINE_MS.badgeFloatingText, () => {
      floatAt(at, tr('chase.event.pickup'), 'gold');
    });
    // riseSparkle(80ms)은 순수 장식 파티클 — reduced/level1 강등 시 완전 생략(§7 헤더 "파티클 off").
    if (!deps.isReduced()) {
      after(PICKUP_TIMELINE_MS.riseSparkle, () => floatAt(at, '✨', 'gold'));
    }
  }

  // ── 배송(§7.6, 1,600ms) ──────────────────────────────────────────────────
  function runDelivery(count: number, payout: number): void {
    audio.vaultClunk(); // 0ms
    globe.playDelivery(payout, count); // 0ms: 홈 비컨 파열(마커 레벨 — CH-05)
    const home = engine.getSnapshot().home;
    after(DELIVERY_TIMELINE_MS.scoreRollup, () => {
      if (home) floatAt(home, tr('chase.event.delivery', { payout }), 'gold');
    });
    after(DELIVERY_TIMELINE_MS.fanfare, () => audio.caperFanfare());
    // starDescendOverlapRef(900ms)는 WantedHud/wantedChanged 배선 소관 — 여기선 트리거하지 않는다.
  }

  // ── 체포(§7.6, 2,800ms · D96 유일 블로킹 예외) ───────────────────────────
  function runArrest(at: CountryId, by: 'chaser' | 'interceptor' | 'heli'): void {
    const layer = deps.getLayer();
    const reduced = deps.isReduced();
    const overlay = layer ? ensureArrestOverlay(layer) : null;
    // by(체포 유닛 종류)는 chase.arrest.by{Chaser,Interceptor,Heli} i18n 키로 이미 존재하나, 이
    // 플로팅 텍스트 레이어는 caughtIn(국가명)만 발생 지점 위에 띄운다 — "○○ 유닛에게 검거"의 유닛
    // 라벨은 결과 카드(§7.7, WT-CH-08 소관)의 통계 행이 by 값을 직접 받아 노출하는 편이 화면
    // 밀도상 적절하다고 판단했다(플로팅 텍스트에 2줄 이상 얹지 않음 — 설계 결정, 최종 보고 기재).
    // by는 아래 비-reduced 경로에서 globe.playArrest(at, by) 호출에 그대로 쓰인다.

    if (reduced) {
      // §7.6 "reduced-motion: 히트스톱·플래시·셰이크 생략, 톤다운+스탬프 정적 표시 후 1s 뒤 결과".
      overlay?.classList.add('is-static-arrested');
      if (overlay) overlay.textContent = tr('chase.arrest.stamp');
      floatAt(at, tr('chase.arrest.caughtIn', { country: nameOf(at) }), 'siren');
      after(ARREST_REDUCED_TIMELINE_MS.result, () => deps.onArrestComplete?.());
      return;
    }

    // 0ms: 히트스톱(D96 유일 예외) — 프리즈 신호 클래스 + 마커 팝은 히트스톱 종료 후에 재생해
    // "정지된 한 프레임" 느낌을 지킨다.
    overlay?.classList.add('is-hitstop');
    after(ARREST_TIMELINE_MS.flashTriple, () => {
      overlay?.classList.remove('is-hitstop');
      overlay?.classList.add('is-flash');
      audio.sirenDoppler(); // "사이렌 최대 볼륨 1회"(재사용 — 별도 리전 없음, §7.8 "사이렌 재사용")
      after(ARREST_FLASH_STEP_MS * 3, () => overlay?.classList.remove('is-flash'));
    });
    after(ARREST_TIMELINE_MS.polygonHandcuffs, () => {
      globe.playArrest(at, by); // 마커 레벨(CH-05) — 체포국 점등 + 경찰 마커 슬라이드
      audio.handcuffs();
    });
    after(ARREST_TIMELINE_MS.cameraShake, () => overlay?.classList.add('is-shake'));
    after(ARREST_TIMELINE_MS.tonedownStamp, () => {
      overlay?.classList.remove('is-shake');
      overlay?.classList.add('is-tonedown');
      if (overlay) overlay.textContent = tr('chase.arrest.stamp');
      floatAt(at, tr('chase.arrest.caughtIn', { country: nameOf(at) }), 'siren');
    });
    after(ARREST_TIMELINE_MS.wantedRedo, () => overlay?.classList.add('is-wanted-redo'));
    after(ARREST_TIMELINE_MS.resultSlide, () => deps.onArrestComplete?.());
  }

  // ── 수배 발령/상승/하강(§7.4 사운드만 — 시각은 CH-06 WantedHud 소관) ─────
  function runWantedChanged(direction: 'up' | 'down'): void {
    if (direction === 'down') {
      audio.radioStatic();
      return;
    }
    if (!hasIssuedWanted) {
      hasIssuedWanted = true;
      // §7.6 "수배 발령(최초 ★1)" — 600ms 1회성. 레이더 스윕 시각은 globe-chase.ts(CH-05)가 이미
      // 그리는 레이더 화살표 레이어와 별개 부채꼴 스윕이 필요하나, CH-05 재작성 금지 제약상 이
      // 파일은 스윕을 위한 신규 SVG를 추가하지 않고(캔버스/CH-05 오버레이 무변경) 음성풍 SFX +
      // 사이렌 도플러만으로 "이제 쫓긴다" 전환을 알린다(시각적 스윕 생략은 설계 축소 — 최종 보고
      // 기재. reduced 여부와 무관하게 항상 재생 — 사운드는 모션 설정이 아니라 사운드 설정 3단
      // 소관, §8.10).
      audio.radioStatic();
    }
    audio.sirenDoppler();
  }

  const unsubEngine = engine.subscribe((e: ChaseEngineEvent) => {
    switch (e.type) {
      case 'phase':
        if (e.phase === 'countdown') hasIssuedWanted = false; // 재도전 대비(§7.6 최초 1회 리셋).
        break;
      case 'goldPicked':
        runPickup(e.at);
        break;
      case 'delivered':
        runDelivery(e.count, e.payout);
        break;
      case 'arrested':
        runArrest(e.at, e.by);
        break;
      case 'wantedChanged':
        runWantedChanged(e.direction);
        break;
      default:
        break;
    }
  });

  return {
    dispose(): void {
      clearPending();
      unsubEngine();
    },
  };
}
