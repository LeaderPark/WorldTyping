// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useSwr } from './swr';

describe('useSwr', () => {
  it('fetches on first mount and exposes the result', async () => {
    const fetcher = vi.fn().mockResolvedValue({ hello: 'world' });
    const { result } = renderHook(() => useSwr('key-a', fetcher));

    expect(result.current.isLoading).toBe(true);
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.data).toEqual({ hello: 'world' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('serves cached data without refetching while fresh', async () => {
    const fetcher = vi.fn().mockResolvedValue({ n: 1 });
    const first = renderHook(() => useSwr('key-b', fetcher, 60_000));
    await waitFor(() => expect(first.result.current.isLoading).toBe(false));

    const second = renderHook(() => useSwr('key-b', fetcher, 60_000));
    await waitFor(() => expect(second.result.current.data).toEqual({ n: 1 }));

    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('captures fetcher errors without throwing', async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error('boom'));
    const { result } = renderHook(() => useSwr('key-c', fetcher));

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.error).toBeInstanceOf(Error);
    expect(result.current.data).toBeNull();
  });

  it('mutate() forces a manual revalidation', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce({ v: 1 }).mockResolvedValueOnce({ v: 2 });
    const { result } = renderHook(() => useSwr('key-d', fetcher));
    await waitFor(() => expect(result.current.data).toEqual({ v: 1 }));

    await act(async () => {
      await result.current.mutate();
    });

    expect(result.current.data).toEqual({ v: 2 });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('does nothing when key is null', async () => {
    const fetcher = vi.fn();
    const { result } = renderHook(() => useSwr(null, fetcher));
    expect(result.current.isLoading).toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
