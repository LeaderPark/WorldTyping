// @vitest-environment jsdom
//
// spec: docs/00 §11-D64(국기 SVG 자산), WT-UI-03. FlagIcon의 src 매핑·onError 이모지 폴백·
// 장식/라벨 접근성 분기를 단위 검증한다.
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { FlagIcon } from './FlagIcon';

afterEach(() => cleanup());

describe('FlagIcon', () => {
  it('ISO2 id를 소문자 /flags/{cc}.svg로 매핑해 img로 렌더한다', () => {
    render(<FlagIcon id="KR" emoji="🇰🇷" label="대한민국" />);
    const img = screen.getByTestId('flag-icon') as HTMLImageElement;
    expect(img.tagName).toBe('IMG');
    expect(img.getAttribute('src')).toBe('/flags/kr.svg');
    expect(img.getAttribute('alt')).toBe('대한민국');
  });

  it('label 미지정 시 장식(aria-hidden, alt 비움)으로 렌더한다', () => {
    render(<FlagIcon id="JP" emoji="🇯🇵" />);
    const img = screen.getByTestId('flag-icon');
    expect(img.getAttribute('aria-hidden')).toBe('true');
    expect(img.getAttribute('alt')).toBe('');
  });

  it('onError 시 1회 이모지 폴백으로 전환한다', () => {
    render(<FlagIcon id="KR" emoji="🇰🇷" label="대한민국" />);
    const img = screen.getByTestId('flag-icon');
    fireEvent.error(img);
    const fallback = screen.getByTestId('flag-icon');
    expect(fallback.tagName).toBe('SPAN');
    expect(fallback.getAttribute('data-fallback')).toBe('emoji');
    expect(fallback.textContent).toBe('🇰🇷');
  });

  it('testId 오버라이드로 기존 계약(prompt-flag)을 유지할 수 있다', () => {
    render(<FlagIcon id="US" emoji="🇺🇸" label="미국" testId="prompt-flag" />);
    expect(screen.getByTestId('prompt-flag').getAttribute('src')).toBe('/flags/us.svg');
  });
});
