// spec: docs/09-chase-mode-goldrunner.md §7.6(이벤트 시퀀스 연출 4종)·§7 헤더(juice/reduced-motion
//       강등표), docs/00 §11-D96·D67, WT-CH-07.
//
// GamePage(mode=chase, WT-CH-08 소관)가 마운트하는 소비자 훅 — sequences.ts(4종 타임라인)를
// engine/globe 생명주기에 배선하고, 플로팅 텍스트/체포 오버레이를 그릴 오버레이 DOM의 ref를
// 반환한다. CH-08은 이 ref를 CandidateCallouts의 `.wt-candidate-overlay`와 같은 스테이지 안에
// 절대 위치 형제 div로 붙이면 된다(예: `<div ref={layerRef} className="wt-chase-fx" />`).
//
// [reduced-motion 해석 — GamePage/index.tsx와 동일 공식, 최종 보고 기재] 이 훅은 pages/GamePage
// 파일을 수정할 수 없으므로(CH-08 소유) settings 스토어 + prefers-reduced-motion을 직접 재평가한다
// — GamePage가 mapHandle.setJuiceLevel에 넘기는 것과 완전히 동일한 불리언 공식이라(둘 다 같은
// 전역 상태에서 파생) 실제로는 항상 GlobeMap의 juice 상태와 일치한다(동기화 불필요 — 같은 입력,
// 같은 함수 = 같은 출력).
import { useEffect, useMemo, useRef } from 'react';
import type { RefCallback } from 'react';
import type { ChaseSessionEngine } from '@wt/engine';
import type { Country } from '@wt/shared';
import { useSettingsStore } from '../../stores/settings';
import type { GlobeChaseHandle } from '../map/globe/globe-chase';
import { getChaseAudio, type ChaseAudio } from './chase-audio';
import { createChaseSequences } from './sequences';

export interface UseChaseJuiceOptions {
  lang: 'ko' | 'en';
  /** 국가명 해석 원천 — engine 생성 시 넘긴 것과 동일 배열(countries.json 원천, CLAUDE.md 규약). */
  countries: readonly Country[];
  /** 체포 시퀀스 종료 알림(선택) — §7.6 "2,800ms 결과 카드 슬라이드 인" 참고용. 엔진 phase는
   *  arrested 즉시 'finished'로 전이하므로 결과 화면 표시 자체는 이 콜백 없이도 정상 동작한다. */
  onArrestComplete?: () => void;
  /** 테스트 전용 오버라이드 — 기본은 getChaseAudio()(공유 SoundManager). */
  audio?: ChaseAudio;
  /** 테스트 전용 오버라이드 — 기본은 settings.reducedMotion('auto'면 matchMedia) 해석. */
  reducedOverride?: boolean;
}

export interface UseChaseJuiceResult {
  /** CH-08이 절대 위치 오버레이 div에 붙일 ref(플로팅 텍스트·체포 풀스크린 연출 마운트 지점). */
  layerRef: RefCallback<HTMLDivElement>;
}

function systemPrefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

export function useChaseJuice(
  engine: ChaseSessionEngine,
  globe: GlobeChaseHandle,
  opts: UseChaseJuiceOptions,
): UseChaseJuiceResult {
  const layerElRef = useRef<HTMLDivElement | null>(null);
  const layerRef = useMemo<RefCallback<HTMLDivElement>>(
    () => (el) => {
      layerElRef.current = el;
    },
    [],
  );

  // opts는 매 렌더 최신값을 ref에 미러링한다 — 아래 effect는 engine/globe 동일성에만 반응(다른
  // chase 훅들과 동일 "마운트 상수" 관례, countries/lang은 실사용상 런 중 불변)하지만, onArrestComplete/
  // reducedOverride/audio는 호출부가 매 렌더 새 클로저를 넘겨도(흔한 React 패턴) sequences.ts가
  // 항상 최신 값을 참조하도록 ref 경유로 읽는다(리렌더로 인한 effect 재실행·재구독 없이도 정확성
  // 확보 — controller.dispose()/재구독 비용 없이 최신성만 얻는 표준 패턴).
  const optsRef = useRef(opts);
  optsRef.current = opts;

  useEffect(() => {
    const controller = createChaseSequences({
      engine,
      globe,
      audio: optsRef.current.audio ?? getChaseAudio(),
      countries: optsRef.current.countries,
      lang: optsRef.current.lang,
      getLayer: () => layerElRef.current,
      isReduced: () => {
        const override = optsRef.current.reducedOverride;
        if (override !== undefined) return override;
        const setting = useSettingsStore.getState().reducedMotion;
        return setting === 'auto' ? systemPrefersReducedMotion() : setting;
      },
      onArrestComplete: () => optsRef.current.onArrestComplete?.(),
    });

    return () => controller.dispose();
    // engine/globe만 의존 — countries/lang은 마운트 상수 취급(CandidateCallouts.tsx/
    // use-chase-engine.ts와 동일 관례), audio/reducedOverride/onArrestComplete는 위 optsRef를 통해
    // 매 호출 시점 최신값을 읽으므로 재구독이 불필요하다. 이 프로젝트는 react-hooks/exhaustive-deps를
    // 활성화하지 않는다(eslintrc 확인 — CandidateCallouts.tsx 헤더와 동일 근거, disable 주석 불요).
  }, [engine, globe]);

  return { layerRef };
}
