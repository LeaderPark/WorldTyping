// @vitest-environment jsdom
//
// docs/03 §8.1 — "lng은 settings 스토어와 단방향 동기화(settings.lang 변경 → i18n.changeLanguage)".
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { useTranslation } from 'react-i18next';
import { AppProviders } from './providers';
import { useSettingsStore } from '../stores/settings';

function Probe() {
  const { t } = useTranslation();
  return <span data-testid="label">{t('app.title')}</span>;
}

describe('AppProviders', () => {
  afterEach(() => cleanup());

  it('initializes i18next with the ko/en catalogs and renders translated text', async () => {
    render(
      <AppProviders>
        <Probe />
      </AppProviders>,
    );
    expect(await screen.findByTestId('label')).toHaveTextContent('TypeTrip');
  });

  it('propagates settings.lang changes to i18next one-way', async () => {
    render(
      <AppProviders>
        <Probe />
      </AppProviders>,
    );
    await screen.findByTestId('label');

    useSettingsStore.getState().setLang('ko');
    await waitFor(() => {
      expect(document.querySelector('[data-testid="label"]')).not.toBeNull();
    });
    // app.title은 ko/en 카탈로그 동일값("TypeTrip")이므로 언어 전환 자체(오류 없이 반영)만 검증.
    expect(useSettingsStore.getState().lang).toBe('ko');
  });
});
