// spec: docs/01 §9.1(이모지 그리드 포맷 예시), docs/06 §2.3("shareText 필드로 서버가 생성 —
//       포맷 단일화 목적, 클라 조작 여지 제거 목적이 아니다"), docs/00 §7 gotcha 7(도메인 미확정,
//       PUBLIC_ORIGIN만), WT-M5-04
//
// 데일리 결과 공유 텍스트(Wordle식 스포일러 프리 이모지 그리드) 생성. perCountry는 클라 제출값을
// 그대로 쓴다 — §2.3 원문이 밝히듯 이 텍스트는 신뢰 판정 대상이 아니라 포맷 통일이 목적이고,
// 점수/등급(cpm/accMilli/pi/grade)만 서버 재계산값(run-verify.ts ServerValues)을 사용한다.
//
// [칸 의미 — 이 구현이 채택한 해석] docs/01 §9.1 예시("🟩×8 🟨×1 🟩×1, 9/10 완주")는 칸 개수와
// "9/10"이 산술적으로 맞아떨어지지 않아(문서 예시 특유의 산술 오차 — docs/00 §11 D27·D36과 동류)
// 색상별 의미가 별도로 명문화돼 있지 않다. 데일리는 라이프 1 서바이벌 변형(§7 표 — 스킵/타임아웃
// 즉시 라이프 0 → 즉시 종료)이므로 이 구현은:
//   🟩 = 해당 국가 완주(errors=0) · 🟨 = 완주했으나 오타 있음(errors>0) · 🟥 = 스킵/타임아웃
//   또는 그 시점에 판이 끝나 도달하지 못한 칸(라이프 0 이후 잔여 칸은 전부 🟥로 채운다)
// 을 채택한다 — 최종 보고 escalations에 리드 확인을 요청한다.
export interface PerCountryShareInput {
  errors: number;
  skipped: boolean;
}

export interface DailyShareTextOpts {
  dailyNo: number;
  lang: "ko" | "en";
  /** 오늘 데일리 세트 총 국가 수(서버가 토큰에서 재현한 fullSet.length — 클라 값이 아니다). */
  totalCountries: number;
  perCountry: readonly PerCountryShareInput[];
  cpm: number;
  accMilli: number;
  pi: number;
  grade: string;
  /** 확정 도메인이 생기면(§7 gotcha 7) Env.PUBLIC_ORIGIN으로 전달 — 없으면 상대 경로("/daily")만. */
  publicOrigin?: string;
}

function buildGrid(perCountry: readonly PerCountryShareInput[], total: number): string {
  const squares: string[] = [];
  for (let i = 0; i < total; i++) {
    const p = perCountry[i];
    if (!p || p.skipped) {
      squares.push("🟥"); // 스킵/타임아웃 또는 그 이후 미도달 칸(조기 종료).
    } else if (p.errors > 0) {
      squares.push("🟨");
    } else {
      squares.push("🟩");
    }
  }
  return squares.join("");
}

function shareLink(publicOrigin: string | undefined): string {
  if (!publicOrigin) return "/daily";
  return `${publicOrigin.replace(/\/$/, "")}/daily`;
}

/** 데일리 결과 공유 텍스트(§2.3) 생성 — runs.ts의 submit 응답에 그대로 실린다. */
export function buildDailyShareText(o: DailyShareTextOpts): string {
  const grid = buildGrid(o.perCountry, o.totalCountries);
  const cleared = o.perCountry.filter((p) => !p.skipped).length;
  const link = shareLink(o.publicOrigin);
  const accuracyPct = (o.accMilli / 10).toFixed(1);
  const cpmInt = Math.max(0, Math.round(o.cpm));
  const piInt = Math.round(o.pi);

  if (o.lang === "en") {
    return [
      `WORLD TYPING Daily #${o.dailyNo}`,
      `${grid}  ${cleared}/${o.totalCountries} cleared`,
      `⚡ ${cpmInt}cpm · 🎯 ${accuracyPct}% · PI ${piInt} (${o.grade})`,
      link,
    ].join("\n");
  }
  return [
    `WORLD TYPING 데일리 #${o.dailyNo}`,
    `${grid}  ${cleared}/${o.totalCountries} 완주`,
    `⚡ ${cpmInt}타 · 🎯 ${accuracyPct}% · PI ${piInt} (${o.grade})`,
    link,
  ].join("\n");
}
