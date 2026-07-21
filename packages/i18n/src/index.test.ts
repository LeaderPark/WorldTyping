// spec: WT-M0-01 — 더미 테스트(패키지 vitest 배선 확인용)
import { describe, expect, it } from "vitest";
import { I18N_PACKAGE_NAME } from "./index";

describe("@wt/i18n scaffold", () => {
  it("exposes its package name constant", () => {
    expect(I18N_PACKAGE_NAME).toBe("@wt/i18n");
  });
});
