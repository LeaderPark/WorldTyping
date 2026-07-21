import { beforeEach, describe, expect, it } from 'vitest';
import type { RunResult } from '@wt/shared';
import { useSessionStore } from './session';

const SAMPLE_RESULT: RunResult = {
  cpm: 300,
  acc: 0.95,
  pi: 270,
  grade: 'A',
  completed: true,
  baseScore: 1000,
  accFactor: 0.9025,
  comboFactor: 1.1,
  timeBonus: 50,
  finalScore: 1041,
};

describe('session store', () => {
  beforeEach(() => {
    useSessionStore.getState().reset();
  });

  it('starts idle with no countries assigned', () => {
    const s = useSessionStore.getState();
    expect(s.phase).toBe('idle');
    expect(s.countryIds).toEqual([]);
    expect(s.currentIndex).toBe(0);
    expect(s.result).toBeNull();
  });

  it('startRun assigns the run and moves to countdown', () => {
    useSessionStore.getState().startRun('continent', 'asia', ['KR', 'JP'], null);
    const s = useSessionStore.getState();
    expect(s.phase).toBe('countdown');
    expect(s.mode).toBe('continent');
    expect(s.trackId).toBe('asia');
    expect(s.countryIds).toEqual(['KR', 'JP']);
    expect(s.currentIndex).toBe(0);
  });

  it('setCurrentIndex advances on country transitions only', () => {
    useSessionStore.getState().startRun('worldtour', 'world', ['KR', 'JP', 'CN'], null);
    useSessionStore.getState().setCurrentIndex(1);
    expect(useSessionStore.getState().currentIndex).toBe(1);
  });

  it('finish records the result once and moves to finished', () => {
    useSessionStore.getState().startRun('tier', 't1', ['KR'], 3);
    useSessionStore.getState().finish(SAMPLE_RESULT);
    const s = useSessionStore.getState();
    expect(s.phase).toBe('finished');
    expect(s.result).toEqual(SAMPLE_RESULT);
  });

  it('abort moves to aborted phase', () => {
    useSessionStore.getState().startRun('tier', 't1', ['KR'], 3);
    useSessionStore.getState().abort();
    expect(useSessionStore.getState().phase).toBe('aborted');
  });

  it('reset restores idle defaults', () => {
    useSessionStore.getState().startRun('daily', 'd1', ['KR'], null);
    useSessionStore.getState().setPractice(true);
    useSessionStore.getState().reset();
    const s = useSessionStore.getState();
    expect(s.phase).toBe('idle');
    expect(s.practice).toBe(false);
    expect(s.countryIds).toEqual([]);
  });
});
