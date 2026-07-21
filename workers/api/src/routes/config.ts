// spec: docs/04 §2.1(공통 규약)·§2.3-2(ConfigRes 전문), docs/00 §7.4(config:client/edge cache 60s),
//       docs/00 §11-D12(anticheat 임계 통합값) + WT-M3-02
//
// GET /api/v1/config — KV `config:client`가 원천, 부재/파싱 실패 시 번들 기본값으로 폴백한다.
// 등급 컷·제한시간 계수는 @wt/shared의 DEFAULT_GRADE_CONFIG/DEFAULT_TIME_LIMIT_CONFIG를 그대로
// 반영한다 — 점수 상수를 이 라우트에서 다시 정의하면 클라·서버 패리티가 깨진다(CLAUDE.md 함정 3).
import { Hono } from "hono";
import { z } from "zod";
import { DEFAULT_GRADE_CONFIG, DEFAULT_TIME_LIMIT_CONFIG } from "@wt/shared";
import type { Env } from "../env";
import { KV_KEYS } from "../lib/kv-keys";

interface ConfigRes {
  schemaVersion: 2;
  dataUrl: string;
  mapUrl: string;
  grades: { S: number; A: number; B: number; C: number };
  timeLimit: {
    base: number;
    perKey: number;
    tierRelaxBase: number;
    tierRelaxStep: number;
    min: number;
    max: number;
  };
  anticheat: { cpmHardCapKo: number; cpmHardCapEn: number; minMsPerKeystroke: number };
  featureFlags: Record<string, boolean>;
}

// docs/00 §11-D12 확정값(핫스왑 전 폴백). KV config:anticheat가 이 라우트의 원천은 아니다
// (그건 WT-M3-03의 anticheat-config.ts 소관) — 여기서는 ConfigRes.anticheat 표시용 폴백만 든다.
const DEFAULT_ANTICHEAT = { cpmHardCapKo: 1100, cpmHardCapEn: 1000, minMsPerKeystroke: 35 } as const;

// v1 스코프 밖 기능은 기본 false(docs/00 §3.2 명시적 제외) — 운영자가 KV config:client로 토글.
const DEFAULT_FEATURE_FLAGS: Record<string, boolean> = { ghostMode: false, quiz: false };

const MAP_URL = "/data/countries-110m.json";
const COUNTRIES_DATA_PATH = "/data/countries.json";
const MANIFEST_PATH = "/data/manifest.json";

interface ManifestShape {
  countries?: { sha256?: string };
}

function defaultConfig(dataUrl: string): ConfigRes {
  return {
    schemaVersion: 2,
    dataUrl,
    mapUrl: MAP_URL,
    grades: { ...DEFAULT_GRADE_CONFIG },
    timeLimit: {
      base: DEFAULT_TIME_LIMIT_CONFIG.baseSec,
      perKey: DEFAULT_TIME_LIMIT_CONFIG.perCharSec,
      tierRelaxBase: DEFAULT_TIME_LIMIT_CONFIG.tierRelaxBase,
      tierRelaxStep: DEFAULT_TIME_LIMIT_CONFIG.tierRelaxStep,
      min: DEFAULT_TIME_LIMIT_CONFIG.minSec,
      max: DEFAULT_TIME_LIMIT_CONFIG.maxSec,
    },
    anticheat: { ...DEFAULT_ANTICHEAT },
    featureFlags: { ...DEFAULT_FEATURE_FLAGS },
  };
}

// KV config:client는 운영자 입력(런북 경유)이지만 핫스왑 채널이라 방어적으로 검증한다 —
// 잘못된 값이 배포 없이 즉시 전 클라에 퍼지는 사고를 막는다. 실패 시 번들 기본값 전체로 폴백.
const ConfigResSchema = z.object({
  schemaVersion: z.literal(2),
  dataUrl: z.string().min(1),
  mapUrl: z.string().min(1),
  grades: z.object({ S: z.number(), A: z.number(), B: z.number(), C: z.number() }),
  timeLimit: z.object({
    base: z.number(),
    perKey: z.number(),
    tierRelaxBase: z.number(),
    tierRelaxStep: z.number(),
    min: z.number(),
    max: z.number(),
  }),
  anticheat: z.object({
    cpmHardCapKo: z.number(),
    cpmHardCapEn: z.number(),
    minMsPerKeystroke: z.number(),
  }),
  featureFlags: z.record(z.string(), z.boolean()),
});

export const config = new Hono<{ Bindings: Env }>();

config.get("/config", async (c) => {
  const kv = c.env.KV;
  const dataUrl = await resolveDataUrl(c.env);
  let cfg = defaultConfig(dataUrl);

  if (kv) {
    const raw = await kv.get(KV_KEYS.configClient);
    if (raw) {
      try {
        const parsed = ConfigResSchema.safeParse(JSON.parse(raw));
        if (parsed.success) {
          cfg = { ...parsed.data, dataUrl }; // dataUrl은 override 여부에 따라 항상 이 라우트가 결정
        } else {
          // eslint-disable-next-line no-console -- 운영자가 핫스왑한 값이 스키마를 깼다는 신호.
          console.error("[wt-api] config:client failed schema validation, falling back", parsed.error);
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error("[wt-api] config:client is not valid JSON, falling back", err);
      }
    }
  }

  c.header("Cache-Control", "public, max-age=60");
  return c.json(cfg);
});

/**
 * dataUrl 결정 순서:
 *  1) KV `data:countries:override`가 존재 → `/api/v1/data/countries`(핫스왑, docs/00 §7.4)로 전환.
 *  2) 그렇지 않으면 정적 자산 경로 + manifest(`apps/web/public/data/manifest.json`) sha256을
 *     쿼리스트링으로 붙여 "manifest 해시 반영"을 만족시킨다.
 *
 * 산출물 파일명 자체(`countries.<hash>.json`)에 해시를 박는 docs/04 §2.3 예시 표기 대신
 * 쿼리스트링(`?v=<hash 앞 8자>`)을 쓴다 — 실제 데이터 빌드 파이프라인(WT-M1-05, build-data.ts)이
 * 이미 고정 파일명 `countries.json` + 별도 `manifest.json.countries.sha256`로 확정되어 있어
 * (해시-포함 파일명은 산출물에 존재하지 않음), 파일명에 해시를 넣으려면 빌드 파이프라인 자체를
 * 바꿔야 한다 — 이 태스크 범위 밖이라 캐시버스팅 의미(빌드가 바뀌면 URL이 바뀐다)만 보존하는
 * 최소 변경으로 대체했다. manifest를 못 읽으면(로컬 KV/ASSETS 미바인딩 등) 해시 없이 폴백한다.
 */
async function resolveDataUrl(env: Env): Promise<string> {
  if (env.KV) {
    const override = await env.KV.get(KV_KEYS.dataCountriesOverride);
    if (override) return "/api/v1/data/countries";
  }

  const hash = await readManifestCountriesHash(env.ASSETS);
  return hash ? `${COUNTRIES_DATA_PATH}?v=${hash.slice(0, 8)}` : COUNTRIES_DATA_PATH;
}

async function readManifestCountriesHash(assets: Env["ASSETS"] | undefined): Promise<string | undefined> {
  if (!assets) return undefined;
  try {
    const res = await assets.fetch(new Request(`http://internal${MANIFEST_PATH}`));
    if (!res.ok) return undefined;
    const manifest = (await res.json()) as ManifestShape;
    return manifest.countries?.sha256;
  } catch {
    return undefined;
  }
}
