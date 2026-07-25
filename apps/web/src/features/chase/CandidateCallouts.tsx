// spec: docs/09-chase-mode-goldrunner.md §7.3(선택지 콜아웃 칩 3개 — 인월드 앵커)·§8.5(해부도·배치
//       알고리즘·상태 매트릭스·구현 계약), docs/09a §5, docs/00 §11-D66·D67·D69·D90~D97, WT-CH-06.
//
// 지구본 위 후보국에 리더 라인으로 앵커된 콜아웃 칩 3개. GlobeMap SVG 오버레이(GlobeMap.tsx)와
// 동일한 명령형 계층 원칙 — 칩 3개 DOM 노드를 마운트 시 **고정 생성**하고, 이후 candidatesShown/
// candidateDangerChanged/hopCommitted/goldSpawned·Picked/controller 타이핑 이벤트에 반응해 내용·
// transform만 갱신한다. React 리렌더 경유 금지(§03-4.5, §8.5 구현 계약) — 이 컴포넌트는 마운트 후
// React 커밋 0회를 목표로 한다(GlobeMap.tsx "마운트 후 React 커밋 0회" 계약과 동일 원칙).
//
// [engine.getCandidateCountries() 미사용 — 실측 확인, 최종 보고 기재] use-chase-engine.ts와 동일
// 사유: candidatesShown 리스너 콜백 안에서 그 메서드를 호출하면 아직 갱신 전인 이전 홉 값이 반환된다
// (chase-session.ts의 afterAdvance가 processNewSimEvents 이후에 syncCandidates를 실행 — 파일
// use-chase-engine.ts 상단 주석 참조). 이 컴포넌트도 반드시 이벤트가 실어 보내는 candidates[].id를
// props.countries 테이블로 직접 조회한다.
//
// [배치 좌표계] callout-layout.ts의 순수 함수들은 GlobeChaseHandle.projectAnchor와 동일한
// viewBox(960×500) 논리 좌표계에서 동작한다. 이 컴포넌트는 자체 오버레이 컨테이너의 실제 렌더 크기를
// ResizeObserver로 추적해 fitViewBoxToContainer(SVG `xMidYMid meet`와 동일 공식)로 실 픽셀로 변환한다
// — GlobeMap 코어의 canvas/svg가 쓰는 것과 동일한 letterbox 매핑이라 마커·화살표와 정확히 겹친다.
//
// [prehighlight는 동시 1개만 — 설계 결정, 최종 보고 기재] §7.3은 prefix 공유 시 칩 2개가 동시에
// matching 상태일 수 있다고 명시하지만, GlobeChaseHandle.setCandidatePrehighlight(id|null)는 CH-05가
// 이미 확정한 단일 id 시그니처다(수정 금지). 슬롯 순서(0→2)상 가장 먼저 matching인 후보만
// 프리하이라이트한다 — 칩 자체의 금색 테두리 점등(다중 가능)은 그대로 정확하다.
//
// ── WT-CH-DEV-4(§11-D115-A) 작전 카드 = 칩 + 인텔 행 ────────────────────────────────────────
// "판단은 카드에서, 지도는 확인": 홉 결정에 필요한 정보(금·홈 방향·이동 거리)가 회전하는 지구본
// 위에만 있어 반대편·소형 마커 탐색 부하가 컸다. 칩 하단에 인텔 행 1줄(h16)을 더해 세 값을 카드
// 안에서 바로 읽게 한다. 데이터는 **전부 기존 이벤트 + chase-graph 전쌍 km 행렬 파생**이며 신규
// 엔진 이벤트는 만들지 않는다(D7 정신 승계):
//   💰  후보국에 활성 금(goldSpawned/goldPicked 추적) · 💰↗ 후보의 1홉 이웃(graph.outNeighbors)에 금
//   ▼/▲ 홈 델타 = km(후보,홈) − km(현재,홈) — 가까워지면 ▼, 멀어지면 ▲(배송 중이면 강조)
//   km  이동 거리 = km(현재,후보)
// 갱신은 candidatesShown/goldSpawned/goldPicked/delivered(전부 저빈도)에서만 발생하고, 갱신 방식은
// 이 파일의 기존 계약대로 **명령형 textContent/속성 조작**이다(React 커밋 0회 유지 — 저빈도라 state를
// 써도 규약 위반은 아니지만, 이 컴포넌트만은 마운트 후 리렌더 0 계약이 더 강한 제약이라 유지).
// 위험(danger)은 기존 D97 배선 그대로이며 시각 강조만 강화한다(테두리 2.5px + 적색 글로우, CSS).
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { TypingInputController } from '@wt/engine';
import {
  compileTargets,
  matchInputDetail,
  type CompiledChaseGraph,
  type Country,
  type CountryId,
  type GoldRing,
  type MatchDetail,
} from '@wt/shared';
import type { ChaseSessionEngine } from '@wt/engine';
import type { GlobeChaseHandle } from '../map/globe/globe-chase';
import { PromptRenderer } from '../typing/prompt-renderer';
import {
  CHIP_H,
  CHIP_W,
  chipEdgeTowardAnchor,
  computeCalloutLayout,
  fitViewBoxToContainer,
  toContainerPx,
  type CalloutAnchor,
  type Point,
} from './callout-layout';
import { deriveChipVisualState, type ChipStateInput } from './candidate-state';

