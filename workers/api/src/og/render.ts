// spec: docs/06 §9.1(1200×630 PNG: 완성 노선 대륙 지도+등급 스탬프+닉네임/PI/CPM/ACC/시간+로고,
//       런타임 topojson 파싱 금지 → og-maps.json 사전 추출 소비, 렌더 실패 시 정적 폴백·500 금지),
//       docs/00 §11-D46(Pretendard 서브셋 TTF)·D52-⑦(레이아웃 상수 layout.ts 분리), WT-M6-02
//
// workers-og(satori + resvg-wasm)로 결과 카드를 PNG로 렌더한다. Workers 네이티브 호환이 최우선이라
// workers-og를 채택했다(satori+@resvg/resvg-wasm 직접 조합 대신 — 채택 근거는 최종 보고 notes).
// 폰트는 빌드 시 생성한 Pretendard 서브셋(base64 → Uint8Array)을 쓴다.
//
// [주의] workers-og는 `.wasm`을 ES import로 가져오는데(Workers 네이티브 방식) node 런타임에서는
// 이 import가 해석되지 않는다. index.test.ts는 루트 vitest의 node 프로젝트에서 index.ts →
// routes/share.ts → 이 파일을 정적으로 로드하므로, workers-og를 **동적 import**로 미뤄 렌더가
// 실제 호출될 때만(workerd에서만) 로드되게 한다(node 정적 로드 회귀 방지). 동적 import 스펙은
// 리터럴이라 wrangler/esbuild가 번들에 정적 포함 → workerd 런타임에서 정상 로드된다.
import type { Continent, CountryId } from "@wt/shared";
import { pretendardSubsetTtf } from "./fonts/pretendard-og-subset";
import ogMapsJson from "./og-maps.json";
import {
  OG_WIDTH,
  OG_HEIGHT,
  OG_MAP,
  OG_COLORS,
  GRADE_COLORS,
  CONTINENT_ROUTE_COLORS,
  routeLabel,
  formatAccuracy,
  formatElapsed,
} from "./layout";

interface OgMaps {
  viewBox: [number, number];
  continents: Record<Continent, string>;
  continentBounds: Record<Continent, [number, number, number, number]>;
  centroids: Record<CountryId, [number, number]>;
}
const OG_MAPS = ogMapsJson as unknown as OgMaps;
const CONTINENTS: Continent[] = ["asia", "europe", "africa", "north-america", "south-america", "oceania"];

export interface ShareCardData {
  nickname: string;
  modeKey: string;
  lang: "ko" | "en";
  grade: string;
  pi: number;
  cpm: number;
  accMilli: number;
  elapsedMs: number;
  /** 완성 노선 국가 코드(방문 순서). detail_json의 perCountry(비스킵)에서 뽑는다. */
  countryCodes: CountryId[];
}

// 폰트 버퍼는 모듈 1회 디코드(렌더마다 재디코드 방지 — CPU 예산).
let FONT: Uint8Array | null = null;
function fontBytes(): Uint8Array {
  if (!FONT) FONT = pretendardSubsetTtf();
  return FONT;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;",
  );
}

/** modeKey에서 대륙을 뽑는다(대륙 모드만). 그 외는 null(세계 지도 사용). */
function continentOf(modeKey: string): Continent | null {
  if (!modeKey.startsWith("continent:")) return null;
  const c = modeKey.slice("continent:".length) as Continent;
  return CONTINENTS.includes(c) ? c : null;
}

/** 노선 라인 d 문자열: 노드를 순서대로 잇되 날짜변경선 교차 세그먼트(|dx|>480)는 새 서브패스로 끊는다. */
function routePathD(nodes: readonly [number, number][]): string {
  if (nodes.length === 0) return "";
  const parts: string[] = [];
  let penDown = false;
  for (let i = 0; i < nodes.length; i++) {
    const [x, y] = nodes[i]!;
    if (!penDown) {
      parts.push(`M${x} ${y}`);
      penDown = true;
      continue;
    }
    const prev = nodes[i - 1]!;
    if (Math.abs(x - prev[0]) > 480) {
      parts.push(`M${x} ${y}`); // 래핑 세그먼트는 그리지 않음(연결선 생략)
    } else {
      parts.push(`L${x} ${y}`);
    }
  }
  return parts.join(" ");
}

