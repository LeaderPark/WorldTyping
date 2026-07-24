// @vitest-environment jsdom
// spec: docs/00 §11-D68-⑨, footer-ref.png, WT-AUTH-06
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { AppProviders } from '../app/providers';
import { SiteFooter } from './SiteFooter';

afterEach(() => cleanup());

function renderFooter() {
  return render(
    <AppProviders>
      <MemoryRouter>
        <SiteFooter />
      </MemoryRouter>
    </AppProviders>,
  );
}

describe('SiteFooter', () => {
  it('renders the three legal links pointing at /privacy, /terms, /support', () => {
    renderFooter();
    expect(screen.getByTestId('site-footer')).toBeInTheDocument();
    expect(screen.getByTestId('footer-link-privacy')).toHaveAttribute('href', '/privacy');
    expect(screen.getByTestId('footer-link-terms')).toHaveAttribute('href', '/terms');
    expect(screen.getByTestId('footer-link-support')).toHaveAttribute('href', '/support');
  });

  it('renders a copyright line with the current year and TypeTrip', () => {
    renderFooter();
    const year = String(new Date().getFullYear());
    const copyright = screen.getByTestId('site-footer').textContent ?? '';
    expect(copyright).toContain(year);
    expect(copyright).toContain('TypeTrip');
  });
});
