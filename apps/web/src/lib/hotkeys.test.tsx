// @vitest-environment jsdom
import { act, render } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { useHotkeys } from './hotkeys';

function fireKeydown(key: string) {
  window.dispatchEvent(new KeyboardEvent('keydown', { key, cancelable: true }));
}

function Probe({ onEsc }: { onEsc: () => void }) {
  useHotkeys({ Escape: onEsc });
  return null;
}

describe('useHotkeys', () => {
  it('invokes the mapped handler on matching keydown', () => {
    const onEsc = vi.fn();
    render(<Probe onEsc={onEsc} />);

    act(() => fireKeydown('Escape'));
    expect(onEsc).toHaveBeenCalledTimes(1);

    act(() => fireKeydown('a'));
    expect(onEsc).toHaveBeenCalledTimes(1);
  });

  it('does not register a listener when the map is empty', () => {
    const addSpy = vi.spyOn(window, 'addEventListener');
    function Empty() {
      useHotkeys({});
      return null;
    }
    render(<Empty />);
    expect(addSpy).not.toHaveBeenCalledWith('keydown', expect.anything());
    addSpy.mockRestore();
  });

  it('always calls the latest callback even if the map object is recreated each render', () => {
    const calls: number[] = [];
    function Counter() {
      const [n, setN] = useState(0);
      useHotkeys({ Enter: () => calls.push(n) });
      return (
        <button type="button" data-testid="bump" onClick={() => setN((v) => v + 1)}>
          {n}
        </button>
      );
    }
    const { getByTestId } = render(<Counter />);
    act(() => getByTestId('bump').click());
    act(() => getByTestId('bump').click());
    act(() => fireKeydown('Enter'));
    expect(calls).toEqual([2]);
  });
});
