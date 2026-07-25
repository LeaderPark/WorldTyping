// @vitest-environment jsdom
//
// spec: docs/09 §7.3·§8.5(포커스 스트립), docs/09a §6, WT-CH-06 acceptance("FocusStrip 포커스 복구").
import { useCallback, useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { TypingInputController } from '@wt/engine';
import { AppProviders } from '../../app/providers';
import { FocusStrip } from './FocusStrip';

function Harness() {
  const [controller, setController] = useState<TypingInputController | null>(null);
  const inputRef = useCallback((el: HTMLInputElement | null) => {
    if (!el) return;
    const c = new TypingInputController(el, 'ko');
    c.attach();
    setController(c);
  }, []);
  return (
    <AppProviders>
      <FocusStrip inputRef={inputRef} controller={controller} />
    </AppProviders>
  );
}

afterEach(() => cleanup());

describe('FocusStrip — 실 <input>은 HiddenTypingInput 재사용(§7.3)', () => {
  it('HiddenTypingInput(hidden-typing-input testid)을 마운트한다', () => {
    render(<Harness />);
    expect(screen.getByTestId('hidden-typing-input')).toBeInTheDocument();
  });

  it('초기 상태는 active(포커스 이탈 아님)', () => {
    render(<Harness />);
    expect(screen.getByTestId('chase-focus-strip')).toHaveAttribute('data-state', 'active');
  });

  it('컨트롤러가 blurred를 방출하면 lost 상태 + 복귀 안내 텍스트를 보여준다', () => {
    render(<Harness />);
    const input = screen.getByTestId('hidden-typing-input');
    fireEvent.blur(input);
    const strip = screen.getByTestId('chase-focus-strip');
    expect(strip).toHaveAttribute('data-state', 'lost');
    expect(strip.className).toContain('wt-focus-strip--lost');
    // 언어는 환경(navigator.language)에 따라 ko/en 어느 쪽이든 결정될 수 있다 — 여기서는 실제
    // i18n 카탈로그 값(하드코딩 문자열이 아님)이 렌더됐는지만 확인한다.
    expect(screen.getByRole('status')).toHaveTextContent(/클릭하여 복귀|Tap to resume/);
  });

  it('재포커스(refocused)되면 active로 복귀하고 안내 텍스트가 사라진다', () => {
    render(<Harness />);
    const input = screen.getByTestId('hidden-typing-input');
    fireEvent.blur(input);
    expect(screen.getByTestId('chase-focus-strip')).toHaveAttribute('data-state', 'lost');

    fireEvent.focus(input);
    expect(screen.getByTestId('chase-focus-strip')).toHaveAttribute('data-state', 'active');
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('controller가 아직 null(부착 전)이어도 예외 없이 렌더된다', () => {
    expect(() =>
      render(
        <AppProviders>
          <FocusStrip inputRef={() => {}} controller={null} />
        </AppProviders>,
      ),
    ).not.toThrow();
  });
});
