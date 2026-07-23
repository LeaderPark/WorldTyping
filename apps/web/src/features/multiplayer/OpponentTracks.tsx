// spec: docs/01 §8.2("실시간 상대 진행바… 250ms 간격 서버 브로드캐스트… 왕관… 오타로 멈추면
//       0.5초 흔들림"), docs/03 §6.5(OpponentTracks — 트랙별 개별 셀렉터 구독, Map 참조 동일성
//       유지 → 불필요한 리렌더 0), docs/05 §8-2(idx+ksPct/100 목표값, 지수 스무딩 계수 0.25/frame,
//       60fps 기준 · combo 0 리셋 tick에서 0.5s 셰이크), WT-M4-04
//
// 트랙 하나(OpponentTrack)는 자기 playerId 엔트리만 `useMultiplayerStore(s => s.opponents.get(id))`
// 로 구독한다 — 스토어(§6.5 주석)가 변경되지 않은 엔트리의 참조 동일성을 보존하므로, 다른
// 플레이어의 tick 갱신은 이 컴포넌트를 리렌더하지 않는다(OpponentTracks.test.tsx가 Profiler로
// 검증). 진행바 위치 자체(부드러운 이동)는 React state가 아니라 rAF로 DOM에 직접 쓴다(§4.5와
// 동일한 취지 — 매 프레임 값을 굳이 재조정 리렌더에 태우지 않는다).
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMultiplayerStore, type RoomPlayer } from '../../stores/multiplayer';

/** §5 §8-2: 60fps 기준 계수 0.25/frame 지수 스무딩. */
const SMOOTHING_FACTOR = 0.25;
/** 오타로 콤보가 0으로 리셋된 tick에서 0.5초 흔들림(GDD §8.2). */
const MISS_SHAKE_MS = 500;

export interface OpponentTracksProps {
  /** 나를 제외한 방 플레이어 목록(호출부가 필터링해 전달 — 이 컴포넌트는 room 스토어를 모른다). */
  players: readonly RoomPlayer[];
  /** 세트 총 국가 수(진행률 계산 분모). */
  total: number;
}

export function OpponentTracks({ players, total }: OpponentTracksProps) {
  const { t } = useTranslation();
  if (players.length === 0) return null;
  return (
    <div className="wt-opponent-tracks" data-testid="opponent-tracks" aria-label={t('race.opponents.title')}>
      {players.map((p) => (
        <OpponentTrack key={p.playerId} player={p} total={total} />
      ))}
    </div>
  );
}

function OpponentTrack({ player, total }: { player: RoomPlayer; total: number }) {
  const { t } = useTranslation();
  // 자기 엔트리만 구독(§6.5) — 왕관은 "현재 선두 추정"이 아니라 "완주 1위 확정"(rank===1)으로
  // 한정한다. 실시간 선두 비교는 다른 트랙의 진행도까지 알아야 해 트랙 간 참조 결합이 생기고,
  // 그러면 어떤 트랙이든 리드가 바뀔 때마다 서로를 리렌더시켜 이 컴포넌트의 핵심 계약(트랙별
  // 개별 구독 — 다른 플레이어 tick이 남의 트랙을 건드리지 않음)을 깨뜨린다.
  const progress = useMultiplayerStore((s) => s.opponents.get(player.playerId));
  const isLeader = progress?.rank === 1;

  const idx = progress?.idx ?? 0;
  const ksPct = progress?.ksPct ?? 0;
  const combo = progress?.combo ?? 0;
  const state = progress?.state ?? 'racing';
  const rank = progress?.rank ?? null;

  // 부드러운 이동(rAF + DOM 직접 갱신 — React state 미경유). 목표 = idx + ksPct/100.
  const fillRef = useRef<HTMLDivElement | null>(null);
  // 이동체 노브(WT-UI-08) — fill과 같은 rAF 틱에서 transform만 직접 쓴다(레이아웃 프로퍼티 미사용).
  // .wt-opponent-track__bar는 overflow:hidden이라(도착 지점에서 노브 절반이 잘림) 그 형제인 이
  // .track 래퍼 위에 절대배치로 얹는다. 트랙 폭(px)은 프레임마다 읽지 않고 마운트/리사이즈 시에만
  // 측정해 캐시한다 — 매 프레임 레이아웃 읽기(강제 리플로우) 없이 순수 transform 쓰기만 남긴다.
  const trackRef = useRef<HTMLDivElement | null>(null);
  const knobRef = useRef<HTMLDivElement | null>(null);
  const trackWidthRef = useRef(0);
  const posRef = useRef(idx);
  const targetRef = useRef(idx + ksPct / 100);
  useEffect(() => {
    targetRef.current = idx + ksPct / 100;
  }, [idx, ksPct]);
  useEffect(() => {
    const measure = () => {
      trackWidthRef.current = trackRef.current?.clientWidth ?? 0;
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, []);
  useEffect(() => {
    let raf: number;
    const tick = () => {
      posRef.current += (targetRef.current - posRef.current) * SMOOTHING_FACTOR;
      const pct = total > 0 ? Math.max(0, Math.min(100, (posRef.current / total) * 100)) : 0;
      const el = fillRef.current;
      if (el) el.style.width = `${pct}%`;
      const knob = knobRef.current;
      if (knob) {
        const x = (pct / 100) * trackWidthRef.current;
        knob.style.transform = `translate(${x}px, -50%)`;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [total]);

  // missFlash → 0.5초 흔들림 class(§8-2). 서버 tick은 순간 플래그라 로컬 타이머로 지속시킨다.
  const [shaking, setShaking] = useState(false);
  const shakeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!progress?.missFlash) return;
    setShaking(true);
    if (shakeTimer.current) clearTimeout(shakeTimer.current);
    shakeTimer.current = setTimeout(() => setShaking(false), MISS_SHAKE_MS);
    return () => {
      if (shakeTimer.current) clearTimeout(shakeTimer.current);
    };
  }, [progress?.missFlash]);

  const className = [
    'wt-opponent-track',
    shaking && 'wt-opponent-track--miss',
    (state === 'grace') && 'wt-opponent-track--grace',
    (state === 'left') && 'wt-opponent-track--left',
    (state === 'finished') && 'wt-opponent-track--finished',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={className} data-testid={`opponent-track-${player.playerId}`}>
      <span className="wt-opponent-track__name" data-testid={`opponent-track-name-${player.playerId}`}>
        {isLeader && (
          <span className="wt-opponent-track__crown" aria-label={t('race.crown.leader')} title={t('race.crown.leader')}>
            👑
          </span>
        )}
        {player.nickname}
        {player.isBot && <span className="wt-opponent-track__bot-badge">{t('room.player.bot')}</span>}
      </span>
      <div ref={trackRef} className="wt-opponent-track__track" aria-hidden="true">
        <div className="wt-opponent-track__bar">
          <div ref={fillRef} className="wt-opponent-track__fill" />
        </div>
        <div ref={knobRef} className={`wt-opponent-track__knob${isLeader ? ' wt-opponent-track__knob--leader' : ''}`}>
          ✈
        </div>
      </div>
      <span className="wt-opponent-track__meta" data-testid={`opponent-track-meta-${player.playerId}`}>
        {t('game.progress', { current: Math.min(idx, total), total })}
        {combo > 0 && <span className="wt-opponent-track__combo">{t('hud.streak', { count: combo })}</span>}
        {rank !== null && <span className="wt-opponent-track__rank">{t('multi.rank.finish', { rank })}</span>}
        {state === 'left' && <span className="wt-opponent-track__state">{t('room.leave')}</span>}
      </span>
    </div>
  );
}