/** 결과 지도 SVG를 만든다(배경 land + 완성 노선 + 노드). data URI로 카드 <img>에 실린다. */
function buildMapSvg(data: ShareCardData): string {
  const cont = continentOf(data.modeKey);
  const land = cont ? OG_MAPS.continents[cont] : CONTINENTS.map((c) => OG_MAPS.continents[c]).join(" ");

  // 뷰박스: 대륙 모드는 해당 대륙 bbox에 여백을 준다. 그 외는 전체 960×500.
  let vb: [number, number, number, number];
  if (cont) {
    const [x0, y0, x1, y1] = OG_MAPS.continentBounds[cont];
    const padX = (x1 - x0) * 0.08 + 8;
    const padY = (y1 - y0) * 0.08 + 8;
    vb = [x0 - padX, y0 - padY, x1 - x0 + padX * 2, y1 - y0 + padY * 2];
  } else {
    vb = [0, 0, OG_MAPS.viewBox[0], OG_MAPS.viewBox[1]];
  }

  const routeColor = cont ? (CONTINENT_ROUTE_COLORS[cont] ?? OG_COLORS.route) : OG_COLORS.route;
  const nodes = data.countryCodes
    .map((code) => OG_MAPS.centroids[code])
    .filter((p): p is [number, number] => Array.isArray(p));
  const vbW = vb[2];
  const r = Math.max(1.2, vbW / 150);
  const routeD = routePathD(nodes);

  const circles = nodes
    .map((p, i) => {
      const fill = i === 0 ? OG_COLORS.nodeStart : OG_COLORS.node;
      return `<circle cx="${p[0]}" cy="${p[1]}" r="${r.toFixed(2)}" fill="${fill}" stroke="${OG_COLORS.bg0}" stroke-width="0.5" vector-effect="non-scaling-stroke"/>`;
    })
    .join("");

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${OG_MAP.w}" height="${OG_MAP.h}" ` +
    `viewBox="${vb[0]} ${vb[1]} ${vb[2]} ${vb[3]}" preserveAspectRatio="xMidYMid meet">` +
    `<path d="${land}" fill="${OG_COLORS.land}" stroke="${OG_COLORS.landStroke}" stroke-width="0.6" vector-effect="non-scaling-stroke"/>` +
    (routeD
      ? `<path d="${routeD}" fill="none" stroke="${routeColor}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>`
      : "") +
    circles +
    `</svg>`
  );
}

/** SVG 문자열 → data URI(base64). resvg가 카드 rasterize 시 중첩 SVG로 그린다. */
function svgDataUri(svg: string): string {
  // btoa는 latin1만 — SVG에 비ASCII가 없으므로 안전(라벨/닉네임은 SVG가 아니라 카드 HTML에 있다).
  return `data:image/svg+xml;base64,${btoa(svg)}`;
}

function statCell(label: string, value: string): string {
  return (
    `<div style="display:flex;flex-direction:column;">` +
    `<span style="font-size:22px;color:${OG_COLORS.subtext};">${label}</span>` +
    `<span style="font-size:52px;color:${OG_COLORS.text};line-height:1.1;">${value}</span>` +
    `</div>`
  );
}

