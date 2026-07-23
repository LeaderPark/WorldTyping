// spec: 이 태스크 지시문(WT-UI-01) — "장식용 인라인 SVG(대륙 6색 저채도 아크+도트, aria-hidden,
// 정적)". docs/00 §11-D50(브랜드 색은 장식·지도 fill 전용 — 텍스트 아님)과 정확히 이 용도다.
//
// 순수 장식(정보를 전달하지 않음) → aria-hidden="true" + focusable="false"로 스크린리더/키보드
// 순회에서 완전히 제외한다(docs/03 §7.3 "지도 SVG는 aria-hidden(정보 중복)"과 같은 원칙). 정적
// SVG(애니메이션 없음, pointer-events 없음)라 juice/reduced-motion 설정과도 무관하다.
//
// 화면 부착(어느 페이지가 실제로 이 컴포넌트를 렌더할지 — 예: 홈 히어로 배경, 로비 배경 등)은
// 후속 태스크 소관이다. 이 컴포넌트는 정의만 제공한다.

import type { CSSProperties } from 'react';

/** 대륙 6색 CSS 변수(tokens.css) — 지도 fill과 동일한 원색을 그대로 쓴다(D50: 장식 용도는
 *  원색 허용, 텍스트 파생 토큰은 불필요). */
const CONTINENT_COLOR_VARS = [
  'var(--continent-asia)',
  'var(--continent-europe)',
  'var(--continent-africa)',
  'var(--continent-north-america)',
  'var(--continent-south-america)',
  'var(--continent-oceania)',
] as const;

export interface RouteMotifBackdropProps {
  /** 컨테이너에 위치·크기를 맡기기 위한 추가 클래스(예: absolute inset-0). */
  className?: string;
  style?: CSSProperties;
}

/**
 * 대륙 6색 저채도 아크(노선 궤적을 연상시키는 완만한 곡선)와 도트(정차역)로 구성된 정적 장식
 * 백드롭. 어떤 실제 데이터도 렌더하지 않는다 — 순수 시각 텍스처(카드/히어로 뒤에 옅게 깔리는
 * 배경용, WT-UI-01 §2.3 전역 컴포넌트군과 함께 도입).
 */
export function RouteMotifBackdrop({ className, style }: RouteMotifBackdropProps) {
  return (
    <svg
      className={className}
      style={{ pointerEvents: 'none', ...style }}
      viewBox="0 0 640 360"
      preserveAspectRatio="xMidYMid slice"
      aria-hidden="true"
      focusable="false"
      data-testid="route-motif-backdrop"
    >
      {/* 아크 6개 — 대륙별 반지름/중심을 살짝씩 어긋나게 해 겹치는 "노선망" 느낌만 낸다. */}
      <g fill="none" strokeWidth={2.5} strokeLinecap="round" opacity={0.16}>
        {CONTINENT_COLOR_VARS.map((color, i) => {
          const r = 90 + i * 34;
          const cx = 70 + i * 14;
          const cy = 30 + i * 8;
          return (
            <path
              key={color}
              d={`M ${cx - r} ${cy + r * 0.35} A ${r} ${r} 0 0 1 ${cx + r} ${cy + r * 0.35}`}
              stroke={color}
            />
          );
        })}
      </g>
      {/* 도트 — "정차역" 느낌의 작은 원, 아크와 겹치지 않는 하단대에 흩뿌린다. */}
      <g opacity={0.22}>
        {CONTINENT_COLOR_VARS.map((color, i) => (
          <circle key={color} cx={50 + i * 100} cy={310 - (i % 2) * 46} r={5} fill={color} />
        ))}
      </g>
    </svg>
  );
}
