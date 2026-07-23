// spec: docs/01 §10.2(S7 결과 카드 전문), §13.2(등급색 S/A/B/C/D), §13.3-6(완주 리트레이스 →
//       "이 리트레이스 장면이 공유 카드의 정지 컷"). WT-M2-06.
// [공유 캡처 범위 주의] 이 컴포넌트는 결과 카드의 레이아웃만 담당한다 — 이미지 캡처/공유 로직은
// M5 소관(산출물 목록 주석 그대로). 여기서는 공유 버튼을 렌더하지 않는다(호출부 ResultView가
// 액션 행을 별도로 구성한다).
//
// [WT-UI-06] "절취 후 남은 티켓" 반쪽 보딩패스 스텁 카드로 리스타일 — 03 BoardingPass(§10.2 S5)·
// 05 BoardingStrip(WT-UI-03)의 티켓/캡슐 디자인 언어(절취선·코너 노치·바코드)를 시각 참조한다.
// 등급은 "찍힌 스탬프"(잉크 링 + 팝인, globals.css .wt-result-card__grade)로, perCountry 페이스는
// 등급색 그라디언트 스파크라인으로 표현한다. props·data-testid·i18n 키는 전부 무수정 — 시각만
// 바꾼다(호출부 ResultView.tsx도 무수정: 이 컴포넌트가 기존 grade prop만으로 스탬프/등급색을
// 전부 로컬 계산한다).
import { useTranslation } from 'react-i18next';
import type { Grade } from '@wt/shared';
import { formatCpm, formatPercent, formatSeconds } from '../../lib/format';

export interface ResultCardProps {
  routeLabel: string;
  grade: Grade;
  finalScore: number;
  pi: number;
  elapsedMs: number;
  cpm: number;
  /** 0~1 비율. */
  accuracy: number;
  maxCombo: number;
  completed: boolean;
  mostMistyped: { name: string; count: number } | null;
  /** 국가별 소요 ms(구간 그래프 근사 — docs/01 §10.2 "구간 그래프: CPM 추이 스파크라인"의
   *  경량 대체. 값이 작을수록(빠를수록) 막대가 짧다). */
  paceMs: readonly number[];
}

export function ResultCard({
  routeLabel,
  grade,
  finalScore,
  pi,
  elapsedMs,
  cpm,
  accuracy,
  maxCombo,
  completed,
  mostMistyped,
  paceMs,
}: ResultCardProps) {
  const { t } = useTranslation();
  const maxPace = paceMs.length > 0 ? Math.max(...paceMs) : 0;

  return (
    <div className={`wt-card wt-result-card wt-result-card--${grade}`} data-testid="result-card">
      <p className="wt-result-card__route">
        {completed ? t('result.routeComplete', { route: routeLabel }) : t('result.outcome.gameover')}
      </p>

      {/* 등급 스탬프(구현 세부 지시 1) — 잉크 스탬프 링 + 입장 시 1회 팝인(globals.css
          wt-result-stamp-in, transform/opacity만 · reduced-motion 대응). 텍스트/i18n(result.grade)
          은 그대로, 시각만 .wt-result-card__grade가 담당한다. */}
      <p className="wt-result-card__grade" data-testid="result-grade">
        {t('result.grade', { grade })}
      </p>

      <p className="wt-result-card__score">
        {t('result.score', { score: finalScore })} · {t('result.pi', { pi })}
      </p>
      <p className="wt-result-card__stats">
        <span>{t('result.time', { seconds: formatSeconds(elapsedMs) })}</span>
        <span>{t('result.cpm', { cpm: formatCpm(cpm) })}</span>
        <span>{t('result.accuracy', { accuracy: formatPercent(accuracy) })}</span>
        <span>{t('result.streak', { count: maxCombo })}</span>
      </p>

      {paceMs.length > 1 && (
        <div className="wt-result-card__pace-wrap">
          {/* 기존에 있었지만 미사용이던 i18n 키 재사용(신규 키 추가 없음) — docs/01 §10.2
              "구간 그래프: [CPM 추이 스파크라인]"의 캡션과 그대로 대응. */}
          <span className="wt-result-card__pace-label">{t('result.chart.label')}</span>
          <div className="wt-result-card__pace" data-testid="result-pace" aria-hidden="true">
            {paceMs.map((ms, i) => (
              <span
                key={i}
                className="wt-result-card__pace-bar"
                style={{ height: maxPace > 0 ? `${Math.max(8, (ms / maxPace) * 100)}%` : '8%' }}
              />
            ))}
          </div>
        </div>
      )}

      {mostMistyped && (
        <p className="wt-result-card__mistyped">
          {t('result.mostMistyped', { country: mostMistyped.name, count: mostMistyped.count })}
        </p>
      )}

      {/* 하단 바코드 텍스처(순수 장식, aria-hidden) — "찢겨 보관된 티켓 스텁" 인상의 마무리.
          BoardingPass의 .wt-boarding__barcode와 같은 시각 계열이지만 독립 클래스(결합 없음). */}
      <span className="wt-result-card__barcode" aria-hidden="true" />
    </div>
  );
}
