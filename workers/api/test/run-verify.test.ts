// spec: docs/04 §6.2(10단계 순서)·§6.4(verdict), docs/06 §3.2~3.4, docs/00 §11-D12 + WT-M3-03
//       [구현 세부 지시] #6 — 치트 6종(토큰 재사용/시간 압축/점수 위조/봇 리듬/붙여넣기/세트 불일치)
//       의 단위 수준 검증 + 정상 제출(verified + 서버 재계산 = 골든 벡터) + 각 reject/flag 분기.
//
// verifyRun은 순수 함수라 IO 없이 단위 테스트한다(KV/D1는 runs.test.ts의 라우트 통합에서 커버).
import { describe, expect, it } from "vitest";
import {
  computeScore,
  requiredKeystrokes,
  RUN_TOKEN_TTL_MS,
  type Country,
  type CountryId,
  type RunTokenPayload,
  type ScoreCountry,
} from "@wt/shared";
import { COUNTRIES } from "@wt/data";
import { verifyRun, type RunVerifyParams, type InputDigest } from "../src/lib/run-verify";
import { DEFAULT_ANTICHEAT_CONFIG } from "../src/lib/anticheat-config";

const BY_ID = new Map<CountryId, Country>(COUNTRIES.map((c) => [c.id, c]));
const SET: CountryId[] = ["FR", "JP", "BR"]; // 전부 un195, 데이터에 존재
const LANG = "en" as const;
const NOW = 1_700_000_000_000;
const SETHASH = "SETHASH-DETERMINISTIC";

/** 사람 같은 리듬(어느 봇/벌크 임계도 건드리지 않음). */
const HUMAN_DIGEST: InputDigest = { n: 30, mean: 150, stdev: 60, p10: 80, p50: 140, p90: 300, burstMax: 1 };

interface BuiltSubmission {
  result: RunVerifyParams["submit"]["result"];
  clientScore: number;
  scoreCountries: ScoreCountry[];
}

/**
 * ms = L_i × msPerKeystroke인 완주 제출을 만들고, 서버와 동일한 stats로 clientScore(= 정답)를 미리
 * 계산해 둔다(점수 위조가 아닌 한 ⑨ score_mismatch가 뜨지 않도록). errors=0 → maxCombo=세트 길이.
 */
function buildSubmission(msPerKeystroke: number): BuiltSubmission {
  const countries = SET.map((id) => BY_ID.get(id)!);
  const perCountry = countries.map((c) => {
    const L = requiredKeystrokes(c, LANG);
    return { code: c.id, ms: L * msPerKeystroke, keystrokes: L, errors: 0, skipped: false, inputUsed: c.nameEn };
  });
  const totalKeystrokes = perCountry.reduce((a, p) => a + p.keystrokes, 0);
  const elapsedMs = perCountry.reduce((a, p) => a + p.ms, 0);
  const scoreCountries: ScoreCountry[] = countries.map((c) => ({
    nameKo: c.nameKo,
    nameEn: c.nameEn,
    difficultyTier: c.difficultyTier,
  }));
  const result = {
    elapsedMs,
    totalKeystrokes,
    correctKeystrokes: totalKeystrokes,
    maxCombo: SET.length,
    countriesCleared: SET.length,
    countriesSkipped: 0,
    livesLost: 0,
    finished: true,
    perCountry,
  };
  const expected = computeScore(
    {
      totalKeystrokes,
      correctKeystrokes: totalKeystrokes,
      elapsedMs,
      maxCombo: SET.length,
      countriesCleared: SET.length,
      countriesSkipped: 0,
      perCountry: perCountry.map((p) => ({ code: p.code, ms: p.ms, errors: p.errors, skipped: p.skipped })),
    },
    scoreCountries,
    LANG,
  );
  return { result, clientScore: expected.finalScore, scoreCountries };
}

