// spec: docs/01 §10.2(S6 하단 보딩패스 스트립 — 이전역/현재/다음역), §13.3-2(확정 스탬프),
//       docs/03 §4.2(PromptArea = FlagIcon+PromptRenderer+게이지 슬롯)·§4.5(고빈도 값 규약)·
//       §7.1(모바일 --vv-height 앵커 하단 고정). WT-UI-03.
//
// 원작 METRO TYPING S6의 하단 전폭 보딩패스 스트립 이식. 배경은 현재 출제국의 대륙색(리드
// 오버라이드 — 티어/데일리 포함 전 모드 실시간)이고, 그 위에 흰 케이싱 바(r28)가 얹힌다:
//   [← ] [이전국] [ ── 흰 캡슐: FlagIcon + 프롬프트(자모 채색) + 반대언어 보조행 + 게이지 + 콤보 ── ] [다음국] [ →]
// 이전·다음국은 countries/currentIndex에서 도출한다(GameViewProps 확장 없음). 프롬프트 채색은
// prompt-renderer가 DOM을 직접 갱신하고(핫패스 React 미경유), 스트립 자체는 국가 전환 단위로만
// 리렌더한다(§4.5 허용 빈도). 확정 스탬프(juice #2)는 여기서 engine 이벤트를 구독해 트리거한다.
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { GameSessionEngine, TypingInputController } from '@wt/engine';
import type { Country, GameMode } from '@wt/shared';
import { PromptArea } from '../../features/typing/PromptArea';
import { TimeLimitGauge } from '../../features/hud/TimeLimitGauge';
import { ComboBadge } from '../../features/hud/ComboBadge';
import { FlagIcon } from '../../components/FlagIcon';

/** juice #2 스탬프 팝 지속(ms) — GameView가 쓰던 값과 동일(§13.3-2). */
const STAMP_MS = 480;
/** WT-DC-04(③): 환승 칩 유지(ms, 디자인 showCountry transferTimer 2000ms). */
const TRANSFER_CHIP_MS = 2000;

export interface BoardingStripProps {
  engine: GameSessionEngine;
  controller: TypingInputController | null;
  getInputValue(): string;
  countries: readonly Country[];
  currentIndex: number;
  lang: 'ko' | 'en';
  /** WT-DC-04(③): 환승 칩은 세계일주에서만(대륙 변경 감지). 나머지 모드는 칩 없음. */
  mode: GameMode;
  /** 국가당 제한시간 게이지 표시 여부(GameView의 showGauge 조건 그대로 위임). */
  showGauge: boolean;
  bindGaugeEl: (el: HTMLElement | null) => void;
  juice?: boolean;
}

