// @vitest-environment jsdom
//
// spec: docs/09 §5.1(chase-graph 포맷)·§8.1(lazy fetch), WT-CH-08. topology-loader.test.ts와 동일한
// "모듈 스코프 1회 캐시" 문법을 검증한다(manifest.json 해시 → chase-graph.json 순 fetch).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { __resetChaseGraphCacheForTests, loadChaseGraph } from './load-chase-graph';

function validDataset() {
  return {
    schemaVersion: 1,
    builtAt: '2026-07-21T00:00:00.000Z',
    ids: ['AD', 'FR'],
    nodes: {
      AD: { nearest: [{ id: 'FR', km: 391 }], homeEligible: false },
      FR: { nearest: [{ id: 'AD', km: 391 }], homeEligible: true },
    },
    matrix: 'gAE=',
  };
}

function stubFetch(dataset: unknown, manifestOk = true): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn((url: string) => {
    if (url.includes('manifest.json')) {
      return Promise.resolve({
        ok: manifestOk,
        json: () => Promise.resolve({ chaseGraph: { sha256: 'abcdef1234567890' } }),
      });
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve(dataset) });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('loadChaseGraph', () => {
  afterEach(() => {
    __resetChaseGraphCacheForTests();
    vi.unstubAllGlobals();
  });

  it('첫 호출에서 manifest+chase-graph를 fetch하고 ChaseGraph(ids/nodes/matrix)를 반환한다', async () => {
    const dataset = validDataset();
    const fetchMock = stubFetch(dataset);

    const graph = await loadChaseGraph();

    expect(graph.ids).toEqual(dataset.ids);
    expect(graph.nodes).toEqual(dataset.nodes);
    expect(graph.matrix).toBe(dataset.matrix);
    // manifest.json + chase-graph.json?v=<hash> — 해시 버스팅 쿼리 부착 확인.
    expect(fetchMock).toHaveBeenCalledWith('/data/manifest.json');
    expect(fetchMock).toHaveBeenCalledWith('/data/chase-graph.json?v=abcdef12');
  });

  it('두 번째 호출은 캐시를 재사용한다(fetch 재발생 없음)', async () => {
    const fetchMock = stubFetch(validDataset());

    const a = await loadChaseGraph();
    const callsAfterFirst = fetchMock.mock.calls.length;
    const b = await loadChaseGraph();

    expect(b).toBe(a);
    expect(fetchMock.mock.calls.length).toBe(callsAfterFirst);
  });

  it('동시 호출은 같은 in-flight 프라미스를 공유한다', async () => {
    stubFetch(validDataset());

    const [a, b] = await Promise.all([loadChaseGraph(), loadChaseGraph()]);
    expect(a).toBe(b);
  });

  it('manifest fetch 실패는 치명적이지 않다 — 버전 쿼리 없이 chase-graph.json을 그대로 fetch', async () => {
    const dataset = validDataset();
    const fetchMock = stubFetch(dataset, false);

    const graph = await loadChaseGraph();

    expect(graph.ids).toEqual(dataset.ids);
    expect(fetchMock).toHaveBeenCalledWith('/data/chase-graph.json');
  });

  it('chase-graph.json 응답 실패는 throw하고 캐시하지 않는다(재시도 가능)', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url.includes('manifest.json')) {
        return Promise.resolve({ ok: false, json: () => Promise.resolve({}) });
      }
      return Promise.resolve({ ok: false, status: 500 });
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(loadChaseGraph()).rejects.toThrow(/chase-graph\.json fetch failed/);

    const dataset = validDataset();
    stubFetch(dataset, false);
    const retried = await loadChaseGraph();
    expect(retried.ids).toEqual(dataset.ids);
  });

  it('스키마 위반 응답은 zod 파싱 에러로 throw한다', async () => {
    stubFetch({ nodes: {}, ids: [] }); // schemaVersion/builtAt/matrix 누락

    await expect(loadChaseGraph()).rejects.toThrow();
  });
});
