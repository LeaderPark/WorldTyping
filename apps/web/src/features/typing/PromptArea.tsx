// spec: docs/03 §2.8(렌더러 마운트 지점), §4.2(PromptArea = FlagIcon + PromptRenderer + TimeLimitGauge
//       슬롯), §4.5(고빈도 값 React 미경유). WT-M2-03.
//
// 렌더러(PromptRenderer)의 마운트 지점이자 컨트롤러 이벤트 → 채색 브리지. 국가 전환(저빈도)에만
// 리렌더하고, 키스트로크 단위 채색은 renderer가 DOM을 직접 갱신한다(React 커밋 0회). 국기 아이콘은
// flag-icons 스프라이트(M5) 도입 전까지 flagEmoji로 대체하되, 마크업 자리(FlagIcon 슬롯)는 고정한다.
import { useEffect, useRef } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import type { Country } from '@wt/shared';
import type { TypingInputController } from '@wt/engine';
import { PromptRenderer, type JuiceLevel } from './prompt-renderer';
import { promptAdvanceEm } from './prompt-advance';
import { FlagIcon } from '../../components/FlagIcon';

export interface PromptAreaProps {
  country: Country;
  lang: 'ko' | 'en';
  /** useTypingEngine이 노출한 컨트롤러(채색 이벤트 소스). 부착 전 null. */
  controller: TypingInputController | null;
  /** 0=끔, 1/2=팝·셰이크 on(reduced-motion 시 0). 기본 2. */
  juiceLevel?: JuiceLevel;
  /** 별칭 에코 라인에 쓸 실입력 원문 접근자(고빈도 값 — state 미경유). */
  getInputValue?: () => string;
  /** TimeLimitGauge 슬롯(서바이벌/티어/데일리 모드) — 활주로(__runway) 위에 오버레이된다. */
  children?: ReactNode;
}

export function PromptArea({
  country,
  lang,
  controller,
  juiceLevel = 2,
  getInputValue,
  children,
}: PromptAreaProps) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const rendererRef = useRef<PromptRenderer | null>(null);
  const getInputValueRef = useRef<(() => string) | undefined>(getInputValue);
  getInputValueRef.current = getInputValue;

  // 렌더러 인스턴스는 컴포넌트 수명 동안 1개. 언마운트 시 정리(타이머·DOM).
  useEffect(() => {
    const renderer = new PromptRenderer();
    rendererRef.current = renderer;
    return () => {
      renderer.unmount();
      rendererRef.current = null;
    };
  }, []);

  // 국가/언어 전환 시 재마운트(자모 경계 재계산). 저빈도(국가당 1회).
  useEffect(() => {
    const el = mountRef.current;
    const renderer = rendererRef.current;
    if (!el || !renderer) return;
    renderer.mount(el, country, lang);
    renderer.setJuiceLevel(juiceLevel);
    // juiceLevel은 아래 별도 effect가 반영한다 — 여기 deps엔 국가/언어만 두어 국가 전환에만 remount.
  }, [country, lang]);

  useEffect(() => {
    rendererRef.current?.setJuiceLevel(juiceLevel);
  }, [juiceLevel]);

  // 컨트롤러 이벤트 → 채색. progress/miss는 update(+miss는 shake), exact는 update+pop.
  useEffect(() => {
    if (!controller) return;
    const unsub = controller.subscribe((e) => {
      const renderer = rendererRef.current;
      if (!renderer) return;
      const raw = getInputValueRef.current?.() ?? '';
      switch (e.type) {
        case 'progress':
          renderer.update(e.detail, e.rawValue);
          break;
        case 'miss':
          renderer.update(e.detail, raw);
          renderer.shake();
          break;
        case 'exact':
          renderer.update(e.detail, raw);
          renderer.pop();
          break;
        default:
          break; // bulkInsert/blur/latin/skip/refocus는 표시 계층 무관
      }
    });
    return unsub;
  }, [controller]);

  const name = lang === 'ko' ? country.nameKo : country.nameEn;
  // [D77] 고정 폭 칼럼 내 국가명 폰트 fit용 진행폭(em). 국가 전환(저빈도) 리렌더에서만 재계산 —
  // 키스트로크 경로 무관(§4.5). CSS가 `100cqw/var(--wt-prompt-adv)`로 최장명을 한 줄에 수납한다.
  const promptAdv = promptAdvanceEm(name, lang);

  return (
    <div className="wt-prompt-area" data-testid="prompt-area">
      <FlagIcon
        id={country.id}
        emoji={country.flagEmoji}
        label={name}
        size="lg"
        className="wt-prompt-area__flag"
        testId="prompt-flag"
      />

      {/* WT-DC-10(B안): 프롬프트 칼럼 = 글리프 마운트 + 활주로. 렌더러/testid/게이지 계약은 불변이고,
          여기 마크업은 순수 표시 크롬이다(고빈도 값 미경유). */}
      <div
        className="wt-prompt-area__col"
        style={{ '--wt-prompt-adv': promptAdv } as CSSProperties}
      >
        <div ref={mountRef} className="wt-prompt-area__glyphs" data-testid="prompt-mount" />
        {/* 상시 활주로 대시 라인(wt-dash). 게이지(children)가 있으면 이 안에 절대 위치로 오버레이된다
            (bindGaugeEl 계약·TimeLimitGauge 마크업 불변). */}
        <div className="wt-prompt-area__runway">{children}</div>
      </div>
    </div>
  );
}
