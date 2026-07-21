// @vitest-environment jsdom
//
// spec: docs/03 §3.1(GeoIndex 구축 원천), WT-M2-06. 모듈 스코프 캐시(bootLoader.ts와 동일 패턴)가
// 동일 URL에 대해 fetch를 1회만 수행하는지 검증한다.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { __resetTopologyCacheForTests, loadTopology } from './topology-loader';

describe('loadTopology', () => {
  afterEach(() => {
    __resetTopologyCacheForTests();
    vi.unstubAllGlobals();
  });

  it('첫 호출에서 fetch하고 이후 호출은 캐시를 재사용한다(fetch 1회)', async () => {
    const topology = { objects: { countries: { geometries: [] } } };
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(topology),
    });
    vi.stubGlobal('fetch', fetchMock);

    const a = await loadTopology('/data/countries-110m.json');
    const b = await loadTopology('/data/countries-110m.json');

    expect(a).toEqual(topology);
    expect(b).toBe(a); // 동일 참조 — 캐시 재사용.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('동시 호출은 같은 in-flight 프라미스를 공유한다', async () => {
    const topology = { objects: { countries: { geometries: [] } } };
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve(topology) });
    vi.stubGlobal('fetch', fetchMock);

    const [a, b] = await Promise.all([
      loadTopology('/data/countries-110m.json'),
      loadTopology('/data/countries-110m.json'),
    ]);
    expect(a).toBe(b);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('응답이 실패(!ok)면 throw하고 캐시하지 않는다(재시도 가능)', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 500 });
    vi.stubGlobal('fetch', fetchMock);

    await expect(loadTopology('/data/countries-110m.json')).rejects.toThrow(/topology fetch failed/);

    // 실패는 캐싱되지 않는다 — 다음 호출이 다시 fetch를 시도한다.
    const topology = { objects: { countries: { geometries: [] } } };
    fetchMock.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(topology) });
    const retried = await loadTopology('/data/countries-110m.json');
    expect(retried).toEqual(topology);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
