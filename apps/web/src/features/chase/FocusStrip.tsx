// spec: docs/09-chase-mode-goldrunner.md §7.3(입력창 = 포커스 스트립)·§8.5(포커스 스트립 해부도),
//       docs/09a-chase-ui-ux-globe-centric.md §6, docs/03 §2(IME 입력 계층 — 절대 무수정)·§4.5,
//       docs/00 §11-D90~D97, WT-CH-06.
//
// 하단 6px 금색 포커스 스트립. 실제 <input>은 IME value-snapshot 계약(§03-2) 때문에 반드시 존재
// 해야 하므로 기존 HiddenTypingInput을 그대로 재사용한다(신설·개조 금지) — 조합 중 텍스트의 가시
// 채널은 이 컴포넌트가 아니라 CandidateCallouts의 콜아웃 슬롯 에코가 담당한다(§7.3). 이 컴포넌트가
// 렌더하는 것은 (1) HiddenTypingInput 마운트 지점 (2) 6px 금색 라인 + 커서 점멸 (3) 포커스 이탈 시
// 적색 점멸 + 복귀 안내뿐이다.
//
// [포커스 이탈 감지] TypingInputController가 이미 blur/focus를 구독해 'blurred'/'refocused'
// TypingEvent로 방출한다(input-controller.ts attach() — 무수정 재사용). 이 컴포넌트는 그 이벤트를
// 구독만 한다. 저빈도(창 blur/focus 빈도)라 React state로 들어도 §4.5 위반이 아니다(고빈도 값인
// 입력 버퍼/에코와는 무관).
import { useEffect, useState } from 'react';
import type { RefCallback } from 'react';
import { useTranslation } from 'react-i18next';
import type { TypingInputController } from '@wt/engine';
import { HiddenTypingInput } from '../typing/HiddenTypingInput';

export interface FocusStripProps {
  /** useChaseEngine()이 반환한 inputRef — HiddenTypingInput에 그대로 전달. */
  inputRef: RefCallback<HTMLInputElement>;
  /** useChaseEngine()이 반환한 controller — 포커스 이탈/복귀 감지용(부착 전 null). */
  controller: TypingInputController | null;
}

export function FocusStrip({ inputRef, controller }: FocusStripProps) {
  const { t } = useTranslation();
  const [lostFocus, setLostFocus] = useState(false);

  useEffect(() => {
    if (!controller) return;
    return controller.subscribe((e) => {
      if (e.type === 'blurred') setLostFocus(true);
      else if (e.type === 'refocused') setLostFocus(false);
    });
  }, [controller]);

  return (
    <div
      className={`wt-focus-strip${lostFocus ? ' wt-focus-strip--lost' : ''}`}
      data-testid="chase-focus-strip"
      data-state={lostFocus ? 'lost' : 'active'}
    >
      <HiddenTypingInput inputRef={inputRef} retainFocus />
      <div className="wt-focus-strip__line" aria-hidden="true" />
      {lostFocus && (
        <span className="wt-focus-strip__hint" role="status">
          {t('chase.strip.focusLost')}
        </span>
      )}
    </div>
  );
}
