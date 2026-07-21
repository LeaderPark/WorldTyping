// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { useMetaStore } from './meta';

describe('meta store', () => {
  beforeEach(() => {
    localStorage.clear();
    useMetaStore.getState().reset();
  });

  it('starts with no streak/achievements/stamps', () => {
    const s = useMetaStore.getState();
    expect(s.streakCount).toBe(0);
    expect(s.lastPlayedDateKST).toBeNull();
    expect(s.bestPI).toBeNull();
    expect(s.unlockedAchievements).toEqual([]);
  });

  it('recordPlay starts a streak of 1 on first play', () => {
    useMetaStore.getState().recordPlay('2026-07-21');
    expect(useMetaStore.getState().streakCount).toBe(1);
    expect(useMetaStore.getState().lastPlayedDateKST).toBe('2026-07-21');
  });

  it('recordPlay increments the streak on consecutive KST days', () => {
    useMetaStore.getState().recordPlay('2026-07-21');
    useMetaStore.getState().recordPlay('2026-07-22');
    expect(useMetaStore.getState().streakCount).toBe(2);
  });

  it('recordPlay resets the streak when a day is skipped', () => {
    useMetaStore.getState().recordPlay('2026-07-21');
    useMetaStore.getState().recordPlay('2026-07-23');
    expect(useMetaStore.getState().streakCount).toBe(1);
  });

  it('recordPlay is a no-op when called twice for the same day', () => {
    useMetaStore.getState().recordPlay('2026-07-21');
    useMetaStore.getState().recordPlay('2026-07-21');
    expect(useMetaStore.getState().streakCount).toBe(1);
  });

  it('setBestPI only increases, never decreases', () => {
    useMetaStore.getState().setBestPI(200);
    useMetaStore.getState().setBestPI(150);
    expect(useMetaStore.getState().bestPI).toBe(200);
    useMetaStore.getState().setBestPI(300);
    expect(useMetaStore.getState().bestPI).toBe(300);
  });

  it('unlockAchievement is idempotent', () => {
    useMetaStore.getState().unlockAchievement('first-win');
    useMetaStore.getState().unlockAchievement('first-win');
    expect(useMetaStore.getState().unlockedAchievements).toEqual(['first-win']);
  });

  it('addStamp records a route/mode key', () => {
    useMetaStore.getState().addStamp('continent:asia');
    expect(useMetaStore.getState().stamps['continent:asia']).toBe(true);
  });

  it('persists under wt:meta', () => {
    useMetaStore.getState().setBestPI(400);
    const raw = localStorage.getItem('wt:meta');
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw as string).state.bestPI).toBe(400);
  });
});
