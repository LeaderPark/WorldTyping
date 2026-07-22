// @vitest-environment jsdom
// spec: docs/06 §10-4, WT-M6-06
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { AppProviders } from '../../app/providers';
import { ErrorPage } from './index';

describe('ErrorPage', () => {
  afterEach(() => cleanup());

  it('renders the generic error heading + optional detail + a link back home', () => {
    render(
      <AppProviders>
        <MemoryRouter>
          <ErrorPage detail="500 Internal Server Error" />
        </MemoryRouter>
      </AppProviders>,
    );

    expect(screen.getByTestId('error-page')).toBeInTheDocument();
    expect(screen.getByText('500 Internal Server Error')).toBeInTheDocument();
    expect(screen.getByTestId('error-page-home')).toHaveAttribute('href', '/');
  });

  it('renders without a detail paragraph when none is given', () => {
    render(
      <AppProviders>
        <MemoryRouter>
          <ErrorPage />
        </MemoryRouter>
      </AppProviders>,
    );

    expect(screen.getByTestId('error-page')).toBeInTheDocument();
  });
});
