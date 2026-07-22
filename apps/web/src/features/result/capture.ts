// spec: docs/03 §8.3(캡처 dynamic import 계약), docs/07 WT-M5-04 [제약/금지] "캡처 라이브러리를
// entry 청크에 포함 금지"
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
 * 결과 카드 DOM 노드를 PNG Blob으로 캡처한다. node는 ResultView가 감싸는 wrapper(테마
 * 배경까지 포함해 캡처되도록 카드 자체가 아니라 그 wrapper를 넘긴다).
 */
export async function captureResultCardPng(node: HTMLElement, opts: CaptureOptions = {}): Promise<Blob> {
  const { toBlob } = await import('html-to-image');
  const blob = await toBlob(node, { pixelRatio: opts.pixelRatio ?? 2 });
  if (!blob) {
    throw new Error('captureResultCardPng: html-to-image.toBlob이 null을 반환했습니다.');
  }
  return blob;
}
