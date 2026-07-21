// spec: docs/06 §10-6(무결성 리허설: 치트 6종 E2E가 CI에서 그린)·§3.1~§3.5(검증 파이프라인·
//       섀도우밴), docs/04 §6.2(검증 실패 사유 카탈로그 — 명명은 04, 실제 어휘·HTTP 상태는 06/
//       run-verify.ts가 canonical, 아래 escalation 참조), docs/00 §8-M3 완료조건①, WT-M3-07.
//
// Playwright `request` 컨텍스트(APIRequestContext)로 wrangler dev(로컬, 8787)의 /api/v1/*를
// 직접 공격한다 — 브라우저 페이지가 필요 없다(작업 특이 조정). 시나리오마다 독립 계정(신규
// deviceId)을 발급해(forge.bootstrapSession) 섀도우밴 등 계정 상태 오염이 다른 시나리오로
// 번지지 않게 한다.
//
// [문서 충돌 — 최종 보고 escalations 동일 기재] docs/04 §6.2 표는 실패를 401/409 + 명명된
// 코드(INVALID_TOKEN/RUN_ALREADY_SUBMITTED/TIME_ENVELOPE/...)로 응답한다고 서술하지만, 실제
// 구현(runs.ts·run-verify.ts, docs/06 §3.1 계승)은 **모든 케이스가 HTTP 200 + body.verdict**로
// 응답하고 verdict_reason은 DB에만 적재해 응답에는 노출하지 않는다(어뷰저에게 탐지 신호를 주지
// 않기 위한 의도적 shadow 설계). 이 스펙은 실제 동작(06/코드)을 기준으로 HTTP status는 200을
// 기대하고, "정확한 실패 코드"는 로컬 D1을 직접 조회(forge.queryRunRow)해 검증한다.
import { expect, test } from '@playwright/test';
import {
  bootstrapSession,
  buildBaseline,
  queryRunRow,
  queryUserStatus,
  startRun,
  submitRun,
  type SubmitBody,
} from '../helpers/forge';

const LANG = 'en' as const;

/** south-america(12개국, §11-D3)가 6대륙 중 가장 작아 대기시간이 최소화된다. */
const START_INPUT = { mode: 'continent' as const, continent: 'south-america' };

