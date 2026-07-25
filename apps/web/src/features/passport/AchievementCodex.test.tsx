// @vitest-environment jsdom
//
// spec: docs/01 §9.2, docs/03 §7.3(a11y), WT-PASSPORT-DEV-1
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppProviders } from '../../app/providers';
import { useSettingsStore } from '../../stores/settings';
import { AchievementCodex } from './AchievementCodex';
import { ACHIEVEMENTS_CATALOG, achievementI18nKey } from './achievements-catalog';

function renderCodex(unlocked: readonly string[]) {
  return render(
    <AppProviders>
      <AchievementCodex unlockedIds={new Set(unlocked)} />
    </AppProviders>,
  );
}

describe('AchievementCodex', () => {
  beforeEach(() => {
    useSettingsStore.getState().setLang('ko');
  });
  afterEach(cleanup);

  it('달성 여부와 무관하게 24종을 항상 전부 렌더한다(도감)', () => {
    renderCodex([]);
    expect(screen.getByTestId('passport-achievements').children).toHaveLength(24);
    for (const entry of ACHIEVEMENTS_CATALOG) {
      expect(screen.getByTestId(`passport-achievement-ach:${entry.id}`)).toBeInTheDocument();
    }
  });

  it('미달성은 locked 클래스, 달성은 unlocked 클래스로 전환된다', () => {
    renderCodex(['first_flight', 'night_owl']);

    const unlockedCard = screen.getByTestId('passport-achievement-ach:first_flight');
    expect(unlockedCard.className).toContain('wt-achv--unlocked');
    expect(unlockedCard.className).not.toContain('wt-achv--locked');
    expect(unlockedCard.dataset.unlocked).toBe('true');

    const lockedCard = screen.getByTestId('passport-achievement-ach:perfect_run');
    expect(lockedCard.className).toContain('wt-achv--locked');
    expect(lockedCard.className).not.toContain('wt-achv--unlocked');
    expect(lockedCard.dataset.unlocked).toBe('false');
  });

  it('미달성에서도 이름·조건 문구가 그대로 노출된다(숨김 업적 없음 — §9.2/§9.3)', () => {
    renderCodex([]);
    const card = screen.getByTestId('passport-achievement-ach:perfect_run');
    expect(card.querySelector('.wt-achv__name')?.textContent).toBe('무결점 입국');
    expect(card.querySelector('.wt-achv__desc')?.textContent).toBe('오타 0으로 완주');
    // "???" 마스킹 없음
    expect(card.textContent).not.toContain('???');
  });

  it('진행 카운트는 달성 수/총 24를 보여준다', () => {
    renderCodex(['first_flight', 'first_win', 'daily_7']);
    expect(screen.getByTestId('passport-achievements-count').textContent).toContain('3/24');
  });

  it('빈 달성이면 0/24', () => {
    renderCodex([]);
    expect(screen.getByTestId('passport-achievements-count').textContent).toContain('0/24');
  });

  it('달성 여부를 색·필터가 아닌 텍스트로도 전달한다(sr-only)', () => {
    renderCodex(['first_flight']);
    expect(
      screen.getByTestId('passport-achievement-ach:first_flight').querySelector('.sr-only')
        ?.textContent,
    ).toBe('달성함');
    expect(
      screen.getByTestId('passport-achievement-ach:perfect_run').querySelector('.sr-only')
        ?.textContent,
    ).toBe('미달성');
  });

  it('아이콘은 aria-hidden(스크린리더 낭독 대상 아님)', () => {
    renderCodex([]);
    const icon = screen
      .getByTestId('passport-achievement-ach:first_flight')
      .querySelector('.wt-achv__icon');
    expect(icon?.getAttribute('aria-hidden')).toBe('true');
    expect(icon?.textContent).toBe(ACHIEVEMENTS_CATALOG[0]!.icon);
  });

  it('영어 카탈로그에서도 이름/조건이 번역된다(하드코딩 문자열 없음)', () => {
    useSettingsStore.getState().setLang('en');
    renderCodex([]);
    const card = screen.getByTestId('passport-achievement-ach:first_flight');
    expect(card.querySelector('.wt-achv__name')?.textContent).toBe('First Flight');
    // 키가 그대로 노출되면(번역 누락) 실패한다.
    expect(card.textContent).not.toContain(achievementI18nKey('first_flight', 'name'));
  });
});
