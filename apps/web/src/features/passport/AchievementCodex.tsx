// spec: docs/01 §9.2(업적 24종)·§9.3(숨김 업적 개념 없음 — 전부 공개형), docs/06 §4.3,
//       docs/03 §7.3(a11y — 색/필터에만 의존하지 않는 상태 전달) + WT-PASSPORT-DEV-1
//
// 업적 "도감": 24종을 **항상 전부** 렌더하고 달성 여부만 시각으로 전환한다(미달성 = 흑백/비활성,
// 달성 = 컬러 + 금테). 미달성이어도 이름·조건 문구를 그대로 노출해 "뭘 하면 되는지"가 보이게 한다.
//
// a11y: grayscale/opacity는 아이콘에만 걸고(텍스트 대비 보존 — .wt-token--locked의 기존 원칙과
// 동일: "서클만 opacity, 라벨은 대비 유지"), 달성/미달성은 sr-only 텍스트 + data-unlocked
// 속성으로도 전달한다(색·필터 단독 전달 금지).
//
// 고빈도 값이 아니다(여권 조회 1회 후 정적) — 일반 React 렌더로 충분하다(CLAUDE.md 핫패스 규약은
// 입력 버퍼/실시간 CPM 등에만 적용).
import { useTranslation } from 'react-i18next';
import {
  ACHIEVEMENTS_CATALOG,
  ACHIEVEMENT_TOTAL,
  achievementI18nKey,
} from './achievements-catalog';

export interface AchievementCodexProps {
  /** 달성한 업적 id 집합(`ach:` 프리픽스가 제거된 형태 — unlockedAchievementIds()의 산출물). */
  unlockedIds: ReadonlySet<string>;
}

export function AchievementCodex({ unlockedIds }: AchievementCodexProps) {
  const { t } = useTranslation();
  const unlockedCount = ACHIEVEMENTS_CATALOG.filter((a) => unlockedIds.has(a.id)).length;

  return (
    <section className="wt-passport-page__codex" data-testid="passport-codex">
      <h2 className="wt-kicker">{t('passport.achievements.title')}</h2>
      <p className="wt-passport-page__stat" data-testid="passport-achievements-count">
        {t('passport.achievements.count', { count: unlockedCount, total: ACHIEVEMENT_TOTAL })}
      </p>
      <ul className="wt-passport-page__achievements" data-testid="passport-achievements">
        {ACHIEVEMENTS_CATALOG.map((entry) => {
          const unlocked = unlockedIds.has(entry.id);
          return (
            <li
              key={entry.id}
              // 기존 계약 유지: testid는 서버 unlock_id 표기(`ach:{id}`)를 그대로 쓴다.
              data-testid={`passport-achievement-ach:${entry.id}`}
              data-unlocked={unlocked ? 'true' : 'false'}
              className={`wt-achv${unlocked ? ' wt-achv--unlocked' : ' wt-achv--locked'}`}
            >
              <span className="wt-achv__icon" aria-hidden="true">
                {entry.icon}
              </span>
              <span className="wt-achv__name">{t(achievementI18nKey(entry.id, 'name'))}</span>
              <span className="wt-achv__desc">{t(achievementI18nKey(entry.id, 'desc'))}</span>
              <span className="sr-only">
                {unlocked
                  ? t('passport.achievements.unlocked')
                  : t('passport.achievements.locked')}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
