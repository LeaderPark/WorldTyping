// spec: WT-M0-01 — 더미 테스트(패키지 vitest 배선 확인용, vitest-pool-workers 전환은 WT-M0-02)
import { describe, expect, it } from "vitest";
import { API_PACKAGE_NAME } from "./index";

describe("@wt/api scaffold", () => {
  it("exposes its package name constant", () => {
    expect(API_PACKAGE_NAME).toBe("@wt/api");
  });
});