export function BoardingStrip({
  engine,
  controller,
  getInputValue,
  countries,
  currentIndex,
  lang,
  mode,
  showGauge,
  bindGaugeEl,
  juice = true,
}: BoardingStripProps) {
  const { t } = useTranslation();
  const stampRef = useRef<HTMLDivElement | null>(null);
  const stampTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const transferRef = useRef<HTMLSpanElement | null>(null);
  const transferTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // juice #2: 국가 확정(스킵 제외) 시 캡슐 위에 스탬프가 15° 기울어져 찍힌다(§13.3-2). 스트립이
  // 국가 전환마다 리렌더돼도 이 구독은 [engine, juice] 안정 deps라 재구독하지 않는다.
  useEffect(() => {
    if (!juice) return;
    const unsub = engine.subscribe((e) => {
      if (e.type !== 'countryCommitted' || e.skipped) return;
      const el = stampRef.current;
      if (!el) return;
      el.classList.remove('wt-stamp--active');
      void el.offsetWidth; // 애니메이션 재시작(읽기 1회 — 레이아웃 write 아님)
      el.classList.add('wt-stamp--active');
      if (stampTimer.current) clearTimeout(stampTimer.current);
      stampTimer.current = setTimeout(() => {
        el.classList.remove('wt-stamp--active');
        stampTimer.current = null;
      }, STAMP_MS);
    });
    return () => {
      unsub();
      if (stampTimer.current) clearTimeout(stampTimer.current);
    };
  }, [engine, juice]);

  // WT-DC-04(③): 세계일주 대륙 변경(환승) 시 캡슐 위에 다크 콘솔 칩을 240ms 입장 + 2000ms 유지 후
  // 감춘다(디자인 showCountry transferTimer). {line}은 새 대륙명(continent.<slug> — 별도 "선" 키가
  // 없어 현지화 대륙명을 그대로 넣는다). 순수 표시 — 판정/입력 무관, engine 구독은 [engine,mode] 안정.
  useEffect(() => {
    if (mode !== 'worldtour') return undefined;
    const unsub = engine.subscribe((e) => {
      if (e.type !== 'countryShown' || e.index <= 0) return;
      const prev = countries[e.index - 1];
      const cur = countries[e.index];
      if (!prev || !cur || prev.continent === cur.continent) return;
      const el = transferRef.current;
      if (!el) return;
      el.textContent = t('game.transfer.chip', { line: t(`continent.${cur.continent}`) });
      el.classList.remove('wt-strip__transfer--show');
      void el.offsetWidth; // 애니메이션 재시작(읽기 1회 — 레이아웃 write 아님)
      el.classList.add('wt-strip__transfer--show');
      if (transferTimer.current) clearTimeout(transferTimer.current);
      transferTimer.current = setTimeout(() => {
        el.classList.remove('wt-strip__transfer--show');
        transferTimer.current = null;
      }, TRANSFER_CHIP_MS);
    });
    return () => {
      unsub();
      if (transferTimer.current) clearTimeout(transferTimer.current);
    };
  }, [engine, mode, countries, t]);

  const current = countries[currentIndex];
  if (!current) return null;

  const prev = countries[currentIndex - 1];
  const next = countries[currentIndex + 1];
  // 반대 언어 보조행(원작 "청 을지로입구…" 밑 "City Hall"에 대응). 국가명은 countries.json 원천.
  const secondary = lang === 'ko' ? current.nameEn : current.nameKo;

  return (
    <div
      className="wt-strip"
      data-testid="boarding-strip"
      style={{ background: `var(--continent-${current.continent})` }}
    >
      <div className="wt-strip__bar">
        <span className="wt-strip__arrow" aria-hidden="true">
          ←
        </span>

        <NeighborSlot country={prev} position={currentIndex} side="prev" lang={lang} label={t('strip.prev')} />

        <div className="wt-strip__capsule" data-testid="game-stamp-anchor">
          <PromptArea
            country={current}
            lang={lang}
            controller={controller}
            getInputValue={getInputValue}
            juiceLevel={juice ? 2 : 0}
          >
            {showGauge && <TimeLimitGauge bindGaugeEl={bindGaugeEl} />}
          </PromptArea>
          {secondary && (
            <span className="wt-strip__secondary" aria-hidden="true">
              {secondary}
            </span>
          )}
          <ComboBadge engine={engine} juice={juice} />
          <div ref={stampRef} className="wt-stamp" aria-hidden="true" />
          {/* WT-DC-04(③): 환승 칩 — 세계일주 대륙 변경 시에만 위 effect가 --show 토글로 노출. */}
          {mode === 'worldtour' && (
            <span ref={transferRef} className="wt-strip__transfer" data-testid="transfer-chip" aria-hidden="true" />
          )}
        </div>

        <NeighborSlot country={next} position={currentIndex + 2} side="next" lang={lang} label={t('strip.next')} />

        <span className="wt-strip__arrow" aria-hidden="true">
          →
        </span>
      </div>
    </div>
  );
}

/** 이전/다음국 슬롯 — 순번 원 + FlagIcon + 국가명. 국가가 없으면(첫/마지막) 빈 자리로 폭을 유지해
 *  캡슐이 좌우로 튀지 않게 한다(리플로우 방지). */
function NeighborSlot({
  country,
  position,
  side,
  lang,
  label,
}: {
  country: Country | undefined;
  position: number;
  side: 'prev' | 'next';
  lang: 'ko' | 'en';
  label: string;
}) {
  if (!country) {
    return <div className={`wt-strip__neighbor wt-strip__neighbor--${side} wt-strip__neighbor--empty`} aria-hidden="true" />;
  }
  const name = lang === 'ko' ? country.nameKo : country.nameEn;
  return (
    <div className={`wt-strip__neighbor wt-strip__neighbor--${side}`} data-testid={`strip-${side}`}>
      <span className="wt-strip__neighbor-caption">{label}</span>
      <div className="wt-strip__neighbor-body">
        <span className="wt-strip__neighbor-num" aria-hidden="true">
          {position}
        </span>
        <FlagIcon id={country.id} emoji={country.flagEmoji} size="sm" />
        <span className="wt-strip__neighbor-name">{name}</span>
      </div>
    </div>
  );
}