export interface CandidateCalloutsProps {
  /** ChaseSessionEngine(마운트 상수 — 교체 시 이 컴포넌트가 재구독한다). */
  engine: ChaseSessionEngine;
  /** useChaseEngine()이 반환한 controller(부착 전 null 허용 — 준비되는 대로 구독). */
  controller: TypingInputController | null;
  /** CH-05 GlobeChaseHandle — projectAnchor/onHopLifecycle/setCandidateAnchors/setCandidatePrehighlight
   *  4메서드가 이 컴포넌트의 유일한 지구본 접점(§7.5 "콜아웃 분업"). */
  globe: GlobeChaseHandle;
  /** 전체 국가 테이블(engine 생성 시 넘긴 것과 동일 배열 — candidatesShown.candidates[].id 조회원천). */
  countries: readonly Country[];
  /** compileGraph(graph) 결과(§11-D115-A 인텔 행 원천) — 전쌍 정수 km(`dist`)과 nearest 12
   *  (`outNeighbors`)만 읽는다. 심이 쓰는 것과 **동일 객체**라 표시와 판단 기준이 어긋날 수 없다. */
  graph: CompiledChaseGraph;
  lang: 'ko' | 'en';
}

const SLOT_COUNT = 3;
/** 확정(committed) 흡수 소멸 애니메이션 지속(§8.5 "160ms"). */
const COMMIT_MS = 160;
/** 등장 순차 간격(§7.3 "3개 순차 50ms"). */
const ENTER_STAGGER_MS = 50;

interface Slot {
  chipEl: HTMLDivElement;
  leaderEl: HTMLDivElement;
  flagEl: HTMLSpanElement;
  nameEl: HTMLSpanElement;
  tierEl: HTMLSpanElement;
  statusEl: HTMLSpanElement;
  glyphsEl: HTMLDivElement;
  /** §11-D115-A 인텔 행 3셀(금 / 홈 델타 / 이동 거리) — textContent·data 속성만 갱신. */
  goldEl: HTMLSpanElement;
  homeEl: HTMLSpanElement;
  kmEl: HTMLSpanElement;
  renderer: PromptRenderer;
  id: CountryId | null;
  targets: ReturnType<typeof compileTargets>;
  danger: boolean;
  gold: boolean;
  home: boolean;
  matching: boolean;
  committed: boolean;
  committedTimer: ReturnType<typeof setTimeout> | null;
  enterTimer: ReturnType<typeof setTimeout> | null;
}

function setFlag(el: HTMLSpanElement, country: Country): void {
  el.replaceChildren();
  const img = document.createElement('img');
  img.src = `/flags/${country.id.toLowerCase()}.svg`;
  img.alt = '';
  img.draggable = false;
  img.className = 'wt-candidate-chip__flag-img';
  img.onerror = () => {
    el.textContent = country.flagEmoji;
  };
  el.appendChild(img);
}

/** §8.5 헤더 해부도 "상태 아이콘 슬롯(💰|🏦|🚨)" — 동시에 여럿이면 위험 > 금 > 홈 우선(상태
 *  매트릭스 우선순위와 동일 취지). matching/committed/idle은 전용 아이콘 없음(빈 슬롯). */
