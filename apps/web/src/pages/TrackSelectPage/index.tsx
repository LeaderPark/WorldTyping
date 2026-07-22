// spec: docs/01 §10.1(S4 노선/세부 선택 — "대륙·티어·일주 공용"), §10.2(S4 와이어프레임 —
//       "최고 S 2:58"·"미완주"·"미도전"·"출발→"), docs/03 §4.1(라우트 `play/:mode`),
//       WT-M2-05(스텁), WT-M2-07(노선/티어/세계일주 목록 채움)
//
// ModeSelectPage와 동일 이유로 getBootData()(국가 데이터셋)에 의존하지 않는다 — 대륙 노선의
// 국가 수는 @wt/data/content/routes.ts 정적 배열 길이로, 최고 기록은 stores/meta.ts의 로컬
// 캐시(trackBests)로 충분하다.
import { Link, Navigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { Continent } from '@wt/shared';
import { CONTINENT_ROUTES, ROUTE_WORLD_TOUR } from '@wt/data/content/routes';
import { formatMMSS } from '../../lib/format';
import { useMetaStore, type TrackBest } from '../../stores/meta';

const CONTINENT_ORDER = Object.keys(CONTINENT_ROUTES) as Continent[];
const TIER_IDS = [1, 2, 3, 4, 5] as const;

type TFn = ReturnType<typeof useTranslation>['t'];

/** "최고 {grade} {time}" | "미완주"(시도했지만 완주 실패) | "미도전"(기록 없음) — §10.2 3분기. */
function bestStatusLabel(best: TrackBest | undefined, t: TFn): string {
  if (!best) return t('route.status.notAttempted');
  if (!best.completed) return t('route.status.incomplete');
  return t('route.best', { grade: best.grade, time: formatMMSS(best.timeMs) });
}

export function TrackSelectPage() {
  const { t } = useTranslation();
  const { mode } = useParams<{ mode: string }>();
  const trackBests = useMetaStore((s) => s.trackBests);

  if (mode !== 'continent' && mode !== 'tier' && mode !== 'worldtour') {
    // daily/race(또는 오타)는 이 화면이 다루지 않는다 — 모드 선택으로 되돌린다.
    return <Navigate to="/play" replace />;
  }

  return (
    <main className="wt-track-select" data-testid="track-select-page">
      <div className="wt-track-select__header">
        <Link to="/play" data-testid="track-select-back" className="wt-nav-back">
          {t('nav.back.mode')}
        </Link>
        <h1 className="wt-track-select__title" tabIndex={-1}>{t('route.select.title')}</h1>
      </div>

      <ul className="wt-track-select__list">
        {mode === 'continent' &&
          CONTINENT_ORDER.map((continent) => {
            const count = CONTINENT_ROUTES[continent].length;
            const best = trackBests[`continent:${continent}`];
            return (
              <li key={continent}>
                <Link
                  to={`/play/continent/${continent}`}
                  data-testid={`track-item-continent-${continent}`}
                  className="wt-track-item"
                >
                  <span className="wt-track-item__name">
                    {t('route.list.name', { continent: t(`continent.${continent}`), count })}
                  </span>
                  <span className="wt-track-item__best">{bestStatusLabel(best, t)}</span>
                  <span className="wt-track-item__cta">{t('route.start')}</span>
                </Link>
              </li>
            );
          })}

        {mode === 'tier' &&
          TIER_IDS.map((tier) => {
            const best = trackBests[`tier:${tier}`];
            return (
              <li key={tier}>
                <Link to={`/play/tier/${tier}`} data-testid={`track-item-tier-${tier}`} className="wt-track-item">
                  <span className="wt-track-item__name">{t('mode.tier.desc', { tier })}</span>
                  <span className="wt-track-item__best">{bestStatusLabel(best, t)}</span>
                  <span className="wt-track-item__cta">{t('route.start')}</span>
                </Link>
              </li>
            );
          })}

        {mode === 'worldtour' && (
          <li>
            <Link to="/play/worldtour/main" data-testid="track-item-worldtour" className="wt-track-item">
              <span className="wt-track-item__name">
                {t('route.list.name', { continent: t('mode.worldtour.title'), count: ROUTE_WORLD_TOUR.length })}
              </span>
              <span className="wt-track-item__best">{bestStatusLabel(trackBests['worldtour:main'], t)}</span>
              <span className="wt-track-item__cta">{t('route.start')}</span>
            </Link>
          </li>
        )}
      </ul>
    </main>
  );
}
