// spec: docs/04 §6.1(생명주기 — 세트 확정·setHash), docs/06 §2.1(데일리 세트), docs/00 §11-D5(티어 =
//       일일 시드 SHA-256(DAILY_SALT+"tier:"+tierId+":"+dateKST) → seededShuffle → 20개)·§11-D13
//       (셔플 = mulberry32 공유)·§11-D21(랭킹 걸린 세트는 서버 salt 전용) + WT-M3-03
//
// 모드별 "이 판의 출제 세트(순서 포함)"를 확정하는 단일 원천. 두 진입점을 공유 헬퍼로 묶어
// /runs/start(발급)와 /runs/submit(재현·검증)이 반드시 같은 세트를 산출하게 한다:
//   - buildSetForStart: 시작 시 세트+seed+modeKey 확정(티어는 salt로 시드 파생, 데일리는 저장본 로드).
//   - rebuildSet: 제출 시 토큰만으로 동일 세트 재현(티어는 토큰의 seed+lang으로 재현 → salt 불요).
//
// §11-D107(WT-TIER-DIFFICULTY): 티어 세트 생성 로직은 @wt/shared buildTierSet으로 이관됐다.
// T4·T5는 긴 이름 가중 샘플링이라 세트가 lang에 따라 갈리므로, start는 요청 lang을, submit
// 재현은 토큰에 서명된 lang을 넘긴다(같은 판은 항상 같은 lang → setHash 일치).
//
// continent/worldtour는 packages/data/content/routes.ts 고정 순서 그대로(랭킹 세트가 아니라 시드
// 불필요). tier는 salt 기반 일일 시드(전 유저 동일 세트, §11-D5). daily는 cron이 확정 저장한
// daily_challenges(D1) 원본을 로드(클라 사전 계산 불가 — salt 서버 전용, §11-D21).
import {
  buildTierSet,
  TIER_SET_SIZE,
  type CountryId,
  type Continent,
  type DifficultyTier,
} from "@wt/shared";
import { COUNTRIES } from "@wt/data";
import { CONTINENT_ROUTES, ROUTE_WORLD_TOUR } from "@wt/data/content/routes";
import type { Env } from "../env";
import type { DailyChallengeRow } from "../db/types";
import { ApiHttpError } from "./api-error";
import { KV_KEYS } from "./kv-keys";
import { sha256Hex } from "./hash";
import { kstDate } from "./kst";

/** 랭킹 대상 밖(extended) 국가 — 티어/데일리 풀에서 제외(§11-D1, useCountries.ts와 동일 집합). */
const EXTENDED_IDS = new Set<CountryId>(["TW", "XK", "EH"]);

/** un195(랭킹 대상) 국가만. COUNTRIES는 id 오름차순 고정(생성물)이라 filter 결과도 결정적. */
const UN195 = COUNTRIES.filter((c) => !EXTENDED_IDS.has(c.id));

/** 싱글 판 모드(멀티 'race' 제외). */
export type SingleMode = "continent" | "tier" | "worldtour" | "daily";

export interface StartSetInput {
  mode: SingleMode;
  /** 티어 세트의 가중 샘플링(T4·T5)이 L_i 산출에 쓰는 언어(§11-D107). 다른 모드는 미사용. */
  lang: "ko" | "en";
  continent?: Continent; // mode==='continent'일 때 필수
  tier?: DifficultyTier; // mode==='tier'일 때 필수
}

export interface BuiltSet {
  countryIds: CountryId[];
  seed: string;
  modeKey: string;
}

/**
 * 티어 세트: 일일 시드 hex → 해당 티어 풀에서 20개(§11-D5). start·rebuild 공용.
 * 생성 로직 자체는 @wt/shared buildTierSet 하나뿐이다(§11-D107 — T1~T3 균등 셔플, T4·T5 긴 이름
 * 가중 샘플링). 여기서 재구현하지 않는다(Gotcha 3·5).
 */
function tierSet(seedHex: string, tier: DifficultyTier, lang: "ko" | "en"): CountryId[] {
  return buildTierSet(seedHex, tier, UN195, lang, TIER_SET_SIZE);
}

/** 티어 일일 시드 hex(§11-D5). salt는 서버 전용이라 이 파생은 서버에서만 가능하다(§11-D21). */
function tierSeedHex(env: Env, tier: DifficultyTier, dateKst: string): Promise<string> {
  return sha256Hex(`${env.DAILY_SALT}tier:${tier}:${dateKst}`);
}

/** setHash = SHA-256(countryIds.join(',')) — runToken에 서명해 제출 시 세트 위조를 차단(§6.1). */
export function computeSetHash(countryIds: readonly CountryId[]): Promise<string> {
  return sha256Hex(countryIds.join(","));
}

