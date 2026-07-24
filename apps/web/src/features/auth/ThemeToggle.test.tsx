// @vitest-environment jsdom
//
// spec: docs/00 §11-D68-⑥(기어=테마 토글)·D57 + WT-AUTH-03.
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppProviders } from '../../app/providers';
import { useSettingsStore } from '../../stores/settings';
import { ThemeToggle } from './ThemeToggle';

function renderToggle() {
  return render(
    <AppProviders>
      <ThemeToggle />
    </AppProviders>,
  );
}

describe('ThemeToggle (WT-AUTH-03)', () => {
  beforeEach(() => {
    useSettingsStore.getState().setLang('en');
    useSettingsStore.getState().setTheme('light');
  });
  afterEach(() => cleanup());

  it('light 테마에서는 aria-pressed=false, 클릭 시 dark로 전환된다', () => {
    renderToggle();
    const btn = screen.getByTestId('theme-toggle');
    expect(btn).toHaveAttribute('aria-pressed', 'false');

    act(() => btn.click());
    expect(useSettingsStore.getState().theme).toBe('dark');
    expect(btn).toHaveAttribute('aria-pressed', 'true');

    act(() => btn.click());
    expect(useSettingsStore.getState().theme).toBe('light');
    expect(btn).toHaveAttribute('aria-pressed', 'false');
  });

  it('접근성 레이블(aria-label)을 가진다', () => {
    renderToggle();
    expect(screen.getByTestId('theme-toggle')).toHaveAttribute('aria-label');
  });
});
