// spec: WT-M0-01 — 더미 테스트(패키지 vitest 배선 확인용, jsdom/RTL 도입은 이후 마일스톤)
import { describe, expect, it } from "vitest";
import { APP_NAME } from "./constants";

describe("@wt/web scaffold", () => {
  it("exposes the app name constant", () => {
    expect(APP_NAME).toBe("WORLD TYPING");
  });
});
