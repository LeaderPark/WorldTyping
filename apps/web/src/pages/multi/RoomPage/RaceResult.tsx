// spec: docs/01 §8.2(RES "전체 결과: 순위/PI/리플레이 바" · "리매치 투표: 30초 카운트다운, 과반
//       동의 시 새 시드로 같은 멤버 재경기"), docs/03 §6.4(latencyMs 뱃지 <80 초록/<150 노랑/≥150
//       빨강)·§6.6(서버 권위 원칙 — 순위·시간·CPM/ACC/PI는 전부 results가 유일한 진실), WT-M4-04
//
// 이 화면의 모든 수치는 S2C_Results(store.raceResult)에서만 읽는다 — 레이스 중 로컬로 표시했던
// 어떤 값도 여기서 재사용하지 않는다(§6.6, 구현 세부 지시 2).
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { S2C_RematchState } from '@wt/shared';
import type { ServerRaceResult } from '../../../stores/multiplayer';
import type { useMultiplayer } from '../../../features/multiplayer/useMultiplayer';
import { useSettingsStore } from '../../../stores/settings';

export interface RaceResultProps {
  raceResult: ServerRaceResult;
  rematchState: S2C_RematchState | null;
  myPlayerId: string | null;
  latencyMs: number;
  mp: ReturnType<typeof useMultiplayer>;
  /** 나가기(mp.leave() + /multi 리다이렉트는 RoomPage가 소유 — 라우팅 관심사 분리). */
  onLeave: () => void;
}

function latencyTier(ms: number): 'good' | 'ok' | 'bad' {
  if (ms < 80) return 'good';
  if (ms < 150) return 'ok';
  return 'bad';
}

/** WT-DC-05(④): 포토피니시 발동 임계 — 상위 2인 완주 시각 차가 이 값 미만이면 슬로모 리플레이(디자인
 *  정본 raceResults()). */
const PHOTO_FINISH_GAP_MS = 1000;
/** WT-DC-05(④): 축포 정리 시각(디자인 정본 launchConfetti setTimeout 3600ms) + 조각 수. */
const CONFETTI_CLEANUP_MS = 3600;
const CONFETTI_PIECES = 80;
/** 축포 색은 tokens 변수만(CLAUDE.md) — 디자인 정본 8색이 대륙/등급 토큰과 1:1로 대응한다
 *  (asia=#e5484d, europe=#3b82f6, africa=#f97316, north-america=#22c55e, south-america=#eab308,
 *  oceania=#06b6d4, grade-a=#a855f7, grade-s=#fbbf24). */
const CONFETTI_COLORS = [
  'var(--continent-asia)',
  'var(--continent-europe)',
  'var(--continent-africa)',
  'var(--continent-north-america)',
  'var(--continent-south-america)',
  'var(--continent-oceania)',
  'var(--grade-a)',
  'var(--grade-s)',
] as const;