// describe 타이틀에 영문 'cheat'를 반드시 포함한다 — acceptance `pnpm e2e --grep cheat`가
// 이 그룹 전체를 --grep(정규식, 타이틀 매치)으로 선택하는 유일한 근거다.
test.describe('cheat-suite: 치트 시나리오 종단 E2E (docs/06 §10-6)', () => {
  test('베이스라인: 물리적으로 타당한 정상 제출 → valid + 리더보드 반영', async ({ request }) => {
    const session = await bootstrapSession(request);
    const started = await startRun(request, session, START_INPUT, LANG);
    const baseline = buildBaseline(started, LANG);

    const res = await submitRun(request, session, started, baseline.body, baseline.waitMs);

    expect(res.status).toBe(200);
    expect(res.json.verdict).toBe('valid');
    expect(res.json.rank).not.toBeNull();
    expect(res.json.isPersonalBest).toBe(true);
    expect(queryRunRow(started.runId)).toMatchObject({ verdict: 'valid', verdict_reason: null });
  });

  test('① 토큰 재사용(replay) — 동일 runToken 재제출 차단', async ({ request }) => {
    const session = await bootstrapSession(request);
    const started = await startRun(request, session, START_INPUT, LANG);
    const baseline = buildBaseline(started, LANG);

    const first = await submitRun(request, session, started, baseline.body, baseline.waitMs);
    expect(first.json.verdict).toBe('valid'); // 베이스라인 자체는 정상 통과해야 재사용 공격의 의미가 있다.

    // 동일 runToken으로 즉시 재제출(대기 불필요 — 이미 소비된 토큰이라 시간봉투 이전에 걸린다).
    const second = await submitRun(request, session, started, baseline.body, 0);
    expect(second.status).toBe(200); // docs/06 §3.1: rejected도 HTTP 200.
    expect(second.json.verdict).toBe('rejected');
    // 주의: 재사용은 새 runs 행을 만들지 않는다(run_id PK로 첫 제출 행만 존재) — DB에 별도
    // verdict_reason='replay' 레코드가 남지 않는 게 정상이라, 이 시나리오만 HTTP verdict로
    // 판정한다(run-verify.ts의 reject('replay', ...) 분기가 INSERT 이전에 조기 반환하기 때문).
    expect(queryRunRow(started.runId)).toMatchObject({ verdict: 'valid' });
  });

  test('② 시간 압축(속도 위조) — 국가별 ms를 물리 한계 밑으로 압축 → impossible_speed', async ({
    request,
  }) => {
    const session = await bootstrapSession(request);
    const started = await startRun(request, session, START_INPUT, LANG);
    const baseline = buildBaseline(started, LANG);

    // minMsPerKeystroke=35(§11-D12)의 한참 아래인 10ms/키로 전 국가를 압축 — elapsedMs·Σms도
    // 압축치에 맞춰 재정합해 stats_mismatch가 아니라 impossible_speed에서 먼저 걸리게 한다.
    const compressed: SubmitBody = structuredClone(baseline.body);
    compressed.result.perCountry = compressed.result.perCountry.map((p) => ({
      ...p,
      ms: p.keystrokes * 10,
    }));
    const newElapsedMs = compressed.result.perCountry.reduce((sum, p) => sum + p.ms, 0);
    compressed.result.elapsedMs = newElapsedMs;

    const res = await submitRun(request, session, started, compressed, newElapsedMs);

    expect(res.status).toBe(200);
    expect(res.json.verdict).toBe('rejected');
    expect(queryRunRow(started.runId)).toMatchObject({
      verdict: 'rejected',
      verdict_reason: 'impossible_speed',
    });
  });

  test('③ 점수 위조 — clientScore를 서버 재계산치+1000으로 신고 → flagged(score_mismatch)', async ({
    request,
  }) => {
    const session = await bootstrapSession(request);
    const started = await startRun(request, session, START_INPUT, LANG);
    const baseline = buildBaseline(started, LANG);

    const forged: SubmitBody = structuredClone(baseline.body);
    forged.clientScore = baseline.body.clientScore + 1000;

    const res = await submitRun(request, session, started, forged, baseline.waitMs);

    expect(res.status).toBe(200);
    // 서버는 항상 재계산치로 응답을 덮어쓴다 — 클라가 우긴 값이 새어나가지 않는다.
    expect(res.json.score).toBe(baseline.body.clientScore);
    expect(res.json.verdict).toBe('flagged');
    expect(queryRunRow(started.runId)).toMatchObject({
      verdict: 'flagged',
      verdict_reason: 'score_mismatch',
    });
  });

  test('④ 봇 리듬 — inputDigest 표준편차를 거의 0으로 신고 → flagged(rhythm_uniform)', async ({
    request,
  }) => {
    const session = await bootstrapSession(request);
    const started = await startRun(request, session, START_INPUT, LANG);
    const baseline = buildBaseline(started, LANG);

    const bot: SubmitBody = structuredClone(baseline.body);
    // stdev/mean < 0.12(§11-D12) — 사람은 이렇게 등간격으로 타이핑하지 못한다(봇 시그니처).
    bot.inputDigest = { n: bot.inputDigest.n, mean: 90, stdev: 1, p10: 89, p50: 90, p90: 91, burstMax: 0 };

    const res = await submitRun(request, session, started, bot, baseline.waitMs);

    expect(res.status).toBe(200);
    expect(res.json.verdict).toBe('flagged');
    expect(queryRunRow(started.runId)).toMatchObject({
      verdict: 'flagged',
      verdict_reason: 'rhythm_uniform',
    });
  });

  test('⑤ 붙여넣기(벌크 입력) — burstMax>임계 자진신고 → practice 강등(bulk_input)', async ({
    request,
  }) => {
    const session = await bootstrapSession(request);
    const started = await startRun(request, session, START_INPUT, LANG);
    const baseline = buildBaseline(started, LANG);

    const pasted: SubmitBody = structuredClone(baseline.body);
    pasted.inputDigest = { ...pasted.inputDigest, burstMax: 10 }; // burstMaxThreshold=3(§11-D12) 초과.

    const res = await submitRun(request, session, started, pasted, baseline.waitMs);

    expect(res.status).toBe(200);
    expect(res.json.verdict).toBe('practice');
    expect(queryRunRow(started.runId)).toMatchObject({
      verdict: 'practice',
      verdict_reason: 'bulk_input',
    });
  });

  test('⑥ 세트 불일치 — perCountry 코드 순서를 fullSet 접두와 다르게 신고 → rejected(set_mismatch)', async ({
    request,
  }) => {
    const session = await bootstrapSession(request);
    const started = await startRun(request, session, START_INPUT, LANG);
    const baseline = buildBaseline(started, LANG, { countCleared: 2 });

    const mismatched: SubmitBody = structuredClone(baseline.body);
    // 2개국을 서로 바꿔치기 — fullSet[0..1] prefix와 더 이상 일치하지 않는다.
    const [a, b] = mismatched.result.perCountry;
    mismatched.result.perCountry = [b!, a!];

    const res = await submitRun(request, session, started, mismatched, baseline.waitMs);

    expect(res.status).toBe(200);
    expect(res.json.verdict).toBe('rejected');
    expect(queryRunRow(started.runId)).toMatchObject({
      verdict: 'rejected',
      verdict_reason: 'set_mismatch',
    });
  });

  test('⑦ 섀도우밴 — rejected 3회 누적 후 4번째(정상) 제출부터 리더보드 미반영', async ({ request }) => {
    const session = await bootstrapSession(request);

    // rejectedShadowbanThreshold=3(§11-D12) 도달까지 세트 불일치로 3연속 reject를 쌓는다.
    for (let i = 0; i < 3; i++) {
      const started = await startRun(request, session, START_INPUT, LANG);
      const baseline = buildBaseline(started, LANG, { countCleared: 2 });
      const mismatched: SubmitBody = structuredClone(baseline.body);
      const [a, b] = mismatched.result.perCountry;
      mismatched.result.perCountry = [b!, a!];

      const res = await submitRun(request, session, started, mismatched, baseline.waitMs);
      expect(res.json.verdict).toBe('rejected');
    }

    expect(queryUserStatus(session.playerId)).toBe('shadowbanned');

    // 4번째는 완전히 정상적인 제출이다 — verdict 자체는 여전히 'valid'가 나오지만(shadow 원칙:
    // 본인 화면엔 정상 표시, docs/06 §3.5), 리더보드에는 반영되지 않아야 한다(rank/total/
    // isPersonalBest가 전부 null).
    const started = await startRun(request, session, START_INPUT, LANG);
    const baseline = buildBaseline(started, LANG);
    const res = await submitRun(request, session, started, baseline.body, baseline.waitMs);

    expect(res.json.verdict).toBe('valid');
    expect(res.json.rank).toBeNull();
    expect(res.json.total).toBeNull();
    expect(res.json.isPersonalBest).toBeNull();
  });
});
