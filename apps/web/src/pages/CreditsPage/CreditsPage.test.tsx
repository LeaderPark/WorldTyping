// @vitest-environment jsdom
// spec: docs/02 §2, docs/06 §10-8, WT-M6-06
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { AppProviders } from '../../app/providers';
import { CreditsPage } from './index';

describe('CreditsPage', () => {
  afterEach(() => cleanup());

  it('lists all three license notices (ODbL/Natural Earth/flag-icons) with links + the disputed-territory notice', () => {
    render(
      <AppProviders>
        <MemoryRouter>
          <CreditsPage />
        </MemoryRouter>
      </AppProviders>,
    );

    const list = screen.getByTestId('credits-list');
    expect(list.textContent).toContain('ODbL');
    expect(list.textContent).toContain('Natural Earth');
    expect(list.textContent).toContain('flag-icons');

    const links = list.querySelectorAll('a[href^="http"]');
    expect(links.length).toBe(3);

    expect(screen.getByTestId('credits-disputed-notice')).toBeInTheDocument();
    expect(screen.getByTestId('credits-back')).toHaveAttribute('href', '/');
  });
});
