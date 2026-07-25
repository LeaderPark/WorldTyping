// spec: docs/09-chase-mode-goldrunner.md §7.5(지구본 무대 — 레이더 에지 화살표·위협 앰비언스)·
//       §8.3(슬림 HUD·하단 비움)·§8.10(a11y), docs/09a §2·§4, docs/00 §11-D108(앵커 단일화)·
//       D111 ②-b(수배 스윕)·D115-B(수배 레이더), WT-CH-DEV-4.
//
// ── 왜 필요한가 ────────────────────────────────────────────────────────────────────────────
// 지구본은 "확인"에는 좋지만 "판단"에는 느리다 — 금·경찰·홈이 회전하는 구(球) 위에 흩어져 있어
// 반대편(뒷면)으로 넘어가면 레이더 에지 화살표 하나로 축약되고, 소형 마커는 탐색 부하가 크다.
// 이 컴포넌트는 **현재국 기준 방위·거리를 북쪽 고정 평면에 한 번에** 펼쳐 "어느 쪽에 무엇이
// 얼마나 떨어져 있나"를 1회 눈길로 읽게 한다(GTA 미니맵 오마주 — 모드 정체성과도 일치).
//
// ── 계약 ──────────────────────────────────────────────────────────────────────────────────
// · 데이터는 전부 **기존 엔진 이벤트 + chase-graph 전쌍 km 행렬** 파생이다(신규 엔진 이벤트 0).
//   hopCommitted/candidatesShown(현재국) · policeUpdated(경찰) · goldSpawned/goldPicked(금) ·
//   delivered/goldPicked(소지 수) · wantedChanged(스윕). 전부 저빈도라 React state로 충분하다
//   (§03-4.5의 "고빈도 값" 목록 — 입력 버퍼·실시간 CPM·콤보·경과 시간 — 에 해당하지 않는다).
// · 방위각은 globe-hop.ts의 `bearingDeg`를 그대로 재사용하고(수학 재구현 금지), 거리는 심이 쓰는
//   것과 동일한 `CompiledChaseGraph.dist`(정수 km)를 쓴다 — 표시와 판단 기준이 어긋날 수 없다.
// · 상시 rAF 없음(D67 계약 승계): 이벤트 시 재계산 → React 커밋 1회. 펄스·스윕은 CSS/WAAPI 없이
//   순수 CSS 애니메이션이라 메인 스레드 부담이 없고 reduced-motion에서 자동 정지한다.
// · 북쪽 고정(회전 없음) — 지구본 카메라와 별개 좌표계라 "지구본이 돌면 레이더도 돈다"는 혼란이
//   없다(단순 우선, D115-B 지시).
//
// [스윕 일원화 판단 — 최종 보고 기재] D111 ②-b의 지구본 스윕(42° 부채꼴 1회전 600ms)은 **런당
// 1회**(최초 ★1 발령)만 돈다 — sequences.ts의 `hasIssuedWanted` 게이트가 그렇게 정의하고, 그
// 호출은 오디오 타임라인(radioStatic/sirenDoppler)과 같은 함수 안에 묶여 있다. 반면 이 레이더
// 스윕은 **매 ★상승**에 돈다. 둘은 중복이 아니라 포함 관계이고, ★1 순간에는 동일 지속(600ms)으로
// 동시에 돌아 "하나의 경보"로 읽힌다. 지구본 쪽을 제거(이관)하면 확정 결정(D111)을 되돌리고
// 오디오 오프셋 계약까지 건드리게 되므로 **동기(synchronize)를 택했다** — 지구본 무수정.
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ChaseSessionEngine, PoliceView } from '@wt/engine';
import type { CompiledChaseGraph, Country, CountryId, GoldRing } from '@wt/shared';
import { bearingDeg, type LngLat } from '../map/globe/globe-hop';

