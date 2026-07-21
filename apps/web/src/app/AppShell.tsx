// spec: docs/00 §6 (apps/web/src/app/AppShell.tsx), WT-M0-01
//
// M0 스캐폴드: 라우터/부트로더 없이 "Hello WORLD TYPING" 한 줄만 렌더한다.
// 실제 라우팅(router.tsx)·bootLoader·providers는 WT-M2-05에서 채운다.

export function AppShell() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-white text-slate-900 dark:bg-slate-900 dark:text-white">
      <h1 className="text-2xl font-bold">Hello WORLD TYPING</h1>
    </main>
  );
}
