// spec: docs/01 §10.2(S7 결과 전문), §13.3-6(완주 리트레이스 → 결과 카드 슬라이드 인), docs/03
//       §4.2(ResultView, phase: finished), docs/06 §1.4-③(제출 응답 인라인 순위)·§3.1(verdict),
//       docs/00 §11-D9, WT-M2-06·WT-M3-06.
//
// [완주 리트레이스 — 구현 메모] §13.3-6은 "노선 전체가 지도 위에서 한 번에 리트레이스"를
// 요구한다. 이 구현에서 solved/route 레이어는 이미 플레이 중 진행분으로 누적 그려져 있으므로
// (GamePage의 countryCommitted 배선), finished 전이 시점에 카메라만 전체 노선 bounds로
// flyTo(1.2s)해 "완성된 노선을 한 번에 드러내는" 리트레이스 효과를 낸다(GamePage 담당) — 이
// 화면은 그 위에 카드가 슬라이드 인(CSS)하는 것만 담당한다. 세그먼트를 처음부터 다시 그리는
// 완전 재생 대신 카메라 리빌을 택한 것은 이미 그려진 것을 지웠다 다시 그리는 depublicated 작업을
// 피하기 위함이며, 정지 컷(공유 카드)이라는 목적은 동일하게 달성한다.
//
// [WT-M3-06] 제출 배선은 net/run-session.ts의 useRunSubmit에 위임한다(마운트 시 1회 — 클라
// 계산 점수를 최종 표시로 쓰지 않고 서버 값/순위로 교체, §11-D9). verdict별 라벨: valid/flagged는
// 순위 표시(shadow — flagged를 구분 표시하지 않는다, docs/06 §3.5), practice="연습 기록",
// rejected="기록이 검토 중입니다".
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { GameSessionEngine, RunResult as EngineRunResult } from '@wt/engine';
import type { Continent, Country, DifficultyTier, GameMode } from '@wt/shared';
import { useHotkeys } from '../../lib/hotkeys';
import { useMetaStore } from '../../stores/meta';
import { useSettingsStore } from '../../stores/settings';
import { checkNickname, putNickname } from '../../net/api-client';
import { useRunSubmit } from '../../net/run-session';
import { ResultCard } from '../../features/result/ResultCard';
import { describeRouteLabel } from './route-label';

/** KST 기준 "yyyy-mm-dd"(meta.recordPlay/스트릭 판정용, docs/00 §11 KST 관례). */
function todayKST(): string {
  const kst = new Date(Date.now() + 9 * 60 * 60 * 1000);
  return kst.toISOString().slice(0, 10);
}

export interface ResultViewProps {
  engine: GameSessionEngine;
  result: EngineRunResult;
  countries: readonly Country[];
  lang: 'ko' | 'en';
  mode: GameMode;
  trackId: string;
  platform: 'desktop' | 'mobile';
  /** finished 시점의 잔여 라이프(GamePage가 engine.getSnapshot().lives를 캡처). */
  finalLives: number | null;
  /** runs/start가 발급한 토큰. null이면 오프라인 출발 — 큐에 적재된다(net/run-session.ts). */
  runToken: string | null;
  runTokenIssuedAt: number | null;
  nickname: string;
  retry(): void;
}