export interface ChaseRadarProps {
  engine: ChaseSessionEngine;
  /** compileGraph(graph) — 전쌍 정수 km(dist)만 읽는다(심과 동일 객체). */
  graph: CompiledChaseGraph;
  /** 전체 국가 테이블 — 앵커(latlng) 원천. globe-chase.ts의 chaseAnchor와 동일한 점(§11-D108-A). */
  countries: readonly Country[];
  /** 배송지(홈). ChaseGameRoot가 시드에서 결정적으로 파생해 넘긴다(브리핑 시점부터 확정). */
  homeId: CountryId;
  /** reduced-motion/juice 강등 여부 — true면 스윕·펄스를 재생하지 않는다(§11 강등표). */
  reduced: boolean;
}

/** 레이더 논리 크기(정사각 viewBox). 실제 표시 크기는 CSS(.wt-chase-radar)가 정한다. */
export const RADAR_SIZE = 120;
/** 최외곽 링 반경(px, viewBox 단위). 중심은 (RADAR_SIZE/2, RADAR_SIZE/2). */
export const RADAR_R = 52;
/** 로그 스케일 포화 거리 — 지구 반바퀴(대권 최대 ≈20,015km)를 최외곽 링에 맞춘다. */
export const RADAR_MAX_KM = 20_000;
/** 스윕 1회전 지속 — globe-chase.ts RADAR_SWEEP_MS(600)와 동일 값(파일 헤더 "동기" 판단). */
export const RADAR_SWEEP_MS = 600;
/** 이 거리 이내의 경찰 블립은 펄스(§3.3 "도주 감소 = 전 유닛과 ≥3,000km" 경계 재사용). */
export const RADAR_ALERT_KM = 3_000;

const CENTER = RADAR_SIZE / 2;
const LOG_MAX = Math.log1p(RADAR_MAX_KM / 1000);

/**
 * 거리(km) → 레이더 반경(px). 로그 스케일 — 근거리(홉 1~2회 사거리, 1,000~4,000km)에 해상도를
 * 몰아주고 지구 반대편도 링 안에 담는다. 0km는 정확히 중심, RADAR_MAX_KM 이상은 최외곽에 클램프.
 */
export function radarRadius(km: number): number {
  if (!Number.isFinite(km) || km <= 0) return 0;
  const t = Math.log1p(km / 1000) / LOG_MAX;
  return Math.min(1, Math.max(0, t)) * RADAR_R;
}

/**
 * 나침반 방위각(deg, 0=북·+90=동 — globe-hop.bearingDeg와 동일 규약) + 거리(km) → 레이더 좌표.
 * 북쪽 고정이므로 화면 위(−y)가 북이다.
 */
export function radarPoint(bearing: number, km: number): { x: number; y: number } {
  const r = radarRadius(km);
  const rad = (bearing * Math.PI) / 180;
  return { x: CENTER + r * Math.sin(rad), y: CENTER - r * Math.cos(rad) };
}

/** 금 링 등급별 블립 반경 — 가치 순(NEAR 400 < MID 700 < FAR 1,200, §3.5)으로 커진다. */
const GOLD_BLIP_R: Record<GoldRing, number> = { near: 2.4, mid: 3.1, far: 3.9 };

interface RadarModel {
  player: CountryId | null;
  gold: readonly { at: CountryId; ring: GoldRing }[];
  police: readonly PoliceView[];
  carried: number;
}

const EMPTY_MODEL: RadarModel = { player: null, gold: [], police: [], carried: 0 };

/** 마운트 시점 스냅샷(카운트다운 중이면 simState 미생성이라 player=null — 첫 candidatesShown이 채운다). */
function initialModel(engine: ChaseSessionEngine): RadarModel {
  const snap = engine.getSnapshot();
  return { ...EMPTY_MODEL, player: snap.player, carried: snap.carriedCount };
}

interface Blip {
  key: string;
  x: number;
  y: number;
  km: number;
}

