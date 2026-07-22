// spec: docs/01 §10.1(S3 모드 선택)·§10.2(S3 와이어프레임 — "완주 4/6"·"진행 T3 도전 중"·
//       "최고: 카이로 도달"), docs/03 §4.1(라우트 `play` → ModeSelectPage), WT-M2-05(스텁),
//       WT-M2-07(카드 3종 + 완주/진행 기록 채움)
//
// 완주/진행 기록은 서버가 아니라 stores/meta.ts(로컬 진행 캐시, ResultView.recordRun이 유일한
// 쓰기 진입점)에서 읽는다 — 이 페이지는 국가 데이터셋(getBootData)에 의존하지 않는다(대륙 국가
// 수는 @wt/data/content/routes.ts 정적 데이터로 충분하고, 세계일주 최고 도달지는 meta 스토어에
// 이미 로컬라이즈된 이름 문자열로 저장되어 있다 — app/router.test.tsx가 bootLoader 없이 이
// 페이지를 직접 렌더하는 전제와 호환되어야 한다).
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { Continent } from '@wt/shared';
import { CONTINENT_ROUTES } from '@wt/data/content/routes';
import { useMetaStore } from '../../stores/meta';
import { useSettingsStore } from '../../stores/settings';

const CONTINENT_IDS = Object.keys(CONTINENT_ROUTES) as Continent[];

export function ModeSelectPage() {
  const { t } = useTranslation();
  const lang = useSettingsStore((s) => s.lang);
  const stamps = useMetaStore((s) => s.stamps);
  const trackBests = useMetaStore((s) => s.trackBests);
  const worldtourFurthest = useMetaStore((s) => s.worldtourFurthest);

  const continentDone = CONTINENT_IDS.filter((c) => stamps[`continent:${c}`]).length;

  // "진행: T3 도전 중"(§10.2) — trackBests의 tier: 키 중 가장 높은 번호(완주 여부 무관, 시도만
  // 해도 남는다 — meta.ts recordRun 주석 참조).
  const attemptedTiers = Object.keys(trackBests)
    .filter((k) => k.startsWith('tier:'))
    .map((k) => Number(k.slice('tier:'.length)))
    .filter((n) => Number.isFinite(n));
  const currentTier = attemptedTiers.length > 0 ? Math.max(...attemptedTiers) : null;

  const worldtourLocation = worldtourFurthest
    ? lang === 'ko'
      ? worldtourFurthest.nameKo
      : worldtourFurthest.nameEn
    : null;

  return (
    <main className="wt-mode-select" data-testid="mode-select-page">
      <div className="wt-mode-select__header">
        <Link to="/" data-testid="mode-select-back" className="wt-nav-back">
          {t('nav.back.home')}
        </Link>
        <h1 className="wt-mode-select__title" tabIndex={-1}>{t('mode.select.title')}</h1>
      </div>

      <div className="wt-mode-select__cards">
        <Link to="/play/continent" data-testid="mode-card-continent" className="wt-mode-card">
          <p className="wt-mode-card__title">{t('mode.continent.title')}</p>
          <p className="wt-mode-card__meta">{t('mode.continent.count', { count: CONTINENT_IDS.length })}</p>
          <p className="wt-mode-card__progress" data-testid="mode-card-continent-progress">
            {t('mode.continent.progress', { done: continentDone, total: CONTINENT_IDS.length })}
          </p>
        </Link>

        <Link to="/play/tier" data-testid="mode-card-tier" className="wt-mode-card">
          <p className="wt-mode-card__title">{t('mode.tier.title')}</p>
          <p className="wt-mode-card__meta">{t('mode.tier.subtitle')}</p>
          {currentTier !== null && (
            <p className="wt-mode-card__progress" data-testid="mode-card-tier-progress">
              {t('mode.tier.progress', { tier: currentTier })}
            </p>
          )}
        </Link>

        <Link to="/play/worldtour" data-testid="mode-card-worldtour" className="wt-mode-card">
          <p className="wt-mode-card__title">{t('mode.worldtour.title')}</p>
          <p className="wt-mode-card__meta">{t('mode.worldtour.desc')}</p>
          {worldtourLocation && (
            <p className="wt-mode-card__progress" data-testid="mode-card-worldtour-progress">
              {t('mode.worldtour.progress', { location: worldtourLocation })}
            </p>
          )}
        </Link>
      </div>
    </main>
  );
}
