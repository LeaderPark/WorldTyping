// spec: docs/07 WT-M2-03 acceptance(임시 라우트 /dev/typing — 프로덕션 빌드 제외), §2.8·§2.10 #1.
//       [작업 특이 조정] 이 라우트는 import.meta.env.DEV에서만 router children에 합류한다(main.tsx).
//
// 리드 육안 확인용 진단 하니스: 실제 컨트롤러→렌더러 파이프라인을 조립해 "가나" 도깨비불 무오타,
// "몽골" 음절 전이, 별칭("한국") 캐노니컬 동결을 눈으로 볼 수 있게 한다. 자동 검증은
// prompt-renderer.test.ts / PromptArea.test.tsx가 담당한다. 프로덕션 번들에는 포함되지 않는다.
import { useEffect, useMemo, useState } from 'react';
import {
  GameSessionEngine,
  continentRules,
  type EngineDeps,
} from '@wt/engine';
import type { Country } from '@wt/shared';
import { getBootData } from '../../app/bootLoader';
import { HiddenTypingInput } from '../../features/typing/HiddenTypingInput';
import { PromptArea } from '../../features/typing/PromptArea';
import { useGameClock } from '../../features/typing/useGameClock';
import { useTypingEngine } from '../../features/typing/useTypingEngine';

// 데모 커리큘럼: 도깨비불(가나), 3음절(몽골), 별칭 보유(대한민국="한국"/"남한"), 영문 대비(미국/프랑스).
const DEMO_IDS = ['GH', 'MN', 'KR', 'US', 'FR'];

function devDeps(): EngineDeps {
  return {
    now: () => performance.now(),
    schedule: (cb, ms) => {
      const id = setTimeout(cb, ms);
      return () => clearTimeout(id);
    },
    // 데모는 라이프/제한 없는 대륙 규칙을 빌려 무한정 타이핑을 관찰한다.
    rules: continentRules(),
  };
}

export function TypingDevPage() {
  const [lang, setLang] = useState<'ko' | 'en'>('ko');
  const [index, setIndex] = useState(0);
  const [phase, setPhase] = useState('idle');

  const countries = useMemo<Country[]>(() => {
    const dataset = getBootData().countries.countries;
    const byId = new Map(dataset.map((c) => [c.id, c] as const));
    return DEMO_IDS.map((id) => byId.get(id)).filter((c): c is Country => c !== undefined);
  }, []);

  const engine = useMemo(
    () => new GameSessionEngine(devDeps(), countries, lang),
    [countries, lang],
  );

  const { inputRef, focusInput, controller, getInputValue } = useTypingEngine(engine);
  const { bindTimerEl, bindGaugeEl } = useGameClock(engine);

  // 엔진 이벤트 → 컨트롤러 국가 세팅 + 현재 인덱스/페이즈 반영. 세션 시작.
  useEffect(() => {
    setIndex(0);
    const unsub = engine.subscribe((e) => {
      if (e.type === 'countryShown') {
        setIndex(e.index);
        controller?.setCountry(countries[e.index]!);
      } else if (e.type === 'phase') {
        setPhase(e.phase);
      }
    });
    engine.start();
    return () => {
      unsub();
      engine.abort();
    };
  }, [engine, controller, countries]);

  const current = countries[index];
  if (!current) return <p style={{ padding: 24 }}>countries dataset not loaded</p>;

  return (
    <div style={{ padding: 24, fontFamily: 'sans-serif' }} onClick={focusInput}>
      <h1 style={{ fontSize: 20, fontWeight: 700 }}>/dev/typing — 타이핑 렌더러 하니스 (DEV)</h1>
      <p style={{ opacity: 0.7, fontSize: 13 }}>
        도깨비불 "가나": ㄱ→가→간→가나 를 쳐도 오타(적색) 표시가 없어야 한다. "대한민국"은 "한국"만
        쳐도 캐노니컬 채색이 동결되고 하단 에코에 실입력이 뜬다.
      </p>

      <div style={{ margin: '12px 0', display: 'flex', gap: 8, alignItems: 'center' }}>
        <button type="button" onClick={() => setLang('ko')} aria-pressed={lang === 'ko'}>
          한국어
        </button>
        <button type="button" onClick={() => setLang('en')} aria-pressed={lang === 'en'}>
          English
        </button>
        <span data-testid="dev-phase" style={{ marginLeft: 12, opacity: 0.7 }}>
          phase: {phase} · {index + 1}/{countries.length}
        </span>
        <span ref={bindTimerEl} style={{ marginLeft: 12, fontVariantNumeric: 'tabular-nums' }} />
      </div>

      <div
        style={{
          fontSize: 48,
          fontWeight: 800,
          minHeight: 80,
          display: 'flex',
          alignItems: 'center',
          gap: 16,
        }}
      >
        <PromptArea
          country={current}
          lang={lang}
          controller={controller}
          getInputValue={getInputValue}
          juiceLevel={2}
        >
          <span
            ref={bindGaugeEl}
            aria-hidden
            style={{ display: 'inline-block', height: 4, background: '#38bdf8', width: '100%' }}
          />
        </PromptArea>
      </div>

      <HiddenTypingInput inputRef={inputRef} />
    </div>
  );
}

export { TypingDevPage as Component };
