// spec: WT-M5-01 — vitest는 apps/web/vite.config.ts의 vite-plugin-pwa 플러그인을 로드하지 않으므로
// (테스트 config는 별도, apps/web/vitest.config.ts·루트 vitest.config.ts 둘 다 test 전용 최소
// 설정) `virtual:pwa-register/react` 가상 모듈을 실제로 해석할 방법이 없다. 두 vitest config가
// 이 파일을 그 스펙시파이어의 별칭(resolve.alias)으로 대체해 AppShell.tsx를 그대로 렌더할 수
// 있게 한다 — SW 등록 자체를 테스트하지 않는(needRefresh는 항상 false) 무해한 스텁이다.
export function useRegisterSW() {
  return {
    needRefresh: [false, () => {}] as [boolean, (v: boolean) => void],
    offlineReady: [false, () => {}] as [boolean, (v: boolean) => void],
    updateServiceWorker: async () => {},
  };
}
