// spec: docs/01 §8.2(RES "전체 결과: 순위/PI/리플레이 바" · "리매치 투표: 30초 카운트다운, 과반
//       동의 시 새 시드로 같은 멤버 재경기"), docs/03 §6.4(latencyMs 뱃지 <80 초록/<150 노랑/≥150
//       빨강)·§6.6(서버 권위 원칙 — 순위·시간·CPM/ACC/PI는 전부 results가 유일한 진실), WT-M4-04
//
// 이 화면의 모든 수치는 S2C_Results(store.raceResult)에서만 읽는다 — 레이스 중 로컬로 표시했던
// 어떤 값도 여기서 재사용하지 않는다(§6.6, 구현 세부 지시 2).
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { S2C_RematchState } from '@wt/shared';
import type { ServerRaceResult } from '../../../stores/multiplayer';
import type { useMultiplayer } from '../../../features/multiplayer/useMultiplayer';

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

  return (
    <div className="wt-race-result" data-testid="race-result">
      <h2>{t('race.result.title')}</h2>
      <span className={`wt-race-result__latency wt-race-result__latency--${latencyTier(latencyMs)}`} data-testid="race-result-latency">
        {t('multi.latency.label', { ms: latencyMs })}
      </span>

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

      <div className="wt-lobby__row" data-testid="race-result-rematch">
        <p>{t('race.rematch.countdown', { seconds: secondsLeft })}</p>
        <button
          type="button"
          className={`wt-btn${myVote === true ? ' wt-btn--active' : ''}`}
          data-testid="race-result-vote-yes"
          onClick={() => mp.rematch(true)}
        >
          {t('race.rematch.voteYes')}
        </button>
        <button
          type="button"
          className={`wt-btn${myVote === false ? ' wt-btn--active' : ''}`}
          data-testid="race-result-vote-no"
          onClick={() => mp.rematch(false)}
        >
          {t('race.rematch.voteNo')}
        </button>
        <span data-testid="race-result-vote-count">{yesCount}</span>
        {myVote !== null && <span>{t('race.rematch.waiting')}</span>}
      </div>

      <button type="button" className="wt-btn" data-testid="race-result-leave" onClick={onLeave}>
        {t('room.leave')}
      </button>
    </div>
  );
}
