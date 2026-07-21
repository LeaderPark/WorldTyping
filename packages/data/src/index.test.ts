// spec: WT-M0-01 — 더미 테스트(패키지 vitest 배선 확인용)
import { describe, expect, it } from "vitest";
import { DATA_PACKAGE_NAME } from "./index";

describe("@wt/data scaffold", () => {
  it("exposes its package name constant", () => {
    expect(DATA_PACKAGE_NAME).toBe("@wt/data");
  });
});