export function ChaseRadar({ engine, graph, countries, homeId, reduced }: ChaseRadarProps) {
  const { t } = useTranslation();
  const [model, setModel] = useState<RadarModel>(() => initialModel(engine));
  const sweepRef = useRef<SVGGElement | null>(null);
  const sweepTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // reduced는 설정 변경으로 바뀔 수 있으나 구독을 재생성하지 않기 위해 ref로 읽는다.
  const reducedRef = useRef(reduced);
  reducedRef.current = reduced;

  /** CountryId → [경도, 위도]. globe-index.ts와 동일 변환(latlng[위도,경도] → d3 규약). */
  const anchors = useMemo(() => {
    const m = new Map<CountryId, LngLat>();
    for (const c of countries) m.set(c.id, [c.latlng[1], c.latlng[0]]);
    return m;
  }, [countries]);

  useEffect(() => {
    function playSweep(): void {
      const el = sweepRef.current;
      if (!el || reducedRef.current) return;
      el.classList.remove('is-sweeping');
      void el.getBoundingClientRect(); // 애니메이션 재생 강제(class 재적용만으로는 재시작 안 됨)
      el.classList.add('is-sweeping');
      if (sweepTimerRef.current) clearTimeout(sweepTimerRef.current);
      sweepTimerRef.current = setTimeout(() => {
        el.classList.remove('is-sweeping');
        sweepTimerRef.current = null;
      }, RADAR_SWEEP_MS);
    }

    const unsub = engine.subscribe((e) => {
      switch (e.type) {
        case 'hopCommitted':
          setModel((m) => ({ ...m, player: e.to }));
          break;
        case 'candidatesShown': {
          // 홉 직후 심이 전진된 뒤 방출되므로 스냅샷이 항상 신선하다(현재국·소지 수 동기화 지점).
          const snap = engine.getSnapshot();
          setModel((m) => ({ ...m, player: snap.player, carried: snap.carriedCount }));
          break;
        }
        case 'policeUpdated':
          setModel((m) => ({ ...m, police: e.units }));
          break;
        case 'goldSpawned':
          setModel((m) => ({
            ...m,
            gold: [...m.gold.filter((g) => g.at !== e.at), { at: e.at, ring: e.ring }],
          }));
          break;
        case 'goldPicked':
          setModel((m) => ({
            ...m,
            gold: m.gold.filter((g) => g.at !== e.at),
            carried: engine.getSnapshot().carriedCount,
          }));
          break;
        case 'delivered':
          setModel((m) => ({ ...m, carried: engine.getSnapshot().carriedCount }));
          break;
        case 'wantedChanged':
          if (e.direction === 'up') playSweep();
          break;
        default:
          break;
      }
    });
    return () => {
      unsub();
      if (sweepTimerRef.current) {
        clearTimeout(sweepTimerRef.current);
        sweepTimerRef.current = null;
      }
    };
  }, [engine]);

  const view = useMemo(() => {
    const from = model.player ? anchors.get(model.player) : undefined;
    const known = (id: CountryId): boolean => graph.has(id) && anchors.has(id);
    const place = (id: CountryId): Blip | null => {
      if (!from || !model.player || !known(id) || !graph.has(model.player)) return null;
      const to = anchors.get(id);
      if (!to) return null;
      const km = graph.dist(model.player, id);
      const p = radarPoint(bearingDeg(from, to), km);
      return { key: id, x: p.x, y: p.y, km };
    };

    const gold = model.gold
      .map((g) => {
        const b = place(g.at);
        return b ? { ...b, ring: g.ring } : null;
      })
      .filter((b): b is Blip & { ring: GoldRing } => b !== null);

    const police = model.police
      .map((u) => {
        const b = place(u.at);
        return b ? { ...b, key: `p${u.id}`, kind: u.kind } : null;
      })
      .filter((b): b is Blip & { kind: PoliceView['kind'] } => b !== null);

    const home = model.player === homeId ? null : place(homeId);
    const homeKm = home ? home.km : 0;
    return { gold, police, home, homeKm };
  }, [model, anchors, graph, homeId]);

  const summary = t('chase.radar.summary', {
    gold: view.gold.length,
    police: view.police.length,
    km: view.homeKm,
  });

  return (
    <div
      className="wt-chase-radar"
      data-testid="chase-radar"
      data-delivering={model.carried > 0 ? 'true' : 'false'}
    >
      <svg
        viewBox={`0 0 ${RADAR_SIZE} ${RADAR_SIZE}`}
        role="img"
        aria-label={summary}
        data-testid="chase-radar-svg"
      >
        <g className="wt-chase-radar__grid" aria-hidden="true">
          <circle className="wt-chase-radar__dish" cx={CENTER} cy={CENTER} r={RADAR_R} />
          <circle className="wt-chase-radar__ring" cx={CENTER} cy={CENTER} r={RADAR_R * 0.66} />
          <circle className="wt-chase-radar__ring" cx={CENTER} cy={CENTER} r={RADAR_R * 0.33} />
          <line
            className="wt-chase-radar__cross"
            x1={CENTER}
            y1={CENTER - RADAR_R}
            x2={CENTER}
            y2={CENTER + RADAR_R}
          />
          <line
            className="wt-chase-radar__cross"
            x1={CENTER - RADAR_R}
            y1={CENTER}
            x2={CENTER + RADAR_R}
            y2={CENTER}
          />
          {/* 북쪽 고정 표식 — 문자 'N'은 방위 기호(국제 통용)라 i18n 대상이 아니다. */}
          <text className="wt-chase-radar__north" x={CENTER} y={CENTER - RADAR_R - 2} textAnchor="middle">
            N
          </text>
        </g>

        {/* ★상승 스윕(§11-D111 ②-b와 동기, 600ms 1회전) — 회전은 CSS. */}
        <g ref={sweepRef} className="wt-chase-radar__sweep" data-testid="chase-radar-sweep" aria-hidden="true">
          <path d={`M${CENTER} ${CENTER} L${CENTER} ${CENTER - RADAR_R} A${RADAR_R} ${RADAR_R} 0 0 1 ${
            CENTER + RADAR_R * Math.sin((42 * Math.PI) / 180)
          } ${CENTER - RADAR_R * Math.cos((42 * Math.PI) / 180)} Z`} />
        </g>

        <g className="wt-chase-radar__blips" aria-hidden="true">
          {view.home && (
            <g
              className="wt-chase-radar__home"
              data-radar-blip="home"
              data-country={homeId}
              transform={`translate(${view.home.x.toFixed(2)} ${view.home.y.toFixed(2)})`}
            >
              {/* 하우스 글리프(지붕+몸통) — 홈만 도트가 아니라 형태로 구분한다. */}
              <path d="M-3.6 0.4 L0 -3.4 L3.6 0.4 L3.6 3.6 L-3.6 3.6 Z" />
            </g>
          )}
          {view.gold.map((g) => (
            <circle
              key={g.key}
              className="wt-chase-radar__gold"
              data-radar-blip="gold"
              data-country={g.key}
              data-gold-ring={g.ring}
              cx={g.x.toFixed(2)}
              cy={g.y.toFixed(2)}
              r={GOLD_BLIP_R[g.ring]}
            />
          ))}
          {view.police.map((p) => (
            <g
              key={p.key}
              className="wt-chase-radar__police"
              data-radar-blip="police"
              data-police-kind={p.kind}
              data-near={p.km <= RADAR_ALERT_KM ? 'true' : 'false'}
              transform={`translate(${p.x.toFixed(2)} ${p.y.toFixed(2)})`}
            >
              {/* 종류별 실루엣(지구본 배지 r8.5는 이 크기에서 뭉개져 재사용 불가 — 최소 3형태로
                  대체): 추격조=원 / 차단조=방패형 사각 / 헬기=삼각. */}
              {p.kind === 'chaser' && <circle r={3} />}
              {p.kind === 'interceptor' && <rect x={-2.8} y={-2.8} width={5.6} height={5.6} rx={1.2} />}
              {p.kind === 'heli' && <path d="M0 -3.6 L3.4 2.6 L-3.4 2.6 Z" />}
            </g>
          ))}
          {/* 플레이어(중심) — 항상 마지막(최상단). */}
          <circle className="wt-chase-radar__player" data-radar-blip="player" cx={CENTER} cy={CENTER} r={2.6} />
        </g>
      </svg>
    </div>
  );
}
