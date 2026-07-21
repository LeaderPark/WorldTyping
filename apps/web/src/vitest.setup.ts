// spec: WT-M2-05 — jsdom 렌더 테스트에서 toBeInTheDocument()/toHaveTextContent() 등
// jest-dom 매처를 쓰기 위한 전역 셋업. environment:'node'로 실행되는 순수 로직 테스트에는
// 영향 없다(이 파일 자체는 DOM API를 직접 건드리지 않고 matcher만 등록).
import '@testing-library/jest-dom/vitest';