/** 카드 HTML(satori 파싱). 모든 다자식 요소에 display:flex. */
function buildCardHtml(data: ShareCardData): string {
  const grade = (data.grade || "D").toUpperCase();
  const gradeColor = GRADE_COLORS[grade] ?? OG_COLORS.subtext;
  const label = routeLabel(data.modeKey, data.lang);
  const nick = escapeHtml(data.nickname || (data.lang === "ko" ? "여행자" : "Traveler"));
  const mapImg = svgDataUri(buildMapSvg(data));

  const cpm = Math.max(0, Math.round(data.cpm));
  const pi = Math.round(data.pi);
  const cpmLabel = data.lang === "ko" ? "타/분" : "CPM";
  const timeLabel = data.lang === "ko" ? "시간" : "TIME";

  return (
    `<div style="display:flex;flex-direction:column;width:${OG_WIDTH}px;height:${OG_HEIGHT}px;` +
    `background:linear-gradient(135deg,${OG_COLORS.bg0} 0%,${OG_COLORS.bg1} 100%);` +
    `font-family:Pretendard;color:${OG_COLORS.text};padding:0;position:relative;">` +
    // 헤더
    `<div style="display:flex;align-items:center;justify-content:space-between;padding:26px 44px 0;">` +
    `<span style="display:flex;font-size:40px;font-weight:700;color:${OG_COLORS.logo};">TypeTrip</span>` +
    `<span style="display:flex;font-size:30px;color:${OG_COLORS.subtext};">${escapeHtml(label)}</span>` +
    `</div>` +
    // 지도 + 등급 스탬프
    `<div style="display:flex;position:relative;margin:${OG_MAP.y - 72}px ${(OG_WIDTH - OG_MAP.w) / 2}px 0;">` +
    `<img src="${mapImg}" width="${OG_MAP.w}" height="${OG_MAP.h}" style="display:flex;"/>` +
    `<div style="display:flex;position:absolute;top:12px;right:12px;width:112px;height:112px;` +
    `border-radius:56px;border:6px solid ${gradeColor};align-items:center;justify-content:center;` +
    `background:rgba(11,18,32,0.7);">` +
    `<span style="display:flex;font-size:72px;font-weight:700;color:${gradeColor};">${escapeHtml(grade)}</span>` +
    `</div>` +
    `</div>` +
    // 하단 스탯 패널
    `<div style="display:flex;align-items:flex-end;justify-content:space-between;padding:0 48px 30px;` +
    `position:absolute;bottom:0;left:0;right:0;">` +
    `<div style="display:flex;flex-direction:column;">` +
    `<span style="font-size:26px;color:${OG_COLORS.subtext};">${data.lang === "ko" ? "여행자" : "TRAVELER"}</span>` +
    `<span style="display:flex;font-size:56px;font-weight:700;color:${OG_COLORS.text};">${nick}</span>` +
    `</div>` +
    `<div style="display:flex;gap:40px;align-items:flex-end;">` +
    statCell("PI", String(pi)) +
    statCell(cpmLabel, String(cpm)) +
    statCell("ACC", formatAccuracy(data.accMilli)) +
    statCell(timeLabel, formatElapsed(data.elapsedMs)) +
    `</div>` +
    `</div>` +
    `</div>`
  );
}

/**
 * 결과 카드 PNG를 렌더한다(1200×630). 실패 시 throw — 호출측(share 라우트)이 정적 폴백으로 500을
 * 회피한다(docs/06 §9.1 "렌더 실패 시 정적 기본 OG 폴백, 500 금지").
 */
export async function renderShareCardPng(data: ShareCardData): Promise<Uint8Array> {
  const { ImageResponse } = await import("workers-og");
  const res = new ImageResponse(buildCardHtml(data), {
    width: OG_WIDTH,
    height: OG_HEIGHT,
    format: "png",
    fonts: [
      { name: "Pretendard", data: fontBytes().buffer as ArrayBuffer, weight: 400, style: "normal" },
      // satori가 700 요청 시 폴백할 수 있게 같은 버퍼를 700에도 등록(서브셋은 Regular 1종, D46).
      { name: "Pretendard", data: fontBytes().buffer as ArrayBuffer, weight: 700, style: "normal" },
    ],
  });
  return new Uint8Array(await res.arrayBuffer());
}
