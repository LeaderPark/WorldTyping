// spec: docs/00 §11-D68-⑤(인증 채널은 "런타임 네트워크 없음" 예외 — GIS 스크립트 지연 주입) +
//       WT-AUTH-03 금지사항("GIS를 index.html 정적 로드 금지, 지연 주입만")
//
// accounts.google.com/gsi/client 스크립트를 최초 필요 시점(로그인 모달 오픈)에 1회만 <head>에
// 주입한다. 이미 주입/로드됐으면 즉시 resolve, 실패하면 reject하고 프라미스 캐시를 비워 재시도를
// 허용한다(네트워크 일시 실패 후 사용자가 다시 로그인 버튼을 누르면 재로드).

const GIS_SRC = 'https://accounts.google.com/gsi/client';

let gisPromise: Promise<GoogleAccountsGlobal> | null = null;

function ready(): GoogleAccountsGlobal | null {
  return window.google?.accounts?.id ? window.google : null;
}

/** GIS를 지연 로드하고 window.google을 resolve한다(실패 시 reject — 호출측이 폴백 UI 표시). */
export function loadGis(): Promise<GoogleAccountsGlobal> {
  const already = ready();
  if (already) return Promise.resolve(already);
  if (gisPromise) return gisPromise;

  gisPromise = new Promise<GoogleAccountsGlobal>((resolve, reject) => {
    const settleLoaded = (): void => {
      const g = ready();
      if (g) resolve(g);
      else fail(new Error('GIS script loaded but window.google.accounts.id is missing'));
    };
    const fail = (err: Error): void => {
      gisPromise = null; // 재시도 허용
      reject(err);
    };

    const existing = document.querySelector<HTMLScriptElement>(`script[src="${GIS_SRC}"]`);
    if (existing) {
      if (ready()) {
        resolve(ready() as GoogleAccountsGlobal);
        return;
      }
      existing.addEventListener('load', settleLoaded, { once: true });
      existing.addEventListener('error', () => fail(new Error('Failed to load Google Identity Services')), { once: true });
      return;
    }

    const script = document.createElement('script');
    script.src = GIS_SRC;
    script.async = true;
    script.defer = true;
    script.addEventListener('load', settleLoaded, { once: true });
    script.addEventListener('error', () => fail(new Error('Failed to load Google Identity Services')), { once: true });
    document.head.appendChild(script);
  });

  return gisPromise;
}

/** 테스트 전용: 로더 캐시 초기화(주입된 스크립트/window.google은 테스트가 별도 정리). */
export function __resetGisForTests(): void {
  gisPromise = null;
}