function makeParams(
  built: BuiltSubmission,
  overrides: Partial<{
    sessionPid: string;
    tokenPid: string;
    startTs: number;
    now: number;
    alreadyUsed: boolean;
    rebuiltSetHash: string;
    tokenSetHash: string;
    fullSet: CountryId[];
    clientScore: number;
    digest: InputDigest;
    personal: RunVerifyParams["personal"];
    resultPatch: Partial<RunVerifyParams["submit"]["result"]>;
  }> = {},
): RunVerifyParams {
  const now = overrides.now ?? NOW;
  const startTs = overrides.startTs ?? now - built.result.elapsedMs; // serverElapsed = elapsedMs
  const token: RunTokenPayload = {
    rid: "run-1",
    pid: overrides.tokenPid ?? "PID-A",
    mode: "worldtour",
    modeKey: "worldtour",
    lang: LANG,
    platform: "desktop",
    setHash: overrides.tokenSetHash ?? SETHASH,
    seed: "fixed:worldtour",
    startTs,
    exp: startTs + RUN_TOKEN_TTL_MS,
  };
  return {
    sessionPid: overrides.sessionPid ?? "PID-A",
    token,
    rebuiltSetHash: overrides.rebuiltSetHash ?? SETHASH,
    fullSet: overrides.fullSet ?? SET,
    alreadyUsed: overrides.alreadyUsed ?? false,
    submit: {
      result: { ...built.result, ...overrides.resultPatch },
      clientScore: overrides.clientScore ?? built.clientScore,
      inputDigest: overrides.digest ?? HUMAN_DIGEST,
    },
    now,
    runTokenTtlMs: RUN_TOKEN_TTL_MS,
    config: DEFAULT_ANTICHEAT_CONFIG,
    personal: overrides.personal ?? { sampleSize: 0, bestPi: null, isFirstSubmission: true },
  };
}

describe("verifyRun — 정상 제출(골든 벡터)", () => {
  it("검증 전 단계 통과 → verdict='valid' + 서버 재계산 = computeScore 값", () => {
    const built = buildSubmission(80); // cpm = 60000/80 = 750 (하드/소프트캡 아래)
    const vr = verifyRun(makeParams(built));
    expect(vr.verdict).toBe("valid");
    expect(vr.verdictReason).toBeNull();
    expect(vr.flags).toEqual([]);
    // 서버 재계산 값이 computeScore(권위)와 정확히 일치.
    expect(vr.server.score).toBe(built.clientScore);
    expect(vr.server.cpm).toBe(750);
    expect(vr.server.accMilli).toBe(1000);
    expect(vr.server.completed).toBe(true);
    expect(vr.server.maxCombo).toBe(SET.length);
  });
});

