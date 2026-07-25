// spec: docs/06 §8.4(인시던트 런북 — "치트 웨이브(핵 유포)" 1차 대응: anticheat.json 캡 하향
//       핫스왑 → 해당 기간 보드 스냅샷 후 flagged 일괄 재판정 스크립트) + WT-M6-04 구현 세부
//       지시 2("rescore.ts: 기간·모드 지정 → runs 재검증 → verdict 일괄 갱신 → dirty 마킹")
//
// [구현 결정 — 최종 보고 escalations 참조] docs/06·07 어디에도 rescore.ts의 정확한 CLI 계약이나
// 재검증 알고리즘이 명세돼 있지 않다(런북 표에 이름만 등장). 이 스크립트가 내린 설계 결정:
//
//   1) D1/KV 접근은 계정 토큰이 아니라 `wrangler d1 execute`/`wrangler kv key put` 서브프로세스로
//      한다 — Worker 바인딩 없이 ops 스크립트가 원격/로컬 D1·KV를 동일한 방식으로 다루기 위함
//      (CLOUDFLARE_API_TOKEN은 wrangler가 환경변수로 직접 읽는다, 이 스크립트는 시크릿을 다루지
//      않는다).
//   2) `packages/shared`의 matchInput/computeScore와 `workers/api/src/lib/run-verify.ts`의
//      verifyRun을 그대로 import해 재사용한다(판정 로직 재구현 금지 — CLAUDE.md 함정 3). 이미
//      한 번 통과한 판을 "재검증"하는 것이므로 토큰/리플레이/세트-일치 단계(①②④)는 원 제출
//      시점에 이미 검증됐다고 보고, 이 스크립트가 합성하는 토큰으로 trivially 통과시킨다 —
//      실질적으로 재평가되는 것은 물리 한계(⑦)·CPM 하드캡(⑧)·점수 재계산(⑨)·휴리스틱(⑩)이며,
//      이것이 "캡을 하향한 뒤 그 기준으로 다시 판정"이라는 런북의 실제 목적과 정확히 일치한다.
//      매칭 재검증(⑤)도 detail_json에 저장된 원문 inputUsed로 실제로 재실행된다.
//   3) PersonalStats(성장 점프·첫 제출 콤보 휴리스틱 ⑨/⑩ 일부)는 이 스크립트 범위에서 과거
//      이력을 다시 집계하지 않고 중립값(sampleSize:0, bestPi:null, isFirstSubmission:false)으로
//      고정한다 — growth_jump/acc_combo 플래그는 이 재판정에서 발생하지 않는다(치트 웨이브
//      대응의 핵심인 물리/CPM/리듬/벌크 입력 휴리스틱은 영향받지 않는다).
//   4) mode='daily'는 세트 재현에 daily_challenges(D1) 조인이 필요해 이번 스코프에서는
//      재검증하지 않고 후보 목록에 "daily(수동 검토 필요)"로만 표시한다 — 리드가 원하면 후속
//      확장(daily_challenges 조회 추가)으로 이 제약을 없앨 수 있다.
//
// 사용법: pnpm ops:rescore -- --from 2026-08-01 --to 2026-08-02 --mode tier:3 --env dev [--local|--remote] [--apply]
//   --from/--to: KST 날짜(YYYY-MM-DD, --to는 배타적 상한익일 자정) 또는 ISO 타임스탬프.
//   --mode: mode_key 접두 필터(예: "tier:3", "continent:asia", "worldtour"). 생략 시 전체.
//   --db: D1 데이터베이스 이름(기본 wt-main-{env}).
//   --local|--remote: wrangler d1/kv 대상(기본 --local, 원격은 CLOUDFLARE_API_TOKEN 필요).
//   --apply: 기본은 dry-run(변경 없음, 표만 출력). 지정 시 실제 UPDATE + KV dirty 마킹까지 수행.
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Windows에서 execFileSync("npx", ...)는 ENOENT(실행파일은 npx.cmd)이고, "npx.cmd"를 shell 없이
// 직접 스폰하면 EINVAL(Node 20+ 보안 변경 — 배치파일은 shell:true 경유가 필요). shell:true는 배열
// 인자를 이스케이프 없이 공백으로만 이어붙이므로(Node 자체 경고), 공백·파이프(|) 등 셸 특수문자를
// 포함할 수 있는 인자는 이 헬퍼가 직접 큰따옴표로 감싼다 — SQL 문자열은 항상 작은따옴표만 쓰므로
// (run-verify.ts 재사용 원칙과 무관, 이 스크립트 자체 SQL 리터럴 컨벤션) 큰따옴표 래핑이 안전하다.
function quoteArg(s: string): string {
  return /[\s|"'&<>^]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s;
}

function execFileSyncShell(args: string[], cwd: string): string {
  const cmd = ["npx", ...args.map(quoteArg)].join(" ");
  return execSync(cmd, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

// run-verify.ts/set-builder.ts/lb.ts/anticheat-config.ts는 workers/api 내부 소스를 그대로
// import한다(재구현 금지 원칙, 파일 상단 주석 #2).
import { verifyRun, type RunSubmitData, type PersonalStats } from "../../../workers/api/src/lib/run-verify";
import { rebuildSet, computeSetHash, type SingleMode } from "../../../workers/api/src/lib/set-builder";
import { loadAnticheatConfig, type AnticheatConfig } from "../../../workers/api/src/lib/anticheat-config";
import { boardKeysForRun } from "../../../workers/api/src/lib/lb";
import type { Env } from "../../../workers/api/src/env";
import { RUN_TOKEN_TTL_MS, type RunTokenPayload } from "@wt/shared";

interface Args {
  fromMs: number;
  toMs: number;
  modePrefix: string | null;
  db: string;
  remote: boolean;
  apply: boolean;
  env: "dev" | "staging" | "prod";
  /** 로컬 파일에서 AnticheatConfig를 읽는다(오프라인 테스트/시뮬레이션용). 생략 시 실제
   *  config:anticheat KV(운영자가 이미 하향 핫스왑한 값)를 `wrangler kv key get`으로 읽는다 —
   *  이것이 런북의 실제 워크플로("캡 하향 → 그 기준으로 재판정")다. */
  configPath: string | null;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const envName = (get("--env") ?? "dev") as Args["env"];
  const from = get("--from");
  const to = get("--to");
  if (!from || !to) {
    throw new Error("rescore.ts: --from/--to(KST 날짜 또는 ISO 타임스탬프)가 필요합니다.");
  }
  return {
    fromMs: Date.parse(from.length === 10 ? `${from}T00:00:00+09:00` : from),
    toMs: Date.parse(to.length === 10 ? `${to}T00:00:00+09:00` : to),
    modePrefix: get("--mode") ?? null,
    db: get("--db") ?? `wt-main-${envName}`,
    remote: argv.includes("--remote"),
    apply: argv.includes("--apply"),
    env: envName,
    configPath: get("--config") ?? null,
  };
}

/** wrangler.toml에는 [env.staging]/[env.prod]만 있고 dev는 최상위 설정이다 — "--env dev"를 그대로
 *  넘기면 "환경 dev 없음" 에러가 난다(wrangler 4.x). dev는 --env 플래그 자체를 생략해야 한다. */
function envFlag(args: Args): string[] {
  return args.env === "dev" ? [] : ["--env", args.env];
}

/** wrangler kv key get으로 원시 config:anticheat 문자열을 읽는다(부재/실패 시 null — 관대한 폴백). */
function fetchAnticheatConfigRaw(args: Args): string | null {
  const target = args.remote ? "--remote" : "--local";
  try {
    return execFileSyncShell(
      ["wrangler", "kv", "key", "get", "--binding", "KV", ...envFlag(args), target, "config:anticheat"],
      fileURLToPath(new URL("../../../workers/api", import.meta.url)),
    ).trim();
  } catch {
    return null; // 키 부재(wrangler가 비-zero exit) — 기본값 폴백(loadAnticheatConfig와 동일 톤).
  }
}

/**
 * §11-D12 anticheat-config.ts의 loadAnticheatConfig(스키마 검증+폴백)를 그대로 재사용한다
 * (검증 로직 중복 금지) — KVNamespace 대신 wrangler CLI로 얻은 문자열 하나만 돌려주는 최소
 * 어댑터를 주입한다. --config 경로가 있으면 로컬 파일을 그 어댑터에 흘려보낸다(오프라인 테스트).
 */
async function resolveConfig(args: Args): Promise<AnticheatConfig> {
  const raw = args.configPath ? readFileSync(args.configPath, "utf8") : fetchAnticheatConfigRaw(args);
  const fakeKv = { get: async () => raw } as unknown as KVNamespace;
  return loadAnticheatConfig(fakeKv);
}

interface RunRowForRescore {
  run_id: string;
  user_id: string;
  mode_key: string;
  lang: "ko" | "en";
  platform: "desktop" | "mobile";
  seed: string | null;
  elapsed_ms: number;
  created_at: number;
  verdict: string;
  detail_json: string;
}

/** SQL을 한 줄로 접는다(shell 커맨드라인에 리터럴 개행을 실을 수 없다 — cmd.exe/POSIX 공통 제약). */
function flattenSql(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}

/** wrangler d1 execute --json 결과 파싱(1문 실행 = 배열 첫 원소). */
function d1Execute(args: Args, sql: string): Array<Record<string, unknown>> {
  const target = args.remote ? "--remote" : "--local";
  const out = execFileSyncShell(
    ["wrangler", "d1", "execute", args.db, ...envFlag(args), target, "--json", "--command", flattenSql(sql)],
    fileURLToPath(new URL("../../../workers/api", import.meta.url)),
  );
  const parsed = JSON.parse(out) as Array<{ results?: Array<Record<string, unknown>>; success: boolean }>;
  return parsed[0]?.results ?? [];
}

function d1Run(args: Args, sql: string): void {
  const target = args.remote ? "--remote" : "--local";
  execFileSyncShell(
    ["wrangler", "d1", "execute", args.db, ...envFlag(args), target, "--command", flattenSql(sql)],
    fileURLToPath(new URL("../../../workers/api", import.meta.url)),
  );
}

function kvPutDirty(args: Args, boardKey: string): void {
  const target = args.remote ? "--remote" : "--local";
  execFileSyncShell(
    ["wrangler", "kv", "key", "put", "--binding", "KV", ...envFlag(args), target, `dirty:${boardKey}`, "1", "--ttl", "180"],
    fileURLToPath(new URL("../../../workers/api", import.meta.url)),
  );
}

function modeOf(modeKey: string): SingleMode {
  if (modeKey.startsWith("continent:")) return "continent";
  if (modeKey.startsWith("tier:")) return "tier";
  if (modeKey === "worldtour") return "worldtour";
  if (modeKey.startsWith("daily:")) return "daily";
  throw new Error(`rescore.ts: 알 수 없는 mode_key: ${modeKey}`);
}

async function rescoreOne(
  row: RunRowForRescore,
  config: AnticheatConfig,
): Promise<{ newVerdict: string; newReason: string | null; changed: boolean } | { skipped: string }> {
  const mode = modeOf(row.mode_key);
  if (mode === "daily") return { skipped: "daily(수동 검토 필요 — 파일 상단 주석 #4)" };
  if (!row.seed) return { skipped: "seed 없음(레코드 이상)" };

  let submit: RunSubmitData;
  try {
    const parsed = JSON.parse(row.detail_json) as Partial<RunSubmitData>;
    if (!parsed.result || parsed.clientScore === undefined || !parsed.inputDigest) {
      return { skipped: "detail_json 불완전(보존 정리로 이미 클리어됐을 가능성 — §6.2 90일)" };
    }
    submit = { result: parsed.result, clientScore: parsed.clientScore, inputDigest: parsed.inputDigest };
  } catch {
    return { skipped: "detail_json 파싱 실패" };
  }

  // lang은 티어 세트 재현에 필요하다(§11-D107 — T4·T5 가중 샘플링이 L_i 언어에 의존).
  const fullSet = await rebuildSet({} as Env, { mode, modeKey: row.mode_key, seed: row.seed, lang: row.lang });
  const setHash = await computeSetHash(fullSet);

  // 파일 상단 주석 #2: 이미 통과한 원 제출의 토큰/리플레이/세트-일치 단계는 합성 값으로
  // trivially 만족시키고, 물리/CPM/매칭/휴리스틱만 실질 재평가한다.
  const token: RunTokenPayload = {
    rid: row.run_id,
    pid: row.user_id,
    mode,
    modeKey: row.mode_key,
    lang: row.lang,
    platform: row.platform,
    setHash,
    seed: row.seed,
    startTs: row.created_at - row.elapsed_ms,
    exp: row.created_at - row.elapsed_ms + RUN_TOKEN_TTL_MS,
  };
  const personal: PersonalStats = { sampleSize: 0, bestPi: null, isFirstSubmission: false }; // 파일 상단 주석 #3

  const result = verifyRun({
    sessionPid: row.user_id,
    token,
    rebuiltSetHash: setHash,
    fullSet,
    alreadyUsed: false,
    submit,
    now: row.created_at,
    runTokenTtlMs: row.elapsed_ms + 1,
    config,
    personal,
  });

  return {
    newVerdict: result.verdict,
    newReason: result.verdictReason,
    changed: result.verdict !== row.verdict,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const modeFilter = args.modePrefix ? ` AND mode_key LIKE '${args.modePrefix.replace(/'/g, "''")}%'` : "";
  const sql = `SELECT run_id, user_id, mode_key, lang, platform, seed, elapsed_ms, created_at, verdict, detail_json
               FROM runs
               WHERE created_at >= ${args.fromMs} AND created_at < ${args.toMs}
                 AND verdict IN ('valid','flagged')${modeFilter}
               LIMIT 5000`;
  const rows = d1Execute(args, sql) as unknown as RunRowForRescore[];
  const config = await resolveConfig(args);

  console.log(`[rescore] 후보 ${rows.length}건 (${new Date(args.fromMs).toISOString()} ~ ${new Date(args.toMs).toISOString()}, mode=${args.modePrefix ?? "*"}, ${args.remote ? "remote" : "local"}:${args.db})`);
  console.log(`[rescore] 적용 config: cpmHardCap(ko/en)=${config.cpmHardCapKo}/${config.cpmHardCapEn}, minMsPerKeystroke=${config.minMsPerKeystroke}${args.configPath ? ` (파일: ${args.configPath})` : " (KV config:anticheat 실값 또는 기본 폴백)"}`);

  let changedCount = 0;
  let skippedCount = 0;
  const dirtyBoardKeys = new Set<string>();

  for (const row of rows) {
    // eslint-disable-next-line no-await-in-loop -- 순차 처리(D1 sub-process 직렬 호출, 소규모 배치 전제).
    const outcome = await rescoreOne(row, config);
    if ("skipped" in outcome) {
      skippedCount += 1;
      console.log(`  SKIP  ${row.run_id}  ${outcome.skipped}`);
      continue;
    }
    if (!outcome.changed) continue;
    changedCount += 1;
    console.log(
      `  DIFF  ${row.run_id}  ${row.verdict} -> ${outcome.newVerdict}${outcome.newReason ? ` (${outcome.newReason})` : ""}`,
    );
    for (const k of boardKeysForRun({ modeKey: row.mode_key, lang: row.lang, platform: row.platform, now: row.created_at })) {
      dirtyBoardKeys.add(k);
    }
    if (args.apply) {
      const reasonSql = outcome.newReason ? `'${outcome.newReason.replace(/'/g, "''")}'` : "NULL";
      d1Run(
        args,
        `UPDATE runs SET verdict='${outcome.newVerdict}', verdict_reason=${reasonSql} WHERE run_id='${row.run_id}'`,
      );
    }
  }

  console.log(`[rescore] 완료: 변경 후보 ${changedCount}건, skip ${skippedCount}건, dirty 보드 ${dirtyBoardKeys.size}개`);
  if (args.apply) {
    for (const key of dirtyBoardKeys) kvPutDirty(args, key);
    console.log(`[rescore] --apply: verdict UPDATE + dirty 마킹 완료(1분 내 lb-refresher가 보드 재계산).`);
  } else {
    console.log(`[rescore] dry-run(기본값) — 실제 반영하려면 --apply를 추가하세요.`);
  }
}

main().catch((err) => {
  console.error("[rescore] 실패:", err);
  process.exitCode = 1;
});