/** /runs/start: 세트·seed·modeKey 확정. */
export async function buildSetForStart(
  env: Env,
  input: StartSetInput,
  now: number = Date.now(),
): Promise<BuiltSet> {
  switch (input.mode) {
    case "continent": {
      if (!input.continent) {
        throw new ApiHttpError(400, "INVALID_BODY", "continent가 필요합니다(mode=continent).");
      }
      const route = CONTINENT_ROUTES[input.continent];
      if (!route) {
        throw new ApiHttpError(400, "INVALID_BODY", `알 수 없는 대륙: ${input.continent}`);
      }
      return { countryIds: [...route], seed: `fixed:continent:${input.continent}`, modeKey: `continent:${input.continent}` };
    }
    case "worldtour":
      return { countryIds: [...ROUTE_WORLD_TOUR], seed: "fixed:worldtour", modeKey: "worldtour" };
    case "tier": {
      if (!input.tier) {
        throw new ApiHttpError(400, "INVALID_BODY", "tier가 필요합니다(mode=tier).");
      }
      const dateKst = kstDate(now);
      const seedHex = await tierSeedHex(env, input.tier, dateKst);
      return {
        countryIds: tierSet(seedHex, input.tier, input.lang),
        seed: seedHex,
        modeKey: `tier:${input.tier}`,
      };
    }
    case "daily": {
      const dateKst = kstDate(now);
      const daily = await loadDailySet(env, dateKst);
      return { countryIds: daily.countryIds, seed: daily.seed, modeKey: `daily:${dateKst}` };
    }
  }
}

/**
 * /runs/submit: 토큰만으로 동일 세트를 재현한다(서버 권위 재검증의 기준 세트).
 * 티어는 토큰의 seed(일일 시드 hex)로 재셔플하므로 salt 재접근이 필요 없다.
 */
export async function rebuildSet(
  env: Env,
  token: { mode: string; modeKey: string; seed: string; lang: "ko" | "en" },
): Promise<CountryId[]> {
  switch (token.mode) {
    case "continent": {
      const continent = token.modeKey.slice("continent:".length) as Continent;
      const route = CONTINENT_ROUTES[continent];
      if (!route) throw new ApiHttpError(400, "INVALID_TOKEN", `알 수 없는 대륙 modeKey: ${token.modeKey}`);
      return [...route];
    }
    case "worldtour":
      return [...ROUTE_WORLD_TOUR];
    case "tier": {
      const tier = Number(token.modeKey.slice("tier:".length));
      if (!Number.isInteger(tier) || tier < 1 || tier > 5) {
        throw new ApiHttpError(400, "INVALID_TOKEN", `알 수 없는 tier modeKey: ${token.modeKey}`);
      }
      // lang은 토큰에 서명돼 있으므로(발급 시점 값) 재현이 발급과 항상 같은 언어 세트가 된다.
      return tierSet(token.seed, tier as DifficultyTier, token.lang);
    }
    case "daily": {
      const dateKst = token.modeKey.slice("daily:".length);
      const daily = await loadDailySet(env, dateKst);
      return daily.countryIds;
    }
    default:
      // 'race'는 멀티 전용(DO 권위) — 싱글 제출 경로로 들어오면 안 된다.
      throw new ApiHttpError(400, "INVALID_TOKEN", `싱글 제출에 허용되지 않는 mode: ${token.mode}`);
  }
}

interface DailySet {
  countryIds: CountryId[];
  seed: string;
}

/**
 * 데일리 세트 로드: KV daily:{date}(캐시, 방어적 파싱) → daily_challenges(D1, 확정본) 순.
 * 둘 다 없으면 아직 cron(WT-M3-05)이 발행하지 않은 날짜 — 503으로 안내(클라 계산 불가, §11-D21).
 * KV 저장 shape는 WT-M3-05 소관이라 여기서는 {seed, countryIds}만 방어적으로 취하고, 형태가
 * 다르면 무시하고 D1로 폴백한다(태스크 간 결합 최소화).
 */
async function loadDailySet(env: Env, dateKst: string): Promise<DailySet> {
  if (env.KV) {
    const raw = await env.KV.get(KV_KEYS.daily(dateKst));
    if (raw) {
      const cached = parseDailyCache(raw);
      if (cached) return cached;
    }
  }
  if (env.DB) {
    const row = await env.DB.prepare(
      "SELECT seed, country_ids FROM daily_challenges WHERE date_kst = ?1",
    )
      .bind(dateKst)
      .first<Pick<DailyChallengeRow, "seed" | "country_ids">>();
    if (row) {
      const ids = safeJsonStringArray(row.country_ids);
      if (ids) return { countryIds: ids, seed: row.seed };
    }
  }
  throw new ApiHttpError(503, "DAILY_NOT_READY", `데일리 세트가 아직 준비되지 않았습니다: ${dateKst}`);
}

function parseDailyCache(raw: string): DailySet | null {
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof obj !== "object" || obj === null) return null;
  const seed = (obj as { seed?: unknown }).seed;
  const ids = safeStringArray((obj as { countryIds?: unknown }).countryIds);
  if (typeof seed === "string" && seed.length > 0 && ids) return { countryIds: ids, seed };
  return null;
}

function safeJsonStringArray(raw: string): CountryId[] | null {
  try {
    return safeStringArray(JSON.parse(raw));
  } catch {
    return null;
  }
}

function safeStringArray(v: unknown): CountryId[] | null {
  if (!Array.isArray(v) || v.length === 0) return null;
  if (!v.every((x) => typeof x === "string")) return null;
  return v as CountryId[];
}
