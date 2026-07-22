// spec: docs/06 §9.1(카드 구성: 대륙 지도+등급 스탬프+닉네임/PI/CPM/ACC/시간+로고), docs/00 §11-D52-⑦
//       (IG 캔버스 재렌더는 이 OG 레이아웃을 재사용 — M6-02로 이연), docs/01 §1.3/§13.2·D50(브랜드
//       색은 장식·지도 fill 전용, 텍스트 원색 직접 사용 금지), WT-M6-02
//
// OG 결과 카드의 레이아웃 상수 단일 원천. Worker 의존(satori/wasm/D1)이 전혀 없는 순수 상수·순수
// 함수만 둔다 — D52-⑦의 클라 IG 캔버스 재렌더가 나중에 "이 파일만" 재사용(또는 packages/shared로
// 승격)해 OG와 픽셀 동형인 이미지를 그릴 수 있게 하기 위한 분리다. render.ts(Worker 전용)는 이
// 상수를 소비만 한다.
import type { Continent } from "@wt/shared";

export const OG_WIDTH = 1200;
export const OG_HEIGHT = 630;

/** 지도 캔버스 영역(카드 내부 좌표, px). 나머지 공간이 헤더/스탯 패널. */
export const OG_MAP = { x: 40, y: 92, w: 1120, h: 396 } as const;

/** og-maps.json의 기준 뷰포트(geo-index.ts와 동일). */
export const OG_MAP_VIEWBOX: [number, number] = [960, 500];

/** 카드 팔레트(다크 고정 — OG 미리보기는 뷰어 테마와 무관하게 항상 다크 브랜드로). */
export const OG_COLORS = {
  bg0: "#0b1220",
  bg1: "#111c33",
  panel: "#0e1830",
  land: "#243352",
  landStroke: "#33456b",
  text: "#f8fafc",
  subtext: "#94a3b8",
  route: "#38bdf8",
  node: "#e2e8f0",
  nodeStart: "#38bdf8",
  logo: "#38bdf8",
} as const;

/** 등급 스탬프 색(장식 전용 — D50). S=금, 이하 등급 하강. */
export const GRADE_COLORS: Record<string, string> = {
  S: "#fbbf24",
  A: "#a78bfa",
  B: "#60a5fa",
  C: "#34d399",
  D: "#94a3b8",
};

/** 대륙별 노선 강조색(장식 전용 — D50). 지정 밖은 기본 route 색. */
export const CONTINENT_ROUTE_COLORS: Record<Continent, string> = {
  asia: "#f472b6",
  europe: "#60a5fa",
  africa: "#fbbf24",
  "north-america": "#34d399",
  "south-america": "#f87171",
  oceania: "#22d3ee",
};

const CONTINENT_LABEL: Record<Continent, { ko: string; en: string }> = {
  asia: { ko: "아시아", en: "Asia" },
  europe: { ko: "유럽", en: "Europe" },
  africa: { ko: "아프리카", en: "Africa" },
  "north-america": { ko: "북아메리카", en: "North America" },
  "south-america": { ko: "남아메리카", en: "South America" },
  oceania: { ko: "오세아니아", en: "Oceania" },
};

/** modeKey → 사람이 읽는 노선 라벨(ko/en). 국가명은 여기 쓰지 않는다(카드는 지도로만 노선 표시). */
export function routeLabel(modeKey: string, lang: "ko" | "en"): string {
  if (modeKey.startsWith("continent:")) {
    const cont = modeKey.slice("continent:".length) as Continent;
    const l = CONTINENT_LABEL[cont];
    return l ? l[lang] : cont;
  }
  if (modeKey === "worldtour") return lang === "ko" ? "세계일주" : "World Tour";
  if (modeKey.startsWith("tier:")) {
    const t = modeKey.slice("tier:".length);
    return lang === "ko" ? `티어 ${t} 서바이벌` : `Tier ${t} Survival`;
  }
  if (modeKey.startsWith("daily:")) return lang === "ko" ? "데일리 챌린지" : "Daily Challenge";
  return modeKey;
}

/** 정확도(acc_milli = ACC×1000) → 표시용 백분율 문자열(소수 1자리). */
export function formatAccuracy(accMilli: number): string {
  return `${(accMilli / 10).toFixed(1)}%`;
}

/** elapsedMs → "M:SS" (분:초). */
export function formatElapsed(elapsedMs: number): string {
  const totalSec = Math.round(elapsedMs / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}
