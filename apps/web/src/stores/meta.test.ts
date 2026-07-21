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

  describe('recordRun (WT-M2-07 — ModeSelectPage/TrackSelectPage 최고 기록)', () => {
    it('완주 런은 stamp를 남기고 trackBests/bestPI/streak을 함께 갱신한다', () => {
      useMetaStore.getState().recordRun({
        mode: 'continent',
        trackId: 'asia',
        dateKST: '2026-07-21',
        pi: 388,
        grade: 'A',
        timeMs: 202_000,
        score: 48_220,
        completed: true,
      });
      const s = useMetaStore.getState();
      expect(s.stamps['continent:asia']).toBe(true);
      expect(s.trackBests['continent:asia']).toEqual({
        grade: 'A',
        timeMs: 202_000,
        score: 48_220,
        completed: true,
      });
      expect(s.bestPI).toBe(388);
      expect(s.streakCount).toBe(1);
    });

    it('미완주(라이프 소진) 런은 trackBests만 남기고 stamp는 남기지 않는다(§10.2 "진행 중" 신호)', () => {
      useMetaStore.getState().recordRun({
        mode: 'tier',
        trackId: '3',
        dateKST: '2026-07-21',
        pi: 250,
        grade: 'D',
        timeMs: 40_000,
        score: 1200,
        completed: false,
      });
      const s = useMetaStore.getState();
      expect(s.stamps['tier:3']).toBeUndefined();
      expect(s.trackBests['tier:3']?.completed).toBe(false);
    });

    it('더 낮은 점수의 재도전은 기존 최고 기록을 덮어쓰지 않는다', () => {
      useMetaStore.getState().recordRun({
        mode: 'continent', trackId: 'europe', dateKST: '2026-07-21',
        pi: 400, grade: 'S', timeMs: 160_000, score: 60_000, completed: true,
      });
      useMetaStore.getState().recordRun({
        mode: 'continent', trackId: 'europe', dateKST: '2026-07-22',
        pi: 200, grade: 'C', timeMs: 300_000, score: 10_000, completed: true,
      });
      expect(useMetaStore.getState().trackBests['continent:europe']?.score).toBe(60_000);
      expect(useMetaStore.getState().trackBests['continent:europe']?.grade).toBe('S');
    });

    it('더 높은 점수의 재도전은 기존 최고 기록을 덮어쓴다', () => {
      useMetaStore.getState().recordRun({
        mode: 'continent', trackId: 'oceania', dateKST: '2026-07-21',
        pi: 200, grade: 'C', timeMs: 300_000, score: 10_000, completed: true,
      });
      useMetaStore.getState().recordRun({
        mode: 'continent', trackId: 'oceania', dateKST: '2026-07-22',
        pi: 400, grade: 'S', timeMs: 160_000, score: 60_000, completed: true,
      });
      expect(useMetaStore.getState().trackBests['continent:oceania']?.score).toBe(60_000);
    });
  });

  describe('recordWorldtourProgress (§10.2 "최고: {location} 도달")', () => {
    it('더 깊은 인덱스면 갱신한다', () => {
      useMetaStore.getState().recordWorldtourProgress({
        index: 5, countryId: 'MX', nameKo: '멕시코', nameEn: 'Mexico',
      });
      expect(useMetaStore.getState().worldtourFurthest?.countryId).toBe('MX');

      useMetaStore.getState().recordWorldtourProgress({
        index: 23, countryId: 'EG', nameKo: '이집트', nameEn: 'Egypt',
      });
      expect(useMetaStore.getState().worldtourFurthest?.countryId).toBe('EG');
    });

    it('더 얕은(작은) 인덱스는 기존 최고 도달지를 덮어쓰지 않는다', () => {
      useMetaStore.getState().recordWorldtourProgress({
        index: 23, countryId: 'EG', nameKo: '이집트', nameEn: 'Egypt',
      });
      useMetaStore.getState().recordWorldtourProgress({
        index: 5, countryId: 'MX', nameKo: '멕시코', nameEn: 'Mexico',
      });
      expect(useMetaStore.getState().worldtourFurthest?.countryId).toBe('EG');
    });
  });
});
