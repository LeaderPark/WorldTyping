// spec: docs/09-chase-mode-goldrunner.md §7.4(수배 별 HUD)·§8.3(슬림 HUD 40px·시선 동선)·
//       §8.6(해부도)·§8.10(a11y), docs/09a §4, docs/00 §11-D90~D97, WT-CH-06.
//
// 상단 슬림 HUD(h 40px, 모바일 36px) — 별 5칸+게이지 중앙, 점수/금 가방 좌, 시간/CPM/ACC 우.
// 고빈도 값(경과시간·CPM·ACC)은 statsTick(500ms 스로틀) 구독 → textContent 직접 갱신(§4.5,
// CpmDial.tsx/GameAppBar.tsx와 동일 패턴 — React state 미경유). 별 5노드는 마운트 시 고정 생성 후
// 클래스 토글만(리플로우 방지, §8.6 "노드 추가/삭제 금지").
//
// [점수 표시 — 설계 근사치, 최종 보고 기재] ChaseSnapshot은 finished 이전엔 라이브 FinalScore를
// 노출하지 않는다(computeChaseScore는 종료 스냅샷 전용, packages/shared/src/chase/score.ts). 이
// 컴포넌트가 재구현하면 Gotcha 3(점수 재구현 금지) 위반이라, 인게임 중 "점수" 칸은 심이 이미 계산해
// 이벤트에 실어 보내는 값만 누적한 "배송 정산 누적액"(GoldScore 근사 — delivered.payout 합)을
// 표시한다. 완전한 라이브 FinalScore(타이핑/생존 항 포함)가 필요하면 CH-07의 점수 롤업 연출(§7.6)이
// 정밀 값으로 대체할 수 있도록 data-testid="chase-hud-score" 노드를 안정 앵커로 남겨둔다.
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { ChaseSessionEngine } from '@wt/engine';
import { formatCpm, formatMMSS, formatPercent } from '../../lib/format';

export interface WantedHudProps {
  engine: ChaseSessionEngine;
}

const MAX_STARS = 5;
/** §7.4 "45초 주기" 게이지 근사치 — 실 상수(ChaseConstants, KV config:chase 핫스왑 대상)는 engine
 *  내부 소유라 이 표시 계층에 노출되지 않는다(재구현 금지 원칙). 장식용 근사이며 게임플레이에
 *  영향 없음 — 정밀화는 CH-07/CH-11 소관(최종 보고 기재). */
const WANTED_GAUGE_MS = 45_000;

export function WantedHud({ engine }: WantedHudProps) {
  const { t } = useTranslation();
  const starRefs = useRef<Array<HTMLSpanElement | null>>([]);
  const gaugeRef = useRef<HTMLDivElement | null>(null);
  const scoreRef = useRef<HTMLSpanElement | null>(null);
  const goldRef = useRef<HTMLSpanElement | null>(null);
  const timeRef = useRef<HTMLSpanElement | null>(null);
  const cpmRef = useRef<HTMLSpanElement | null>(null);
  const accRef = useRef<HTMLSpanElement | null>(null);
  const starsRowRef = useRef<HTMLDivElement | null>(null);
  const announceRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let stars = 0;
    let policeCount = 0;
    let bounty = 0;
    let gaugeStartedAt = performance.now();

    const paintStars = (): void => {
      for (let i = 0; i < MAX_STARS; i++) {
        const el = starRefs.current[i];
        if (!el) continue;
        el.classList.toggle('is-lit', i < stars);
      }
      const row = starsRowRef.current;
      if (row) row.setAttribute('aria-label', t('chase.hud.wanted', { stars, count: policeCount }));
    };
    const paintGauge = (): void => {
      const el = gaugeRef.current;
      if (!el) return;
      const elapsed = performance.now() - gaugeStartedAt;
      const ratio = Math.min(1, elapsed / WANTED_GAUGE_MS);
      el.style.setProperty('--wt-wanted-gauge', String(ratio));
      el.classList.toggle('is-low', ratio >= 0.8);
    };
    const announce = (msg: string): void => {
      if (announceRef.current) announceRef.current.textContent = msg;
    };
    const paintGold = (): void => {
      const carried = engine.getSnapshot().carriedCount;
      if (goldRef.current) {
        goldRef.current.textContent = `💰×${carried}`;
        goldRef.current.setAttribute('aria-label', t('chase.hud.goldBag', { count: carried }));
      }
    };
    const paintScore = (): void => {
      if (scoreRef.current) scoreRef.current.textContent = String(Math.round(bounty));
    };

    paintStars();
    paintGauge();
    paintGold();
    paintScore();
    let gaugeTimer: ReturnType<typeof setInterval> | null = setInterval(paintGauge, 250);

    const unsub = engine.subscribe((e) => {
      switch (e.type) {
        case 'statsTick': {
          if (timeRef.current) timeRef.current.textContent = formatMMSS(e.elapsedMs);
          if (cpmRef.current) cpmRef.current.textContent = String(formatCpm(e.cpm));
          if (accRef.current) accRef.current.textContent = `${formatPercent(e.acc)}%`;
          break;
        }
        case 'wantedChanged': {
          stars = e.stars;
          gaugeStartedAt = performance.now();
          paintStars();
          paintGauge();
          announce(t(e.direction === 'up' ? 'chase.event.wantedUp' : 'chase.event.wantedDown', { stars }));
          break;
        }
        case 'policeUpdated': {
          policeCount = e.units.length;
          paintStars();
          break;
        }
        case 'goldPicked': {
          paintGold();
          break;
        }
        case 'delivered': {
          bounty += e.payout;
          paintScore();
          paintGold();
          announce(t('chase.event.delivery', { payout: e.payout }));
          break;
        }
        default:
          break;
      }
    });

    return () => {
      unsub();
      if (gaugeTimer) {
        clearInterval(gaugeTimer);
        gaugeTimer = null;
      }
    };
  }, [engine, t]);

  return (
    <div className="wt-wanted-hud" data-testid="chase-wanted-hud">
      <div className="wt-wanted-hud__left">
        <span ref={scoreRef} className="wt-wanted-hud__score" data-testid="chase-hud-score">
          0
        </span>
        <span ref={goldRef} className="wt-wanted-hud__gold" data-testid="chase-hud-gold">
          💰×0
        </span>
      </div>

      <div className="wt-wanted-hud__center">
        <div ref={starsRowRef} className="wt-wanted-hud__stars" role="img" data-testid="chase-hud-stars">
          {Array.from({ length: MAX_STARS }, (_, i) => (
            <span
              key={i}
              ref={(el) => {
                starRefs.current[i] = el;
              }}
              className="wt-wanted-hud__star"
              aria-hidden="true"
            >
              ★
            </span>
          ))}
        </div>
        <div ref={gaugeRef} className="wt-wanted-hud__gauge" aria-hidden="true" data-testid="chase-hud-gauge">
          <div className="wt-wanted-hud__gauge-fill" />
        </div>
      </div>

      <div className="wt-wanted-hud__right">
        <span ref={timeRef} className="wt-wanted-hud__time" data-testid="chase-hud-time">
          0:00
        </span>
        <span ref={cpmRef} className="wt-wanted-hud__cpm" data-testid="chase-hud-cpm">
          0
        </span>
        <span ref={accRef} className="wt-wanted-hud__acc" data-testid="chase-hud-acc">
          100%
        </span>
      </div>

      {/* §8.10: 수배 변경/배송 병행 공지(스크린리더 게임 상태 추적). */}
      <div ref={announceRef} aria-live="polite" className="sr-only" data-testid="chase-hud-announcer" />
    </div>
  );
}