describe("verifyRun — 치트 6종(단위 수준)", () => {
  it("① 토큰 재사용(replay) → rejected/'replay'", () => {
    const vr = verifyRun(makeParams(buildSubmission(80), { alreadyUsed: true }));
    expect(vr.verdict).toBe("rejected");
    expect(vr.verdictReason).toBe("replay");
  });

  it("② 시간 압축(§3.3-d) → rejected/'time_envelope'", () => {
    // serverElapsed≈0인데 60초 플레이를 주장 → ③에서 즉시 reject.
    const built = buildSubmission(80);
    const vr = verifyRun(
      makeParams(built, { startTs: NOW, resultPatch: { elapsedMs: 60_000 } }),
    );
    expect(vr.verdict).toBe("rejected");
    expect(vr.verdictReason).toBe("time_envelope");
  });

  it("③ 점수 위조(⑨) → flagged/'score_mismatch' + 서버 값으로 덮어씀", () => {
    const built = buildSubmission(80);
    const vr = verifyRun(makeParams(built, { clientScore: built.clientScore + 100 }));
    expect(vr.verdict).toBe("flagged");
    expect(vr.flags).toContain("score_mismatch");
    // 클라가 위조한 값이 아니라 서버 재계산 값이 저장된다.
    expect(vr.server.score).toBe(built.clientScore);
  });

  it("④ 봇 리듬(digest stdev/mean<0.12) → flagged/'rhythm_uniform'", () => {
    const built = buildSubmission(80);
    const botDigest: InputDigest = { ...HUMAN_DIGEST, mean: 150, stdev: 5 }; // 0.033 < 0.12
    const vr = verifyRun(makeParams(built, { digest: botDigest }));
    expect(vr.verdict).toBe("flagged");
    expect(vr.flags).toContain("rhythm_uniform");
  });

  it("⑤ 붙여넣기(burstMax>3) → practice/'bulk_input'", () => {
    const built = buildSubmission(80);
    const pasteDigest: InputDigest = { ...HUMAN_DIGEST, burstMax: 5 };
    const vr = verifyRun(makeParams(built, { digest: pasteDigest }));
    expect(vr.verdict).toBe("practice");
    expect(vr.verdictReason).toBe("bulk_input");
  });

  it("⑥ 세트 불일치(④) → rejected/'set_mismatch'", () => {
    const built = buildSubmission(80);
    // 제출 코드의 첫 국가를 세트에 없는 다른 국가로 바꿔치기.
    const tampered = built.result.perCountry.map((p, i) =>
      i === 0 ? { ...p, code: "DE" as CountryId } : p,
    );
    const vr = verifyRun(makeParams(built, { resultPatch: { perCountry: tampered } }));
    expect(vr.verdict).toBe("rejected");
    expect(vr.verdictReason).toBe("set_mismatch");
  });
});

describe("verifyRun — reject 분기 개별 커버리지", () => {
  it("① pid 불일치 → rejected/'invalid_token'", () => {
    const vr = verifyRun(makeParams(buildSubmission(80), { sessionPid: "PID-A", tokenPid: "PID-B" }));
    expect(vr.verdict).toBe("rejected");
    expect(vr.verdictReason).toBe("invalid_token");
  });

  it("③ serverElapsed가 토큰 exp 폭 초과 → time_envelope", () => {
    const built = buildSubmission(80);
    const vr = verifyRun(makeParams(built, { startTs: NOW - (RUN_TOKEN_TTL_MS + 1) }));
    expect(vr.verdict).toBe("rejected");
    expect(vr.verdictReason).toBe("time_envelope");
  });

  it("④ setHash 무결성 불일치 → set_mismatch", () => {
    const vr = verifyRun(makeParams(buildSubmission(80), { rebuiltSetHash: "DIFFERENT" }));
    expect(vr.verdict).toBe("rejected");
    expect(vr.verdictReason).toBe("set_mismatch");
  });

  it("④ cleared/skipped 합계 불일치 → set_mismatch", () => {
    const built = buildSubmission(80);
    const vr = verifyRun(makeParams(built, { resultPatch: { countriesSkipped: 1 } }));
    expect(vr.verdict).toBe("rejected");
    expect(vr.verdictReason).toBe("set_mismatch");
  });

  it("⑤ 잘못된 inputUsed → input_invalid", () => {
    const built = buildSubmission(80);
    const bad = built.result.perCountry.map((p, i) => (i === 0 ? { ...p, inputUsed: "zzzzzz" } : p));
    const vr = verifyRun(makeParams(built, { resultPatch: { perCountry: bad } }));
    expect(vr.verdict).toBe("rejected");
    expect(vr.verdictReason).toBe("input_invalid");
  });

  it("⑤ 타수 하한(L_i) 미달 → input_invalid", () => {
    const built = buildSubmission(80);
    const bad = built.result.perCountry.map((p, i) => (i === 0 ? { ...p, keystrokes: 0 } : p));
    const vr = verifyRun(makeParams(built, { resultPatch: { perCountry: bad } }));
    expect(vr.verdict).toBe("rejected");
    expect(vr.verdictReason).toBe("input_invalid");
  });

  it("⑥ Σms 봉투 벗어남 → stats_mismatch", () => {
    const built = buildSubmission(80);
    // elapsedMs만 2배로 부풀리면 Σms가 하한 밑으로. (startTs도 맞춰 ③은 통과시킨다.)
    const infl = built.result.elapsedMs * 2;
    const vr = verifyRun(
      makeParams(built, { resultPatch: { elapsedMs: infl }, startTs: NOW - infl }),
    );
    expect(vr.verdict).toBe("rejected");
    expect(vr.verdictReason).toBe("stats_mismatch");
  });

  it("⑥ 타수 재계산 불일치 → stats_mismatch", () => {
    const built = buildSubmission(80);
    const vr = verifyRun(
      makeParams(built, { resultPatch: { totalKeystrokes: built.result.totalKeystrokes + 5 } }),
    );
    expect(vr.verdict).toBe("rejected");
    expect(vr.verdictReason).toBe("stats_mismatch");
  });

  it("⑦ 물리 한계(ms < L_i×35) → impossible_speed", () => {
    // 한 국가의 ms를 최소 밑으로 낮추고, 뺀 시간을 다른 국가에 더해 Σms(⑥)·CPM(⑧)은 유지.
    const built = buildSubmission(80);
    const per = built.result.perCountry;
    const first = per[0]!;
    const L0 = first.keystrokes;
    const moved = first.ms - L0 * 10; // 10ms/키로 낮춤(35 미만)
    const tampered = per.map((p, i) => {
      if (i === 0) return { ...p, ms: L0 * 10 };
      if (i === 1) return { ...p, ms: p.ms + moved };
      return p;
    });
    const vr = verifyRun(makeParams(built, { resultPatch: { perCountry: tampered } }));
    expect(vr.verdict).toBe("rejected");
    expect(vr.verdictReason).toBe("impossible_speed");
  });

  it("⑧ CPM 하드캡 초과 → impossible_cpm", () => {
    // ms=L×40 → cpm=1500 > 1000(en 하드캡). ⑦(≥35)은 통과.
    const built = buildSubmission(40);
    const vr = verifyRun(makeParams(built));
    expect(vr.verdict).toBe("rejected");
    expect(vr.verdictReason).toBe("impossible_cpm");
  });
});

