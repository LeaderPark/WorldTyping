// @vitest-environment jsdom
//
// spec: WT-AUTH-03(GIS 지연 주입, 실패 시 재시도 허용). jsdom은 스크립트를 실제로 로드하지 않으므로
// load/error 이벤트를 수동 디스패치해 로더 상태 전이를 검증한다.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { __resetGisForTests, loadGis } from './gis-loader';

const SRC = 'https://accounts.google.com/gsi/client';

function fakeGoogle(): GoogleAccountsGlobal {
  return {
    accounts: {
      id: {
        initialize: () => {},
        renderButton: () => {},
        prompt: () => {},
        cancel: () => {},
        disableAutoSelect: () => {},
      },
    },
  };
}

describe('gis-loader (WT-AUTH-03)', () => {
  beforeEach(() => {
    __resetGisForTests();
    document.querySelectorAll(`script[src="${SRC}"]`).forEach((s) => s.remove());
    delete window.google;
  });
  afterEach(() => {
    delete window.google;
  });

  it('스크립트를 1회 주입하고 load + window.google 준비 시 resolve한다', async () => {
    const p = loadGis();
    const script = document.querySelector<HTMLScriptElement>(`script[src="${SRC}"]`);
    expect(script).not.toBeNull();
    expect(script?.async).toBe(true);

    window.google = fakeGoogle();
    script?.dispatchEvent(new Event('load'));
    await expect(p).resolves.toBe(window.google);
  });

  it('로드 실패 시 reject하고 캐시를 비워 재시도(새 프라미스)를 허용한다', async () => {
    const p = loadGis();
    const script = document.querySelector<HTMLScriptElement>(`script[src="${SRC}"]`);
    script?.dispatchEvent(new Event('error'));
    await expect(p).rejects.toThrow(/Google Identity Services/);

    const p2 = loadGis();
    expect(p2).not.toBe(p);
    p2.catch(() => {}); // dangling rejection 방지
  });

  it('이미 window.google이 준비돼 있으면 주입 없이 즉시 resolve한다', async () => {
    window.google = fakeGoogle();
    await expect(loadGis()).resolves.toBe(window.google);
    expect(document.querySelector(`script[src="${SRC}"]`)).toBeNull();
  });
});
