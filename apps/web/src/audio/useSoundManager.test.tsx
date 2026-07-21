// @vitest-environment jsdom
//
// spec: docs/03 §8.2, WT-M2-07. useSoundManager 자체는 얇은 배선이므로 SoundManager 내부 재생은
// sound-manager.test.ts가 커버하고, 여기서는 "controller가 없으면 바인딩하지 않고, 생기면
// bind()하고, 언마운트/교체 시 해제한다"는 배선 계약만 검증한다.
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GameSessionEngine, TypingInputController } from '@wt/engine';
import { useSoundManager } from './useSoundManager';

const bind = vi.fn(() => vi.fn());
const getSoundManager = vi.fn(() => ({ bind }));

vi.mock('./sound-manager', () => ({
  getSoundManager: (...args: unknown[]) => getSoundManager(...(args as [])),
}));

function Probe({ controller }: { controller: TypingInputController | null }) {
  useSoundManager({} as GameSessionEngine, controller);
  return null;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('useSoundManager', () => {
  it('controller가 null이면 bind()를 호출하지 않는다', () => {
    render(<Probe controller={null} />);
    expect(bind).not.toHaveBeenCalled();
  });

  it('controller가 주어지면 getSoundManager().bind(engine, controller)를 호출한다', () => {
    const controller = {} as TypingInputController;
    render(<Probe controller={controller} />);
    expect(getSoundManager).toHaveBeenCalledTimes(1);
    expect(bind).toHaveBeenCalledWith({}, controller);
  });

  it('언마운트 시 bind()가 반환한 해제 함수를 호출한다', () => {
    const unsub = vi.fn();
    bind.mockReturnValueOnce(unsub);
    const controller = {} as TypingInputController;
    const { unmount } = render(<Probe controller={controller} />);
    unmount();
    expect(unsub).toHaveBeenCalledTimes(1);
  });
});