describe("verifyRun — flag 분기 개별 커버리지", () => {
  it("⑩ CPM 소프트캡 초과 → flagged/'cpm_soft_cap'", () => {
    // ms=L×63 → cpm=952 (>900 소프트, <1000 하드).
    const built = buildSubmission(63);
    const vr = verifyRun(makeParams(built));
    expect(vr.verdict).toBe("flagged");
    expect(vr.flags).toContain("cpm_soft_cap");
  });

  it("⑩ 개인 성장 점프(+60% & 표본≥5) → flagged/'growth_jump'", () => {
    const built = buildSubmission(80); // server.pi = 750
    const vr = verifyRun(
      makeParams(built, { personal: { sampleSize: 5, bestPi: 400, isFirstSubmission: false } }),
    );
    expect(vr.verdict).toBe("flagged");
    expect(vr.flags).toContain("growth_jump");
  });

  it("⑩ ACC100% & CPM>800 & 첫 제출 → flagged/'acc_combo'", () => {
    const built = buildSubmission(70); // cpm = 857 (>800, <900)
    const vr = verifyRun(
      makeParams(built, { personal: { sampleSize: 0, bestPi: null, isFirstSubmission: true } }),
    );
    expect(vr.verdict).toBe("flagged");
    expect(vr.flags).toContain("acc_combo");
  });

  it("⑩ p90−p10 < 25ms → flagged/'rhythm_uniform'", () => {
    const built = buildSubmission(80);
    const tight: InputDigest = { ...HUMAN_DIGEST, p10: 140, p90: 155 };
    const vr = verifyRun(makeParams(built, { digest: tight }));
    expect(vr.verdict).toBe("flagged");
    expect(vr.flags).toContain("rhythm_uniform");
  });
});
