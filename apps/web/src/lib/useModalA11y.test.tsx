// @vitest-environment jsdom
// spec: docs/03 §7.3(모달 focus trap + inert + ESC + 트리거 복귀), WT-M5-02
import { useRef } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useModalA11y } from './useModalA11y';

afterEach(() => cleanup());

function Harness({ open }: { open: boolean }) {
  const ref = useRef<HTMLDivElement | null>(null);
  useModalA11y(ref, open);
  return (
    <div>
      <button data-testid="outside-trigger">outside</button>
      <div id="app-root">
        <button data-testid="outside-sibling">sibling</button>
        {open && (
          <div ref={ref} role="dialog" aria-modal="true" data-testid="dialog">
            <button data-testid="dialog-first">first</button>
            <button data-testid="dialog-last">last</button>
          </div>
        )}
      </div>
    </div>
  );
}

describe('useModalA11y', () => {
  it('moves focus into the dialog and inerts the rest of the tree while open', () => {
    render(<Harness open />);
    expect(document.activeElement).toBe(screen.getByTestId('dialog-first'));
    expect(screen.getByTestId('outside-sibling')).toHaveAttribute('inert');
  });

  it('traps Tab focus within the dialog (wraps last -> first)', async () => {
    const user = userEvent.setup();
    render(<Harness open />);
    screen.getByTestId('dialog-last').focus();
    await user.tab();
    expect(document.activeElement).toBe(screen.getByTestId('dialog-first'));
  });

  it('traps Shift+Tab (wraps first -> last)', async () => {
    const user = userEvent.setup();
    render(<Harness open />);
    screen.getByTestId('dialog-first').focus();
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(screen.getByTestId('dialog-last'));
  });

  it('restores focus to the trigger and removes inert on close', () => {
    const trigger = document.createElement('button');
    document.body.appendChild(trigger);
    trigger.focus();

    const { rerender } = render(<Harness open={false} />);
    // 트리거가 이미 포커스된 상태에서 모달을 연다.
    trigger.focus();
    rerender(<Harness open />);
    expect(document.activeElement).toBe(screen.getByTestId('dialog-first'));

    rerender(<Harness open={false} />);
    expect(screen.getByTestId('outside-sibling')).not.toHaveAttribute('inert');
    document.body.removeChild(trigger);
  });
});