export function RaceResult({ raceResult, rematchState, myPlayerId, latencyMs, mp, onLeave }: RaceResultProps) {
  const { t } = useTranslation();
  const deadline = rematchState?.deadline ?? raceResult.rematchDeadline;
  const [secondsLeft, setSecondsLeft] = useState(() => Math.max(0, Math.ceil((deadline - Date.now()) / 1000)));

  useEffect(() => {
    setSecondsLeft(Math.max(0, Math.ceil((deadline - Date.now()) / 1000)));
    const id = setInterval(() => {
      setSecondsLeft(Math.max(0, Math.ceil((deadline - Date.now()) / 1000)));
    }, 250);
    return () => clearInterval(id);
  }, [deadline]);

  const myVote = rematchState?.votes.find((v) => v.playerId === myPlayerId)?.vote ?? null;
  const yesCount = rematchState?.votes.filter((v) => v.vote === true).length ?? 0;

  // WT-DC-05(④): reduced-motion(§7.3) — GamePage와 동일 판정. 연출(착륙 활주로/포토피니시/축포)은
  // reduced에서 전부 건너뛴다(값 표시는 순위표가 담당하므로 정보 손실 없음).
  const reducedMotion = useSettingsStore((s) => s.reducedMotion);
  const reducedActive =
    reducedMotion === 'auto'
      ? typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
      : reducedMotion;
  const juice = !reducedActive;

  // WT-DC-05(④): 순위 pill·포토피니시·축포는 전부 서버 results(§6.6)에서만 도출한다 — 레이스 중
  // 로컬 표시값 미사용. 순위표 rows는 서버가 순위순으로 보낸다.
  const myRow = raceResult.rows.find((r) => r.playerId === myPlayerId) ?? null;
  const finishRankMsg = myRow
    ? myRow.finished
      ? t('race.result.rankMsg', { rank: myRow.rank })
      : t('race.result.notFinishedMsg')
    : null;
  const finishTimes = raceResult.rows
    .filter((r) => r.finished && r.elapsedMs !== null)
    .map((r) => r.elapsedMs as number) // elapsedMs는 위 filter로 non-null 보장(멀티 결과는 서버 값)
    .sort((a, b) => a - b);
  const [t0, t1] = finishTimes;
  const photoFinish = t0 !== undefined && t1 !== undefined && Math.abs(t0 - t1) < PHOTO_FINISH_GAP_MS;
  const pfRivalNick = raceResult.rows.find((r) => r.playerId !== myPlayerId)?.nickname ?? '';
  const confettiOn = myRow?.finished === true && myRow.rank === 1;

  // WT-DC-05(④): 결과 등장 연출(디자인 정본 raceResults()). 착륙 활주로 ✈(WAAPI 1600ms), 포토피니시
  // 두 ✈ 슬로모(3000ms linear), 축포 80조각(내 1위 완주 시). 전부 transform만·WAAPI(핫패스 규약과
  // 동일 취지), reduced-motion(juice=false)에선 생성/재생을 건너뛴다. raceResult가 바뀔 때(리매치
  // 결과 등) 재생하고, 언마운트/재생 시 이전 축포 타이머를 정리한다.
  const landingPlaneRef = useRef<HTMLSpanElement | null>(null);
  const pfMeRef = useRef<HTMLSpanElement | null>(null);
  const pfRivalRef = useRef<HTMLSpanElement | null>(null);
  const confettiRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!juice) return undefined;
    const plane = landingPlaneRef.current;
    if (plane && typeof plane.animate === 'function') {
      plane.animate(
        [
          { transform: 'translate(0px, -6px) rotate(6deg)', offset: 0 },
          { transform: 'translate(260px, 12px) rotate(10deg)', offset: 0.62 },
          { transform: 'translate(330px, 16px) rotate(0deg)', offset: 0.8 },
          { transform: 'translate(420px, 16px) rotate(0deg)', offset: 1 },
        ],
        { duration: 1600, easing: 'ease-out', fill: 'forwards' },
      );
    }
    if (photoFinish) {
      const me = pfMeRef.current;
      const rival = pfRivalRef.current;
      const w = 420;
      if (me && typeof me.animate === 'function') {
        me.animate([{ transform: 'translateX(0)' }, { transform: `translateX(${w}px)` }], {
          duration: 3000,
          easing: 'linear',
          fill: 'forwards',
        });
      }
      if (rival && typeof rival.animate === 'function') {
        rival.animate([{ transform: 'translateX(-24px)' }, { transform: `translateX(${w - 14}px)` }], {
          duration: 3000,
          easing: 'linear',
          fill: 'forwards',
        });
      }
    }
    let cleanupTimer: ReturnType<typeof setTimeout> | null = null;
    const el = confettiRef.current;
    if (confettiOn && el) {
      el.textContent = '';
      for (let i = 0; i < CONFETTI_PIECES; i++) {
        const piece = document.createElement('span');
        const sz = 6 + Math.random() * 6;
        piece.className = 'wt-confetti';
        piece.style.position = 'absolute';
        piece.style.top = '-20px';
        piece.style.left = `${Math.random() * 100}%`;
        piece.style.width = `${sz}px`;
        piece.style.height = `${sz * 0.5}px`;
        piece.style.borderRadius = '1px';
        piece.style.background = CONFETTI_COLORS[i % CONFETTI_COLORS.length] ?? CONFETTI_COLORS[0];
        piece.style.setProperty('--dx', `${(Math.random() - 0.5) * 160}px`);
        piece.style.setProperty('--rot', `${360 + Math.random() * 720}deg`);
        piece.style.animation = `wt-confetti ${(1.4 + Math.random() * 1.4).toFixed(2)}s ease-in ${(
          Math.random() * 0.5
        ).toFixed(2)}s forwards`;
        el.appendChild(piece);
      }
      cleanupTimer = setTimeout(() => {
        if (confettiRef.current) confettiRef.current.textContent = '';
      }, CONFETTI_CLEANUP_MS);
    }
    return () => {
      if (cleanupTimer) clearTimeout(cleanupTimer);
      if (confettiRef.current) confettiRef.current.textContent = '';
    };
  }, [raceResult, juice, photoFinish, confettiOn]);

  return (
    <div className="wt-race-result" data-testid="race-result">
      {/* WT-DC-05(④): 축포 레이어(내 1위 완주 시에만 조각 생성). 뷰포트 고정·pointer-events:none. */}
      <div ref={confettiRef} className="wt-race-result__confetti" data-testid="race-result-confetti" aria-hidden="true" />
      <h2 className="wt-race-result__title">{t('race.result.title')}</h2>
      <span className={`wt-race-result__latency wt-race-result__latency--${latencyTier(latencyMs)}`} data-testid="race-result-latency">
        {t('multi.latency.label', { ms: latencyMs })}
      </span>

      {/* WT-DC-05(④): 순위 pill(amber, slideUp 420ms) — 완주=rankMsg / 미완주=notFinishedMsg. */}
      {finishRankMsg && (
        <p className="wt-race-result__rank-pill" data-testid="race-result-rank-msg">
          {finishRankMsg}
        </p>
      )}

      {/* WT-DC-05(④): 착륙 활주로 카드(520×62, ✈ WAAPI 1600ms) — 순수 장식(디자인 정본 L493~497). */}
      <div className="wt-race-result__runway" aria-hidden="true">
        <span className="wt-race-result__runway-line" />
        <span className="wt-race-result__runway-pad" />
        <span ref={landingPlaneRef} className="wt-race-result__runway-plane">
          ✈
        </span>
      </div>

      {/* WT-DC-05(④): 포토피니시 슬로모 리플레이(상위 2인 <1000ms 차, 디자인 정본 L498~507). */}
      {photoFinish && (
        <div className="wt-race-result__photo" data-testid="race-result-photo">
          <span className="wt-race-result__photo-label">{t('race.photoFinish.label')}</span>
          <div className="wt-race-result__photo-track">
            <span className="wt-race-result__photo-line" aria-hidden="true" />
            <span ref={pfMeRef} className="wt-race-result__photo-me">
              ✈ <span className="wt-race-result__photo-tag">{t('race.photoFinish.me')}</span>
            </span>
            <span ref={pfRivalRef} className="wt-race-result__photo-rival">
              ✈ <span className="wt-race-result__photo-tag">{pfRivalNick}</span>
            </span>
          </div>
        </div>
      )}

      <table className="wt-rank-table" data-testid="race-result-table">
        <thead>
          <tr>
            <th>{t('rank.col.rank')}</th>
            <th>{t('rank.col.nickname')}</th>
            <th>{t('rank.col.time')}</th>
            <th>{t('hud.cpm', { cpm: '' })}</th>
            <th>{t('rank.col.accuracy')}</th>
            <th>{t('rank.col.pi')}</th>
          </tr>
        </thead>
        <tbody>
          {raceResult.rows.map((row) => (
            <tr
              key={row.playerId}
              data-testid={`race-result-row-${row.playerId}`}
              className={row.playerId === myPlayerId ? 'wt-race-result__row--me' : undefined}
            >
              <td>{row.rank}</td>
              <td>
                {row.nickname}
                {row.isBot && ` · ${t('room.player.bot')}`}
              </td>
              <td>
                {row.disconnected
                  ? t('race.result.disconnected')
                  : row.finished && row.elapsedMs !== null
                    ? `${(row.elapsedMs / 1000).toFixed(1)}s`
                    : t('race.result.notFinished')}
              </td>
              <td>{row.cpm}</td>
              <td>{row.acc.toFixed(1)}%</td>
              <td>{row.pi}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="wt-lobby__row wt-race-result__rematch" data-testid="race-result-rematch">
        <p className="wt-race-result__rematch-countdown">{t('race.rematch.countdown', { seconds: secondsLeft })}</p>
        <button
          type="button"
          className={`wt-pill${myVote === true ? ' wt-pill--active' : ''}`}
          data-testid="race-result-vote-yes"
          onClick={() => mp.rematch(true)}
        >
          {t('race.rematch.voteYes')}
        </button>
        <button
          type="button"
          className={`wt-pill${myVote === false ? ' wt-pill--active' : ''}`}
          data-testid="race-result-vote-no"
          onClick={() => mp.rematch(false)}
        >
          {t('race.rematch.voteNo')}
        </button>
        <span data-testid="race-result-vote-count">{yesCount}</span>
        {myVote !== null && <span className="wt-race-result__rematch-waiting">{t('race.rematch.waiting')}</span>}
      </div>

      <button type="button" className="wt-btn" data-testid="race-result-leave" onClick={onLeave}>
        {t('room.leave')}
      </button>
    </div>
  );
}
