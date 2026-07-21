// spec: docs/03 §4.1("bootLoader는 countries.json을 fetch·zod 파싱해 모듈 캐시에 적재. 실패 시
//       errorElement로 폴백"), §8.2(에셋/데이터 로딩 표 — dataUrl 해시 버스팅·config 폴백),
//       docs/04 §2.2 GET /config(ConfigRes 형태 — 아직 미구현, M3), docs/00 §11-D12(anticheat
//       기본값), WT-M2-05
//
// 세션 환경 어댑테이션: workers/api에는 아직 /api/v1/config 라우트가 없다(M3 소관). 이 파일은
// 그 사실을 전제로 설계됐다 — config fetch 실패는 "치명적이지 않음"(번들 기본값 폴백),
// countries.json fetch/파싱 실패만 라우터 loader 계약대로 throw해 errorElement로 넘어간다.
//
// [WT-M3-06] 부팅 시 세션 부트스트랩(POST /session) + 오프라인 큐 flush(net/pending-queue.ts)를
// 함께 트리거한다. countries.json 로드를 막지 않는 부가 작업이라 await하지 않는다 — 실패해도
// (오프라인 등) 라우터 loader는 이미 resolve된 뒤라 앱은 정상 부팅한다.

import { z } from 'zod';
import { CountriesDatasetSchema } from '@wt/data';
import type { CountriesDataset } from '@wt/shared';
import { DEFAULT_GRADE_CONFIG, DEFAULT_TIME_LIMIT_CONFIG } from '@wt/shared';
import { ensureSession } from '../net/api-client';
import { flushPendingQueue, registerPendingQueueAutoFlush } from '../net/pending-queue';
import { useSettingsStore } from '../stores/settings';

const ClientConfigSchema = z
  .object({
    schemaVersion: z.literal(2),
    dataUrl: z.string().min(1),
    mapUrl: z.string().min(1),
    grades: z.object({ S: z.number(), A: z.number(), B: z.number(), C: z.number() }).strict(),
    timeLimit: z
      .object({
        base: z.number(),
        perKey: z.number(),
        tierRelaxBase: z.number(),
        tierRelaxStep: z.number(),
        min: z.number(),
        max: z.number(),
      })
      .strict(),
    anticheat: z
      .object({
        cpmHardCapKo: z.number(),
        cpmHardCapEn: z.number(),
        minMsPerKeystroke: z.number(),
      })
      .strict(),
    featureFlags: z.record(z.boolean()),
  })
  .strict();

export type ClientConfig = z.infer<typeof ClientConfigSchema>;

// 번들 기본값 — GET /config 미구현/실패 시 폴백(docs/03 §8.2 표 마지막 행, docs/00 §11-D12).
const DEFAULT_CONFIG: ClientConfig = {
  schemaVersion: 2,
  dataUrl: '/data/countries.json',
  mapUrl: '/data/countries-110m.json',
  grades: { ...DEFAULT_GRADE_CONFIG },
  timeLimit: {
    base: DEFAULT_TIME_LIMIT_CONFIG.baseSec,
    perKey: DEFAULT_TIME_LIMIT_CONFIG.perCharSec,
    tierRelaxBase: DEFAULT_TIME_LIMIT_CONFIG.tierRelaxBase,
    tierRelaxStep: DEFAULT_TIME_LIMIT_CONFIG.tierRelaxStep,
    min: DEFAULT_TIME_LIMIT_CONFIG.minSec,
    max: DEFAULT_TIME_LIMIT_CONFIG.maxSec,
  },
  anticheat: { cpmHardCapKo: 1100, cpmHardCapEn: 1000, minMsPerKeystroke: 35 },
  featureFlags: {},
};

export interface BootData {
  config: ClientConfig;
  countries: CountriesDataset;
  /** manifest countries.sha256의 앞 8자 — 멀티 hello의 dataVersion 필드에 그대로 쓴다. */
  dataVersion: string;
}

let cached: BootData | null = null;

/** GamePage 등 loader 밖에서 부팅 데이터가 필요할 때(§4.4 useCountries류 훅의 기반). */
export function getBootData(): BootData {
  if (!cached) {
    throw new Error('getBootData() called before bootLoader resolved — call after router settles');
  }
  return cached;
}

async function loadConfig(): Promise<ClientConfig> {
  try {
    const res = await fetch('/api/v1/config');
    if (!res.ok) throw new Error(`config fetch failed: ${res.status}`);
    return ClientConfigSchema.parse(await res.json());
  } catch {
    return DEFAULT_CONFIG;
  }
}

async function loadDataVersion(): Promise<string> {
  try {
    const res = await fetch('/data/manifest.json');
    if (!res.ok) throw new Error('manifest fetch failed');
    const manifest = (await res.json()) as { countries?: { sha256?: string } };
    const hash = manifest.countries?.sha256;
    return hash ? hash.slice(0, 8) : 'unknown';
  } catch {
    return 'unknown';
  }
}

async function loadCountries(dataUrl: string, dataVersion: string): Promise<CountriesDataset> {
  const url = dataVersion !== 'unknown' ? `${dataUrl}?v=${dataVersion}` : dataUrl;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`countries.json fetch failed: ${res.status} ${url}`);
  const parsed = CountriesDatasetSchema.parse(await res.json());
  return Object.freeze(parsed);
}

/** router.tsx 루트 loader. */
export async function bootLoader(): Promise<BootData> {
  if (cached) return cached;
  const config = await loadConfig();
  const dataVersion = await loadDataVersion();
  const countries = await loadCountries(config.dataUrl, dataVersion);
  cached = Object.freeze({ config, countries, dataVersion });

  registerPendingQueueAutoFlush();
  void ensureSession(useSettingsStore.getState().guestId)
    .then(() => flushPendingQueue())
    .catch((err: unknown) => {
      console.warn('[bootLoader] 세션 부트스트랩/큐 flush 실패(오프라인 추정):', err);
    });

  return cached;
}

/** 테스트 전용: 모듈 캐시가 테스트 케이스 간 누수되지 않도록 리셋. */
export function __resetBootCacheForTests(): void {
  cached = null;
}