export function ResultView({
  engine,
  result,
  countries,
  lang,
  mode,
  trackId,
  platform,
  finalLives,
  runToken,
  runTokenIssuedAt,
  nickname,
  retry,
}: ResultViewProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();

  const continent = mode === 'continent' ? (trackId as Continent) : undefined;
  const tier = mode === 'tier' ? (Number(trackId) as DifficultyTier) : undefined;

  const submission = useRunSubmit({
    engine,
    result,
    finalLives,
    mode: mode as 'continent' | 'tier' | 'worldtour' | 'daily',
    continent,
    tier,
    lang,
    platform,
    runToken,
    runTokenIssuedAt,
    nickname,
  });

  // R 리트라이(GDD §2.2 "결과 화면에서 R 키 … 2초 내 재개"). 대소문자 키 이벤트 값 모두 대응.
  useHotkeys({ r: retry, R: retry });

  const routeLabel = describeRouteLabel(mode, trackId, countries.length, t);

  const mostMistyped = useMemo(() => {
    let best: { name: string; count: number } | null = null;
    for (const p of result.stats.perCountry) {
      if (p.errors <= 0) continue;
      if (!best || p.errors > best.count) {
        const c = countries.find((x) => x.id === p.code);
        if (c) best = { name: lang === 'ko' ? c.nameKo : c.nameEn, count: p.errors };
      }
    }
    return best;
  }, [result, countries, lang]);

  const paceMs = useMemo(() => result.stats.perCountry.map((p) => p.ms), [result]);

  // 세계일주 게임오버 후 마지막 체크포인트 이어하기(엔진 1급 기능 — §5.1 resumeFromCheckpoint).
  // 스냅샷은 렌더 시점 값으로 충분하다(phase가 바뀌면 이 컴포넌트 자체가 언마운트된다).
  const canResume = engine.getSnapshot().checkpointResumeAvailable;

  // ModeSelectPage/TrackSelectPage(WT-M2-07)의 "완주/최고 기록"·"최고 도달지" 표시는 이 1회
  // 기록이 유일한 원천이다(로컬 진행 캐시 — 랭킹 제출과 무관, meta.ts 주석). 벌크 삽입/블러
  // 강등(practice)은 부정 의심 판이므로 개인 기록에도 반영하지 않는다(치트 스코어가 "내 최고"
  // 로 굳는 것을 방지). recordRun/recordWorldtourProgress는 각각 "더 나은 점수"/"더 깊은 도달"
  // 일 때만 갱신하는 멱등 연산이라 리액트 18 StrictMode 이중 호출에도 안전하다.
  useEffect(() => {
    if (result.practice) return;
    useMetaStore.getState().recordRun({
      mode,
      trackId,
      dateKST: todayKST(),
      pi: result.score.pi,
      grade: result.score.grade,
      timeMs: result.stats.elapsedMs,
      score: result.score.finalScore,
      completed: result.outcome === 'completed',
    });
    if (mode === 'worldtour') {
      const lastIndex = result.stats.perCountry.length - 1;
      const lastCountry = countries[lastIndex];
      if (lastCountry) {
        useMetaStore.getState().recordWorldtourProgress({
          index: lastIndex,
          countryId: lastCountry.id,
          nameKo: lastCountry.nameKo,
          nameEn: lastCountry.nameEn,
        });
      }
    }
    // result/countries/mode/trackId는 이 컴포넌트의 마운트 수명(phase==='finished') 동안 불변
    // (GamePage가 phase 전환마다 언마운트/재마운트한다) — 의도적으로 마운트 1회만 실행한다.
  }, [mode, trackId, result, countries]);

  return (
    <div className="wt-result-view" data-testid="result-view">
      <h1 className="wt-result-view__title" tabIndex={-1}>
        {t('result.title')}
      </h1>
      {/* 결과 도달 1회 assertive 낭독(§7.3 "결과: aria-live=assertive로 등급/점수 1회 낭독") —
          h1 자체가 아니라 별도 sr-only 영역에 값을 담아, 화면표시 카드(ResultCard)의 시각
          레이아웃과 스크린리더 낭독 문구를 분리한다(카드는 라벨+숫자를 나눠 여러 요소에
          흩어 놓아 그대로 낭독하면 뒤죽박죽이라서). */}
      <p role="status" aria-live="assertive" className="sr-only" data-testid="result-announce">
        {t('result.announce', {
          grade: result.score.grade,
          score: result.score.finalScore,
        })}
      </p>

      <ResultCard
        routeLabel={routeLabel}
        grade={result.score.grade}
        finalScore={result.score.finalScore}
        pi={result.score.pi}
        elapsedMs={result.stats.elapsedMs}
        cpm={result.score.cpm}
        accuracy={result.score.acc}
        maxCombo={result.stats.maxCombo}
        completed={result.outcome === 'completed'}
        mostMistyped={mostMistyped}
        paceMs={paceMs}
      />

      <SubmissionStatus submission={submission} />
      <UnlockToast newUnlocks={submission.newUnlocks} />
      {!nickname && <NicknameGate />}

      <div className="wt-result-view__actions">
        <button type="button" data-testid="result-retry" className="wt-btn wt-btn--primary" onClick={retry}>
          {t('result.action.retry')}
        </button>
        {canResume && (
          <button
            type="button"
            data-testid="result-resume"
            className="wt-btn"
            onClick={() => engine.resumeFromCheckpoint()}
          >
            {t('result.action.resume')}
          </button>
        )}
        <Link to="/rank" data-testid="result-ranking" className="wt-btn">
          {t('result.action.ranking')}
        </Link>
        {/* 공유 이미지 캡처는 M5 소관 — 레이아웃만(ResultCard 산출물 주석과 동일 조정). */}
        <button type="button" data-testid="result-share" className="wt-btn" disabled title="M5">
          {t('result.action.share')}
        </button>
        <button
          type="button"
          data-testid="result-other-route"
          className="wt-btn"
          onClick={() => navigate(`/play/${mode}`)}
        >
          {t('result.action.otherRoute')}
        </button>
        <button type="button" data-testid="result-home" className="wt-btn" onClick={() => navigate('/')}>
          {t('nav.home')}
        </button>
      </div>
    </div>
  );
}

