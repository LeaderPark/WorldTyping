// spec: docs/03 §4.3("TanStack Query 미도입 — 자체 SWR 유틸 ~40줄"), WT-M2-05
//
// TanStack Query 등 데이터 라이브러리 추가 금지(작업 블록 제약) — 이 ~40줄이 대체품이다.
// 모듈 스코프 Map 캐시 + staleMs 검사만 하는 최소 SWR. 리더보드 등 저빈도 fetch 전용이며
// 고빈도 값에는 절대 쓰지 않는다(§4.5).

import { useCallback, useEffect, useRef, useState } from 'react';

interface CacheEntry<T> {
  data: T;
  fetchedAt: number;
}

const cache = new Map<string, CacheEntry<unknown>>();

export interface SwrResult<T> {
  data: T | null;
  error: unknown;
  isLoading: boolean;
  mutate: () => Promise<void>;
}

export function useSwr<T>(key: string | null, fetcher: () => Promise<T>, staleMs = 60_000): SwrResult<T> {
  const initial = key ? (cache.get(key) as CacheEntry<T> | undefined) : undefined;
  const [data, setData] = useState<T | null>(initial?.data ?? null);
  const [error, setError] = useState<unknown>(null);
  const [isLoading, setIsLoading] = useState(false);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const revalidate = useCallback(async () => {
    if (!key) return;
    setIsLoading(true);
    try {
      const result = await fetcherRef.current();
      cache.set(key, { data: result, fetchedAt: Date.now() });
      setData(result);
      setError(null);
    } catch (err) {
      setError(err);
    } finally {
      setIsLoading(false);
    }
  }, [key]);

  useEffect(() => {
    if (!key) return;
    const entry = cache.get(key) as CacheEntry<T> | undefined;
    if (entry) setData(entry.data);
    if (!entry || Date.now() - entry.fetchedAt > staleMs) void revalidate();
  }, [key, staleMs, revalidate]);

  return { data, error, isLoading, mutate: revalidate };
}
