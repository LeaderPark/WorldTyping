// @vitest-environment jsdom
// spec: docs/06 §10-4, WT-M6-06
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { AppProviders } from '../../app/providers';
import { NotFoundPage } from './index';

describe('NotFoundPage', () => {
  afterEach(() => cleanup());

  it('renders the off-route heading, body copy, and a link back home', () => {
    render(
      <AppProviders>
        <MemoryRouter initialEntries={['/this-does-not-exist']}>
          <NotFoundPage />
        </MemoryRouter>
      </AppProviders>,
    );

    expect(screen.getByTestId('not-found-page')).toBeInTheDocument();
    const heading = screen.getByRole('heading', { level: 1 });
    expect(heading.textContent).not.toBe('');
    const home = screen.getByTestId('not-found-home');
    expect(home).toHaveAttribute('href', '/');
  });
});