/**
 * verdict별 UI 문구(구현 세부 지시 4). valid/flagged는 순위 표시(flagged를 구분하지 않는다 —
 * shadow 원칙, docs/06 §3.5). practice="연습 기록", rejected="기록이 검토 중입니다".
 * submitting/queued는 그 자체로 상태 라벨(아직 verdict 없음).
 */
function SubmissionStatus({ submission }: { submission: ReturnType<typeof useRunSubmit> }) {
  const { t } = useTranslation();

  if (submission.status === 'submitting') {
    return (
      <p className="wt-result-view__submission" data-testid="result-verdict-label">
        {t('result.verdict.submitting')}
      </p>
    );
  }
  if (submission.status === 'queued') {
    return (
      <p className="wt-result-view__submission" data-testid="result-verdict-label">
        {t('result.verdict.queued')}
      </p>
    );
  }
  if (submission.status !== 'submitted') return null;

  if (submission.verdict === 'practice') {
    return (
      <p className="wt-result-view__submission" data-testid="result-verdict-label">
        {t('result.verdict.practice')}
      </p>
    );
  }
  if (submission.verdict === 'rejected') {
    return (
      <p className="wt-result-view__submission" data-testid="result-verdict-label">
        {t('result.verdict.rejected')}
      </p>
    );
  }
  // valid | flagged — 서버 응답의 순위를 그대로 표시(§1.4-③ 인라인). flagged도 본인 화면에는
  // 정상 표시(shadow — 구분 UI 없음, docs/06 §3.5).
  if (submission.rank !== null && submission.total !== null && submission.total > 0) {
    const topPercent = Math.max(1, Math.round((submission.rank / submission.total) * 100));
    return (
      <p className="wt-result-view__submission" data-testid="result-rank">
        {t('result.rank.value', { rank: submission.rank, percent: topPercent })}
        {submission.isPersonalBest && ` · ${t('result.rank.personalBest')}`}
      </p>
    );
  }
  return null;
}

/**
 * 신규 업적/커버/스탬프 토스트(§9.2~9.4, WT-M5-03) + 첫 완주 "여권 발급" 연출(구현 세부 지시 —
 * ach:first_flight는 계정당 정확히 한 번만 서버가 지급하므로 이 토스트도 그 시점 1회만 뜬다).
 * 로컬 메타 캐시(stores/meta.ts)에도 achievement 항목을 반영해 두면 다음 방문 때 서버 재조회
 * 없이도 ModeSelectPage 등에서 즉시 참조할 수 있다(서버 값이 항상 최종 권위 — meta.ts 파일
 * 상단 주석과 동일 원칙).
 */
function UnlockToast({ newUnlocks }: { newUnlocks: string[] }) {
  const { t } = useTranslation();

  useEffect(() => {
    // unlockAchievement는 멱등(이미 있으면 no-op)이라 newUnlocks 참조가 바뀔 때마다 재실행돼도
    // 안전하다 — 제출 완료 시점(idle→submitted 1회 전이)에 실질적으로 한 번만 채워진다.
    for (const id of newUnlocks) {
      if (id.startsWith('ach:')) useMetaStore.getState().unlockAchievement(id);
    }
  }, [newUnlocks]);

  if (newUnlocks.length === 0) return null;

  return (
    <p className="wt-result-view__unlock-toast" role="status" data-testid="result-unlock-toast">
      {newUnlocks.includes('ach:first_flight') ? t('result.firstPassport') : t('result.newUnlock.toast', { count: newUnlocks.length })}
    </p>
  );
}

/** 닉네임 미설정(기본 GUEST_xxxx) 유저에게 결과 화면에서 닉네임 설정을 유도(구현 세부 지시 3). */
function NicknameGate() {
  const { t } = useTranslation();
  const setNickname = useSettingsStore((s) => s.setNickname);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = useCallback(() => {
    setBusy(true);
    setError(null);
    void (async () => {
      try {
        const checked = await checkNickname(value);
        if (!checked.ok) {
          setError(t('result.nickname.error'));
          return;
        }
        const res = await putNickname(value);
        setNickname(res.nickname);
      } catch {
        setError(t('result.nickname.error'));
      } finally {
        setBusy(false);
      }
    })();
  }, [value, setNickname, t]);

  return (
    <div className="wt-result-view__nickname" data-testid="result-nickname-gate">
      <p>{t('result.nickname.prompt')}</p>
      <input
        data-testid="result-nickname-input"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={t('result.nickname.placeholder')}
      />
      <button
        type="button"
        data-testid="result-nickname-submit"
        className="wt-btn"
        disabled={busy || value.length < 2}
        onClick={submit}
      >
        {t('result.nickname.submit')}
      </button>
      {error && (
        <p role="alert" data-testid="result-nickname-error">
          {error}
        </p>
      )}
    </div>
  );
}
