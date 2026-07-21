// spec: docs/03 §4.4(useHotkeys 시그니처), WT-M2-05
//
// 인게임 핫패스 전용이 아니다(그쪽은 §4.5에 따라 엔진이 직접 DOM 이벤트를 흡수한다) — 이 훅은
// 메뉴/오버레이용 저빈도 키 바인딩(R 리트라이, ESC 닫기 등)만 담당한다.

import { useEffect, useRef } from 'react';

/**
 * map이 비어 있으면 리스너를 등록하지 않는다(오버레이 닫힘 상태 등). map은 매 렌더 새 객체로
 * 와도 무방하다 — ref로 최신 콜백을 추적해 리스너를 키 집합이 바뀔 때만 재바인딩한다(클로저
 * 고착 방지).
 */
export function useHotkeys(map: Record<string, () => void>): void {
  const mapRef = useRef(map);
  mapRef.current = map;

  const keySignature = Object.keys(map).sort().join(',');

  useEffect(() => {
    if (!keySignature) return;
    function onKeyDown(event: KeyboardEvent): void {
      const handler = mapRef.current[event.key];
      if (handler) {
        event.preventDefault();
        handler();
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [keySignature]);
}
