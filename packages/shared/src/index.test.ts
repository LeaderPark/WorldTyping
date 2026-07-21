// spec: WT-M0-01 — 더미 테스트(패키지 vitest 배선 확인용, 실 판정 테스트는 WT-M1-01)
import { describe, expect, it } from "vitest";
import { SHARED_PACKAGE_NAME } from "./index";

describe("@wt/shared scaffold", () => {
  it("exposes its package name constant", () => {
    expect(SHARED_PACKAGE_NAME).toBe("@wt/shared");
  });
});