function statusIconFor(slot: Slot): string {
  if (slot.danger) return '🚨';
  if (slot.gold) return '💰';
  if (slot.home) return '🏦';
  return '';
}

function applyVisualState(slot: Slot): void {
  const input: ChipStateInput = {
    matching: slot.matching,
    danger: slot.danger,
    gold: slot.gold,
    home: slot.home,
    committed: slot.committed,
  };
  const state = deriveChipVisualState(input);
  slot.chipEl.setAttribute('data-state', state);
  // 리더 라인은 칩과 별개 DOM 노드(overlay 내 형제, 순서상 칩보다 먼저 삽입 — z-순서 §8.3)라 CSS
  // 형제 결합자로는 안전하게 연결할 수 없다. data-state를 그대로 미러링해 속성 선택자로 동기화한다.
  slot.leaderEl.setAttribute('data-state', state);
  slot.statusEl.textContent = statusIconFor(slot);
}

export function CandidateCallouts({
  engine,
  controller,
  globe,
  countries,
  graph,
  lang,
}: CandidateCalloutsProps) {
  // 마운트 시점 t를 캡처해 명령형 effect 안에서 쓴다(engine/globe/lang과 동일한 "마운트 상수"
  // 취급 — 이 컴포넌트의 리렌더 0 계약, 파일 하단 deps [] 주석 참조). 인텔 행의 가시 텍스트는
  // 아이콘·숫자뿐이라 언어 중립이고, i18n은 title(툴팁·§7.3 "거리 정보는 툴팁으로 강등")에만 쓴다.
  const { t } = useTranslation();
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const announceRef = useRef<HTMLDivElement | null>(null);
  const slotsRef = useRef<Slot[]>([]);
  // 두 effect(엔진 배선 / 컨트롤러 에코)가 공유하는 마지막 프리하이라이트 id — 매 키스트로크마다
  // globe.setCandidatePrehighlight를 무조건 다시 부르면 d3-geo path 재계산이 매번 돌아 입력 지연
  // 예산(§11 p95<16ms)을 위협한다. ref로 공유해 값이 바뀔 때만 호출한다.
  const prehighlightRef = useRef<CountryId | null>(null);

  // ── 엔진/지구본 배선(마운트 1회 — engine/globe/countries/lang은 마운트 상수 취급) ──────────
  useEffect(() => {
    const overlayMaybe = overlayRef.current;
    if (!overlayMaybe) return;
    // 아래 나머지 로직은 전부 hoisted function 선언(closure)에서 overlay를 참조한다 — TS는 hoisted
    // 함수 본문에 바깥 스코프의 흐름 narrowing을 전달하지 않으므로, 널이 아님이 확정된 새 const에
    // 재바인딩해 모든 클로저가 HTMLDivElement(non-null) 타입으로 캡처하게 한다(표준 우회).
    const overlay: HTMLDivElement = overlayMaybe;

    const countryById = new Map<CountryId, Country>();
    for (const c of countries) countryById.set(c.id, c);

    function createSlot(index: number): Slot {
      const chipEl = document.createElement('div');
      chipEl.className = 'wt-candidate-chip';
      chipEl.setAttribute('data-candidate', '');
      chipEl.setAttribute('data-slot', String(index));
      chipEl.setAttribute('data-state', 'idle');
      chipEl.style.opacity = '0'; // 첫 candidatesShown 전까지 숨김(§8.5 "마운트 시 고정 생성")

      const header = document.createElement('div');
      header.className = 'wt-candidate-chip__header';
      // 슬롯 번호(1~3) — 지구본 앵커 배지·대권 연결선의 data-candidate-slot과 짝을 이뤄 "몇 번 칩이
      // 어느 나라인지"를 즉시 읽히게 한다(§11-D108-C). 슬롯↔후보 매핑은 마운트 후 불변이라 여기서
      // 1회만 쓴다. 표시 전용이므로 스크린리더에서 제외(칩 전체가 이미 aria-hidden 조상 아래).
      const indexEl = document.createElement('span');
      indexEl.className = 'wt-candidate-chip__index';
      indexEl.setAttribute('aria-hidden', 'true');
      indexEl.textContent = String(index + 1);
      const flagEl = document.createElement('span');
      flagEl.className = 'wt-candidate-chip__flag';
      const nameEl = document.createElement('span');
      nameEl.className = 'wt-candidate-chip__name';
      const tierEl = document.createElement('span');
      tierEl.className = 'wt-candidate-chip__tier';
      const statusEl = document.createElement('span');
      statusEl.className = 'wt-candidate-chip__status';
      statusEl.setAttribute('aria-hidden', 'true');
      header.append(indexEl, flagEl, nameEl, tierEl, statusEl);

      const glyphsEl = document.createElement('div');
      glyphsEl.className = 'wt-candidate-chip__slots';

      // §11-D115-A 인텔 행 — 셀 3개는 마운트 시 고정 생성하고 이후 textContent/data 속성만 바꾼다
      // (노드 추가·삭제 금지 = 리플로우 최소, §8.6 HUD 관례와 동일).
      const intelEl = document.createElement('div');
      intelEl.className = 'wt-candidate-chip__intel';
      intelEl.setAttribute('aria-hidden', 'true');
      const goldEl = document.createElement('span');
      goldEl.className = 'wt-candidate-chip__intel-cell wt-candidate-chip__intel-gold';
      goldEl.setAttribute('data-gold', 'none');
      const homeEl = document.createElement('span');
      homeEl.className = 'wt-candidate-chip__intel-cell wt-candidate-chip__intel-home';
      homeEl.setAttribute('data-home', 'same');
      const kmEl = document.createElement('span');
      kmEl.className = 'wt-candidate-chip__intel-cell wt-candidate-chip__intel-km';
      intelEl.append(goldEl, homeEl, kmEl);

      chipEl.append(header, glyphsEl, intelEl);

      const leaderEl = document.createElement('div');
      leaderEl.className = 'wt-candidate-chip__leader';
      leaderEl.setAttribute('data-state', 'idle');
      leaderEl.style.opacity = '0';

      overlay.append(leaderEl, chipEl);

      return {
        chipEl, leaderEl, flagEl, nameEl, tierEl, statusEl, glyphsEl, goldEl, homeEl, kmEl,
        renderer: new PromptRenderer(),
        id: null, targets: [], danger: false, gold: false, home: false,
        matching: false, committed: false, committedTimer: null, enterTimer: null,
      };
    }

    const slots: Slot[] = Array.from({ length: SLOT_COUNT }, (_, i) => createSlot(i));
    slotsRef.current = slots;

    let homeId: CountryId | null = null;
    /** 활성 금 국가 → 링 등급(가치 힌트). goldSpawned/goldPicked만이 원천(엔진 재구현 없음). */
    const goldAt = new Map<CountryId, GoldRing>();
    /** 현재국·소지 수는 candidatesShown 시점 스냅샷에서 읽는다 — chase-session은 심 전진(simState
     *  갱신) 후에 이벤트를 방출하므로 이 콜백 안의 getSnapshot()은 항상 신선하다(후보 id만이
     *  예외라 이벤트 값을 쓴다 — 파일 상단 주석). */
    let currentId: CountryId | null = null;
    let carried = 0;
    let rotating = false;
    let pendingReposition: CountryId[] | null = null;

    function announce(msg: string): void {
      if (announceRef.current) announceRef.current.textContent = msg;
    }

    function contentFor(slot: Slot, country: Country): void {
      slot.id = country.id;
      slot.targets = compileTargets(country, lang);
      slot.renderer.mount(slot.glyphsEl, country, lang);
      setFlag(slot.flagEl, country);
      slot.nameEl.textContent = lang === 'ko' ? country.nameKo : country.nameEn;
      slot.tierEl.textContent = `T${country.difficultyTier}`;
      slot.matching = false;
      slot.committed = false;
      if (slot.committedTimer) {
        clearTimeout(slot.committedTimer);
        slot.committedTimer = null;
      }
    }

    /**
     * §11-D115-A 인텔 행 갱신(1슬롯). 전부 기존 이벤트 + km 행렬 파생이며 그래프에 없는 id
     * (계약상 발생하지 않음 — chase-graph.ids = un195)에서는 셀을 비워 방어한다.
     */
    function refreshIntel(slot: Slot): void {
      const id = slot.id;
      if (!id) return;
      const known = graph.has(id);

      // ① 금 — 후보국 본인 > 1홉 이웃 > 없음.
      const ring = goldAt.get(id);
      if (ring) {
        slot.goldEl.textContent = '💰';
        slot.goldEl.setAttribute('data-gold', 'here');
        slot.goldEl.setAttribute('data-gold-ring', ring);
        slot.goldEl.title = t('chase.card.goldHere');
      } else {
        const near =
          known && goldAt.size > 0 && graph.outNeighbors(id).some((nb) => goldAt.has(nb));
        slot.goldEl.textContent = near ? '💰↗' : '';
        slot.goldEl.setAttribute('data-gold', near ? 'near' : 'none');
        slot.goldEl.removeAttribute('data-gold-ring');
        slot.goldEl.title = near ? t('chase.card.goldNear') : '';
      }

      // ② 홈 델타 — km(후보,홈) − km(현재,홈). 배송 중(carried>0)이면 강조.
      const homeKnown = known && homeId !== null && currentId !== null && graph.has(homeId) && graph.has(currentId);
      if (homeKnown && homeId && currentId) {
        const delta = graph.dist(id, homeId) - graph.dist(currentId, homeId);
        const state = delta < 0 ? 'closer' : delta > 0 ? 'farther' : 'same';
        slot.homeEl.textContent = delta === 0 ? '·' : `${delta < 0 ? '▼' : '▲'}${Math.abs(delta)}`;
        slot.homeEl.setAttribute('data-home', state);
        slot.homeEl.title =
          delta === 0
            ? ''
            : t(delta < 0 ? 'chase.card.homeCloser' : 'chase.card.homeFarther', { km: Math.abs(delta) });
      } else {
        slot.homeEl.textContent = '';
        slot.homeEl.setAttribute('data-home', 'same');
        slot.homeEl.title = '';
      }
      slot.homeEl.classList.toggle('is-delivering', carried > 0);

      // ③ 이동 거리 — km(현재, 후보).
      if (known && currentId && graph.has(currentId)) {
        const km = graph.dist(currentId, id);
        slot.kmEl.textContent = t('chase.card.distanceKm', { km });
        slot.kmEl.title = t('chase.card.moveKm', { km });
      } else {
        slot.kmEl.textContent = '';
        slot.kmEl.title = '';
      }
    }

    function refreshAllIntel(): void {
      for (const slot of slots) if (slot.id) refreshIntel(slot);
    }

    /** §8.5 "등장 모션" — 리더 라인 성장 + 칩 스케일 인, 슬롯 순서로 50ms 순차. */
    function triggerEnter(slot: Slot, index: number): void {
      if (slot.enterTimer) {
        clearTimeout(slot.enterTimer);
        slot.enterTimer = null;
      }
      slot.chipEl.classList.remove('wt-candidate-chip--enter');
      slot.leaderEl.classList.remove('wt-candidate-chip__leader--grow');
      // 재생 강제 리플로우(prompt-renderer.pop()과 동일 트릭 — class 재적용만으로는 애니 재시작 안 됨).
      void slot.chipEl.offsetWidth;
      slot.enterTimer = setTimeout(() => {
        slot.chipEl.classList.add('wt-candidate-chip--enter');
        slot.leaderEl.classList.add('wt-candidate-chip__leader--grow');
        slot.enterTimer = null;
      }, index * ENTER_STAGGER_MS);
    }

    function containerSize(): { w: number; h: number } {
      const rect = overlay.getBoundingClientRect();
      return { w: rect.width, h: rect.height };
    }

    /** 칩·리더 라인 위치를 컨테이너 실픽셀로 반영(§8.5 1~4단계 + xMidYMid 매핑). */
    function repositionChips(ids: readonly CountryId[]): void {
      const { w, h } = containerSize();
      const fit = fitViewBoxToContainer(w, h);
      // globe.projectAnchor는 항상 좌표를 반환한다(non-nullable 시그니처 — §7.5 헤더 주석).
      const anchors: CalloutAnchor[] = ids.map((id) => {
        const a = globe.projectAnchor(id);
        return { id, x: a.x, y: a.y };
      });
      const layout = computeCalloutLayout(anchors);

      layout.forEach((pos, i) => {
        const slot = slots.find((s) => s.id === pos.id) ?? slots[i];
        if (!slot) return;
        const chipCenter: Point = { x: pos.x, y: pos.y };
        const centerPx = toContainerPx(chipCenter, fit);
        slot.chipEl.style.transform = `translate(${centerPx.x - CHIP_W / 2}px, ${centerPx.y - CHIP_H / 2}px)`;

        const anchorViewbox = anchors.find((a) => a.id === pos.id);
        if (anchorViewbox) {
          const edgeViewbox = chipEdgeTowardAnchor(chipCenter, anchorViewbox);
          const anchorPx = toContainerPx(anchorViewbox, fit);
          const edgePx = toContainerPx(edgeViewbox, fit);
          const dx = anchorPx.x - edgePx.x;
          const dy = anchorPx.y - edgePx.y;
          const len = Math.hypot(dx, dy);
          const angle = (Math.atan2(dy, dx) * 180) / Math.PI;
          slot.leaderEl.style.transform = `translate(${edgePx.x}px, ${edgePx.y}px) rotate(${angle}deg)`;
          slot.leaderEl.style.width = `${len}px`;
          slot.leaderEl.style.opacity = '';
        }
      });
    }

    function setGhost(on: boolean): void {
      for (const slot of slots) slot.chipEl.classList.toggle('wt-candidate-chip--ghost', on);
    }

    function refreshPrehighlight(): void {
      const first = slots.find((s) => s.matching && s.id)?.id ?? null;
      if (first === prehighlightRef.current) return;
      prehighlightRef.current = first;
      globe.setCandidatePrehighlight(first);
    }

    function onCandidatesShown(candidates: readonly { id: CountryId; danger: boolean }[]): void {
      const snap = engine.getSnapshot();
      homeId = snap.home;
      currentId = snap.player;
      carried = snap.carriedCount;
      const ids: CountryId[] = [];
      candidates.forEach((cv, i) => {
        const slot = slots[i];
        const country = countryById.get(cv.id);
        if (!slot || !country) return;
        ids.push(cv.id);
        contentFor(slot, country);
        slot.danger = cv.danger;
        slot.gold = goldAt.has(cv.id);
        slot.home = cv.id === homeId;
        applyVisualState(slot);
        refreshIntel(slot);
        slot.chipEl.style.opacity = '';
        triggerEnter(slot, i);
        if (slot.danger) announce(`${lang === 'ko' ? country.nameKo : country.nameEn}: checkpoint`);
      });
      for (let i = candidates.length; i < SLOT_COUNT; i++) {
        const slot = slots[i];
        if (!slot) continue;
        slot.id = null;
        slot.chipEl.style.opacity = '0';
      }
      refreshPrehighlight();
      if (ids.length > 0) globe.setCandidateAnchors(ids);

      if (rotating) {
        pendingReposition = ids;
      } else if (ids.length > 0) {
        repositionChips(ids);
      }
    }

    const unsubEngine = engine.subscribe((e) => {
      switch (e.type) {
        case 'candidatesShown':
          onCandidatesShown(e.candidates);
          break;
        case 'candidateDangerChanged': {
          const slot = slots.find((s) => s.id === e.countryId);
          if (slot) {
            slot.danger = e.danger;
            applyVisualState(slot);
          }
          break;
        }
        case 'goldSpawned': {
          goldAt.set(e.at, e.ring);
          const slot = slots.find((s) => s.id === e.at);
          if (slot) {
            slot.gold = true;
            applyVisualState(slot);
          }
          // 이웃 금(💰↗)은 다른 슬롯에도 영향을 주므로 3칩 전부 갱신한다(저빈도 — 최대 3회 루프).
          refreshAllIntel();
          break;
        }
        case 'goldPicked': {
          goldAt.delete(e.at);
          carried = engine.getSnapshot().carriedCount;
          const slot = slots.find((s) => s.id === e.at);
          if (slot) {
            slot.gold = false;
            applyVisualState(slot);
          }
          refreshAllIntel();
          break;
        }
        case 'delivered':
          // 배송 정산 = 소지 0 복귀 → 홈 델타 강조 해제(§11-D115-A "배송 중 시각 강조").
          carried = engine.getSnapshot().carriedCount;
          refreshAllIntel();
          break;
        case 'hopCommitted': {
          const slot = slots.find((s) => s.id === e.to);
          if (slot) {
            slot.committed = true;
            applyVisualState(slot);
            if (slot.committedTimer) clearTimeout(slot.committedTimer);
            slot.committedTimer = setTimeout(() => {
              slot.committed = false;
              slot.committedTimer = null;
              applyVisualState(slot);
            }, COMMIT_MS);
          }
          break;
        }
        default:
          break;
      }
    });

    const unsubHop = globe.onHopLifecycle((phase) => {
      if (phase === 'start') {
        rotating = true;
        setGhost(true);
      } else {
        rotating = false;
        setGhost(false);
        const ids = pendingReposition ?? slots.map((s) => s.id).filter((id): id is CountryId => id !== null);
        pendingReposition = null;
        if (ids.length > 0) repositionChips(ids);
      }
    });

    // 컨테이너 리사이즈에도 좌표 매핑을 갱신(회전 중이면 재배치 보류 — 규칙 5와 동일 게이팅).
    let ro: ResizeObserver | null = null;
    if (typeof ResizeObserver === 'function') {
      ro = new ResizeObserver(() => {
        const ids = slots.map((s) => s.id).filter((id): id is CountryId => id !== null);
        if (ids.length === 0) return;
        if (rotating) pendingReposition = ids;
        else repositionChips(ids);
      });
      ro.observe(overlay);
    }

    return () => {
      unsubEngine();
      unsubHop();
      ro?.disconnect();
      for (const slot of slots) {
        if (slot.committedTimer) clearTimeout(slot.committedTimer);
        if (slot.enterTimer) clearTimeout(slot.enterTimer);
        slot.renderer.unmount();
        slot.chipEl.remove();
        slot.leaderEl.remove();
      }
      slotsRef.current = [];
      prehighlightRef.current = null;
    };
    // deps 의도적 []: engine/globe/countries/lang은 마운트 상수 취급(GlobeMap.tsx "index는 마운트
    // 상수" 관례와 동일 — 리렌더 0 계약). 이 프로젝트는 react-hooks/exhaustive-deps를 활성화하지
    // 않는다(eslintrc 확인).
  }, []);

  // ── 컨트롤러 입력 에코(칩별 병렬 matchInputDetail — D97) ────────────────────────────────
  useEffect(() => {
    if (!controller) return;

    function evaluateAll(raw: string): void {
      const slots = slotsRef.current;
      for (const slot of slots) {
        if (!slot.id || slot.targets.length === 0) continue;
        const detail: MatchDetail = matchInputDetail(raw, slot.targets, lang);
        slot.renderer.update(detail, raw);
        const wasMatching = slot.matching;
        slot.matching =
          detail.inputLen > 0 && (detail.state === 'PREFIX' || detail.state === 'EXACT');
        if (detail.state === 'MISS' && detail.inputLen > 0) slot.renderer.shake();
        if (wasMatching !== slot.matching) applyVisualState(slot);
      }
      const first = slots.find((s) => s.matching && s.id)?.id ?? null;
      if (first !== prehighlightRef.current) {
        prehighlightRef.current = first;
        globe.setCandidatePrehighlight(first);
      }
    }

    const unsub = controller.subscribe((e) => {
      switch (e.type) {
        case 'progress':
          evaluateAll(e.rawValue);
          break;
        case 'miss':
          evaluateAll(controller.getValue());
          break;
        default:
          break; // exact/bulkInsert/blur 등은 표시 계층 무관(committed는 hopCommitted가 담당)
      }
    });
    return unsub;
  }, [controller, globe, lang]);

  return (
    <>
      {/* 칩·리더 라인은 전부 표시 전용(선택은 타이핑) — 조상에서 aria-hidden으로 스크린리더 제외.
          단 아래 aria-live 공지는 별도 형제 노드라 이 은닉과 무관하다(aria-hidden 조상 안의 live
          region은 대부분의 스크린리더에서 무시되므로 반드시 밖에 둔다). */}
      <div className="wt-candidate-overlay" ref={overlayRef} data-testid="chase-candidate-overlay" aria-hidden="true" />
      <div ref={announceRef} aria-live="polite" className="sr-only" data-testid="chase-candidate-announcer" />
    </>
  );
}
