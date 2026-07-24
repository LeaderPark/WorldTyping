// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('settings store', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.resetModules();
  });

  it('generates and persists a stable guestId under wt:did', async () => {
    const { useSettingsStore } = await import('./settings');
    const id1 = useSettingsStore.getState().guestId;
    expect(id1).toMatch(/^[0-9a-f-]{36}$/i);
    expect(localStorage.getItem('wt:did')).toBe(id1);
  });

  it('reuses the same guestId across module reloads (idempotent)', async () => {
    const mod1 = await import('./settings');
    const id1 = mod1.useSettingsStore.getState().guestId;

    vi.resetModules();
    const mod2 = await import('./settings');
    const id2 = mod2.useSettingsStore.getState().guestId;

    expect(id2).toBe(id1);
  });

  it('setLang updates state and marks the language gate as chosen', async () => {
    const { useSettingsStore, hasChosenLanguage } = await import('./settings');
    expect(hasChosenLanguage()).toBe(false);

    useSettingsStore.getState().setLang('en');

    expect(useSettingsStore.getState().lang).toBe('en');
    expect(localStorage.getItem('wt:lang')).toBe('en');
    expect(hasChosenLanguage()).toBe(true);
  });

  it('setTheme updates state and mirrors wt:theme for the FOUC snippet', async () => {
    const { useSettingsStore } = await import('./settings');
    useSettingsStore.getState().setTheme('light');
    expect(useSettingsStore.getState().theme).toBe('light');
    expect(localStorage.getItem('wt:theme')).toBe('light');
  });

  it('defaults theme to light (docs/00 §11-D57 — docs/01 §13.2 "다크 기본" 개정)', async () => {
    const { useSettingsStore } = await import('./settings');
    expect(useSettingsStore.getState().theme).toBe('light');
  });

  it('setVolume merges partial updates', async () => {
    const { useSettingsStore } = await import('./settings');
    useSettingsStore.getState().setVolume({ sfx: 0.3 });
    expect(useSettingsStore.getState().volume).toEqual({ master: 0.8, sfx: 0.3, bgm: 0.5 });
  });

  it('setGhostMode toggles the self-best ghost preference (default off)', async () => {
    const { useSettingsStore } = await import('./settings');
    expect(useSettingsStore.getState().ghostMode).toBe(false);
    useSettingsStore.getState().setGhostMode(true);
    expect(useSettingsStore.getState().ghostMode).toBe(true);
  });

  it('persists state under the wt:settings key', async () => {
    const { useSettingsStore } = await import('./settings');
    // [§11-D88] nickname 필드는 폐지 — 다른 저빈도 설정으로 persist 동작을 검증한다.
    useSettingsStore.getState().setGhostMode(true);
    const raw = localStorage.getItem('wt:settings');
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw as string).state.ghostMode).toBe(true);
  });
});
