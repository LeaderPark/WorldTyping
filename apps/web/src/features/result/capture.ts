// spec: docs/03 §8.3(캡처 dynamic import 계약), docs/07 WT-M5-04 [제약/금지] "캡처 라이브러리를
// entry 청크에 포함 금지", WT-UI-06(캡처 산출 이미지를 라이트 카드로 정합)
//
// html-to-image는 이 함수 호출 시점(공유 버튼 클릭)에만 동적 import한다 — 정적 import를 이
// 파일에조차 두면 이 파일을 정적으로 참조하는 ResultView가 속한 "game" 청크에 라이브러리가
// 딸려 들어가 entry 예산(size-limit)과 무관해야 할 코드가 게임 진입 지연에 끼어든다.
// vite.config.ts의 VENDOR_CAPTURE 매뉴얼 청크가 이 동적 import 그래프를 "share-capture-*.js"
// 라는 결정적 이름으로 분리해, tooling/ci/size-limit.json이 entry 측정에서 안전하게 제외한다.
export interface CaptureOptions {
  /** 캡처 배율(레티나 공유 이미지 품질 확보). 기본 2 — OG 카드(1200×630 등가) 수준. */
  pixelRatio?: number;
}

/**
 * [WT-UI-06] 캡처 동안 문서 테마를 라이트로 일시 강제한다 — 공유 이미지(ShareCard/OG 등가)는
 * 사용자의 다크 설정과 무관하게 항상 라이트 톤 카드로 나와야 한다(산출 이미지 정합). 값을
 * 재계산·재복제하지 않고 AppShell.tsx(무수정)가 테마 전환에 쓰는 것과 동일한 스위치
 * (`document.documentElement`의 `data-theme` 속성)를 그대로 재사용한다 — 카드가 참조하는 모든
 * CSS 변수(등급 텍스트 대비 보정값 포함, globals.css .wt-result-card--*)가 실제 라이트 렌더와
 * 완전히 동일하게 재계산되므로 값이 어긋날 위험이 없다.
 *
 * 트레이드오프: 캡처가 진행되는 짧은 구간(보통 <200ms) 동안 화면 전체가 라이트로 잠깐 보일 수
 * 있다 — 공유 버튼을 누른 직후의 1회성 동작이라 허용 가능한 것으로 판단했다(최종 보고 참조).
 * 이미 라이트이거나 테마가 설정되지 않은 경우는 속성을 건드리지 않는다(no-op).
 */
async function withForcedLightTheme<T>(run: () => Promise<T>): Promise<T> {
  const root = document.documentElement;
  const prevTheme = root.getAttribute('data-theme');
  const wasDark = prevTheme === 'dark';
  if (wasDark) root.setAttribute('data-theme', 'light');
  try {
    return await run();
  } finally {
    if (wasDark) root.setAttribute('data-theme', prevTheme as string);
  }
}

/**
 * 결과 카드 DOM 노드를 PNG Blob으로 캡처한다. node는 ResultView가 감싸는 wrapper(테마
 * 배경까지 포함해 캡처되도록 카드 자체가 아니라 그 wrapper를 넘긴다).
 */
export async function captureResultCardPng(node: HTMLElement, opts: CaptureOptions = {}): Promise<Blob> {
  const { toBlob } = await import('html-to-image');
  return withForcedLightTheme(async () => {
    const blob = await toBlob(node, { pixelRatio: opts.pixelRatio ?? 2 });
    if (!blob) {
      throw new Error('captureResultCardPng: html-to-image.toBlob이 null을 반환했습니다.');
    }
    return blob;
  });
}
