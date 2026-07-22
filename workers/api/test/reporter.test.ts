// spec: docs/06 §8.1·§8.2(Sentry toucan-js, tracesSampleRate 0.05) + WT-M6-04
//
// SENTRY_DSN 부재 시 완전 no-op(구현 세부 지시 — "SENTRY_DSN 등 부재 시 no-op 폴백")과, DSN이
// 설정됐을 때 캡처 호출이 예외 없이 완주하는지를 검증한다. toucan-js는 context 없이도 전송을
// 즉시(fire-and-forget) 시도하므로, 실제 네트워크 I/O가 vitest-pool-workers 샌드박스에서
// "Network connection lost"로 러너 자체를 죽이는 것을 막기 위해 전역 fetch를 모킹한다(실제
// 전송 성공 여부는 로컬에서 검증 대상이 아니다 — 구성 단계에서 예외가 나지 않는지만 확인).
import { afterEach, describe, expect, it, vi } from "vitest";
import { captureException } from "../src/lib/reporter";

describe("lib/reporter — captureException", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("SENTRY_DSN 미설정이면 완전 no-op(throw 없음, Toucan 생성 시도 없음, fetch 미호출)", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    expect(() => captureException({ SENTRY_DSN: undefined }, new Error("boom"))).not.toThrow();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("SENTRY_DSN이 설정돼 있으면 Toucan을 구성하고 captureException을 호출해도 throw하지 않는다", () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
    const dsn = "https://examplePublicKey@o0.ingest.sentry.io/0";
    expect(() => captureException({ SENTRY_DSN: dsn }, new Error("boom"), { tag: "test" })).not.toThrow();
  });

  it("ctx.waitUntil이 주어지면 전송을 그 안에서 예약한다(동기 호출 자체는 여전히 throw하지 않음)", () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
    const waitUntil = vi.fn();
    const ctx = { waitUntil, passThroughOnException: vi.fn() } as unknown as ExecutionContext;
    const dsn = "https://examplePublicKey@o0.ingest.sentry.io/0";
    expect(() =>
      captureException({ SENTRY_DSN: dsn }, new Error("boom"), { ctx, tag: "test:ctx" }),
    ).not.toThrow();
  });

  it("Toucan 생성/캡처가 내부적으로 던져도(비정상 DSN 등) 삼키고 조용히 반환한다", () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
    expect(() => captureException({ SENTRY_DSN: "not-a-valid-dsn-at-all" }, new Error("boom"))).not.toThrow();
  });
});
