// spec: 디자인 정본 A3(종이비행기 마스코트) — L62~72(홈 히어로, blush)·L337~345(카운트다운)·
//       L402~410(매칭). viewBox 0 0 64 40. WT-DC-01.
//
// 순수 장식 일러스트(항상 aria-hidden). 색은 일러스트 고유색이라 디자인 리터럴을 그대로 쓴다
// (CLAUDE.md "마스코트 일러스트 고유색 예외" — tokens 미참조). 꼬리날개만 tail prop으로 노선/모드
// 억센트 색(대륙색·등급색 등)을 호출부가 주입한다. bob=true면 .wt-mascot--bob(globals.css)를 걸어
// 상하 부유하며, reduced-motion에서 정지한다(globals.css). 부유 속도는 조상 요소가 --wt-bob-dur로
// 오버라이드한다(홈 2.6s 기본 / 매칭 1.4s — 디자인 L62·L402). 높이는 width에서 viewBox 비율
// (64:40)로 계산해 리플로우 없이 고정한다(§3.6).
export interface MascotProps {
  /** SVG 렌더 폭(px). 높이는 viewBox 비율(64:40)로 자동 계산된다. */
  width: number;
  /** 꼬리날개 색(노선/모드 억센트) — 대륙색·등급색 등 호출부가 지정. */
  tail: string;
  /** 볼터치 2점 렌더 여부(기본 false — 홈 히어로 등 말랑한 맥락에서만 켠다). */
  blush?: boolean;
  /** 상하 부유 애니메이션(.wt-mascot--bob) 적용 여부(기본 false). */
  bob?: boolean;
}

export function Mascot({ width, tail, blush = false, bob = false }: MascotProps) {
  const height = (width * 40) / 64;
  return (
    <svg
      width={width}
      height={height}
      viewBox="0 0 64 40"
      aria-hidden="true"
      {...(bob ? { className: 'wt-mascot--bob' } : {})}
    >
      {/* 동체 */}
      <path
        d="M6 22 Q4 18 10 17 L44 14 Q56 13 60 20 Q61 23 56 24 L14 27 Q8 27 6 22 Z"
        fill="#ffffff"
        stroke="#c9cec0"
        strokeWidth="1.5"
      />
      {/* 꼬리날개(억센트) */}
      <path d="M44 15 L48 6 Q49 4 52 5 L54 6 L52 16 Z" fill={tail} />
      {/* 날개 */}
      <path
        d="M22 25 L14 33 Q13 35 17 34 L30 27 Z"
        fill="#eceee6"
        stroke="#c9cec0"
        strokeWidth="1"
      />
      {/* 눈 2 */}
      <circle cx="30" cy="20" r="2.4" fill="#171b19" />
      <circle cx="40" cy="19" r="2.4" fill="#171b19" />
      {/* 입 */}
      <path
        d="M32.5 24 Q35 26.5 38 23.5"
        fill="none"
        stroke="#171b19"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
      {/* 볼터치 2(blush 전용) */}
      {blush ? (
        <>
          <circle cx="26" cy="23.5" r="1.6" fill="#f5b8ba" />
          <circle cx="43.5" cy="22.5" r="1.6" fill="#f5b8ba" />
        </>
      ) : null}
    </svg>
  );
}
