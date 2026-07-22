// spec: docs/06 §10-2(SEO — /daily 별도 title/description/OG), docs/01 §9.1(데일리 챌린지),
//       WT-M6-06
//
// [세션 조정 — 문서/구현 불일치 메모, 최종 보고에 escalation으로도 기록]
// docs/06 §10 체크리스트 문구는 "/daily"를 독립 라우트로 전제하지만, 실제 게임 플로우
// (WT-M2-07/WT-M3-06)는 데일리 진입을 전부 `/play/daily/:date`(TrackSelectPage/GamePage의
// mode=daily 분기, HomePage의 데일리 배지/카드도 전부 이 경로로 직접 링크)로 구현했다 — 최상위
// "/daily" 라우트는 이전에 존재한 적이 없다. 이 작업은 "게임 로직/스키마 변경 금지"(마감 전용)
// 제약 아래 있으므로, 실제 판정/시드/세션 경로는 건드리지 않고 "/daily"를 순수 SEO 랜딩
// (오늘 챌린지로 안내하는 CTA 1개짜리 정적 페이지)으로만 신설한다 — sitemap.xml에 넣을 수 있는
// 안정적인 URL이 생기고, RouteMeta가 이 경로에 데일리 전용 title/description을 붙일 수 있다.
// 실제 플레이 진입/판정은 여전히 기존 `/play/daily/:date` 경로가 전담한다.
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

/** HomePage.tsx의 todayDailyKey()와 동일 규약(UTC 자정 기준 ISO 날짜). 페이지 하나만을 위해
 *  공유 모듈로 승격할 만큼 무겁지 않아 그대로 복제한다(회귀 표면 최소화 — 마감 태스크 원칙). */
function todayDailyKey(): string {
  return new Date().toISOString().slice(0, 10);
}

export function DailyPage() {
  const { t } = useTranslation();

  return (
    <main
      className="mx-auto flex min-h-screen max-w-xl flex-col items-center justify-center gap-4 p-8 text-center"
      data-testid="daily-page"
    >
      <h1 className="text-2xl font-bold" tabIndex={-1}>
        {t('home.daily.title')}
      </h1>
      <p className="text-sm opacity-80">{t('home.daily.desc', { count: 10 })}</p>
      <Link
        to={`/play/daily/${todayDailyKey()}`}
        data-testid="daily-page-cta"
        className="rounded-full bg-sky-500 px-6 py-3 text-sm font-semibold text-white"
      >
        {t('daily.play.cta')}
      </Link>
    </main>
  );
}
