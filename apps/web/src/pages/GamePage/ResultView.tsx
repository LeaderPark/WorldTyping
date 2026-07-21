// spec: docs/01 §10.2(S7 결과 전문), §13.3-6(완주 리트레이스 → 결과 카드 슬라이드 인), docs/03
//       §4.2(ResultView, phase: finished), WT-M2-06.
//
// [완주 리트레이스 — 구현 메모] §13.3-6은 "노선 전체가 지도 위에서 한 번에 리트레이스"를
// 요구한다. 이 구현에서 solved/route 레이어는 이미 플레이 중 진행분으로 누적 그려져 있으므로
// (GamePage의 countryCommitted 배선), finished 전이 시점에 카메라만 전체 노선 bounds로
// flyTo(1.2s)해 "완성된 노선을 한 번에 드러내는" 리트레이스 효과를 낸다(GamePage 담당) — 이
// 화면은 그 위에 카드가 슬라이드 인(CSS)하는 것만 담당한다. 세그먼트를 처음부터 다시 그리는
// 완전 재생 대신 카메라 리빌을 택한 것은 이미 그려진 것을 지웠다 다시 그리는 depublicated 작업을
// 피하기 위함이며, 정지 컷(공유 카드)이라는 목적은 동일하게 달성한다.
import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { GameSessionEngine, RunResult as EngineRunResult } from '@wt/engine';
import type { Country, GameMode } from '@wt/shared';
import { useHotkeys } from '../../lib/hotkeys';
import { ResultCard } from '../../features/result/ResultCard';
import { describeRouteLabel } from './route-label';

export interface ResultViewProps {
  engine: GameSessionEngine;
  result: EngineRunResult;
  countries: readonly Country[];
  lang: 'ko' | 'en';
  mode: GameMode;
  trackId: string;
  retry(): void;
}

export function ResultView({ engine, result, countries, lang, mode, trackId, retry }: ResultViewProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();

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

  return (
    <div className="wt-result-view" data-testid="result-view">
      <h1 className="wt-result-view__title">{t('result.title')}</h1>

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
        {/* 랭킹 제출은 M3-06 소관 — 서버 API 연동 전까지 disabled 스텁(작업 특이 조정). */}
        <button type="button" data-testid="result-ranking" className="wt-btn" disabled title="M3-06">
          {t('result.action.ranking')}
        </button>
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
