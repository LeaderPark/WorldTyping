// @vitest-environment jsdom
// spec: docs/06 §10-2(SEO), WT-M6-06
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { AppProviders } from '../../app/providers';
import { DailyPage } from './index';

describe('DailyPage', () => {
  afterEach(() => cleanup());

  it('renders a heading + CTA linking into the actual daily play route (/play/daily/:date)', () => {
    render(
      <AppProviders>
        <MemoryRouter>
          <DailyPage />
        </MemoryRouter>
      </AppProviders>,
    );

    expect(screen.getByTestId('daily-page')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1 }).textContent).not.toBe('');

    const cta = screen.getByTestId('daily-page-cta');
    const isoDateToday = new Date().toISOString().slice(0, 10);
    expect(cta).toHaveAttribute('href', `/play/daily/${isoDateToday}`);
  });
});
