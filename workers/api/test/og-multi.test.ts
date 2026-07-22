// spec: docs/06 §9.2(방 초대 /multi/:code OG SSR — 방 상태를 DO에서 조회해 <head>에 메타 주입,
//       만료/부재 시 대체 랜딩), docs/00 §11-D8 + WT-M6-02 [완료 조건]
//
// MatchRoom DO(internal/room-status)를 건드리므로 vitest.do.config.ts(isolatedStorage=false)에서만
// 실행한다(Windows EBUSY 회피 — vitest.workers.config.ts include 제외 + 이 파일은 do config include).
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("GET /multi/:code (방 초대 OG SSR)", () => {
  it("SPA index.html을 보존하면서 <head>에 OG 메타를 주입한다(부재 방 → 만료 대체 메타)", async () => {
    // 생성된 적 없는 방 코드 — roomInviteMeta가 roomCode:null을 보고 만료 대체 메타를 주입한다.
    const res = await SELF.fetch("http://local/multi/ZZ9-ZZ9");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/html");
    const html = await res.text();
    // SPA 셸 보존(React 마운트 지점).
    expect(html).toContain('id="root"');
    // OG 메타 주입 확인.
    expect(html).toContain('property="og:site_name" content="TypeTrip"');
    expect(html).toContain('property="og:title"');
    expect(html).toContain('name="twitter:card"');
  });

  it("형식 불량 코드 → 원본 index.html 폴백(SPA가 자체 처리, 200)", async () => {
    const res = await SELF.fetch("http://local/multi/!!!");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('id="root"');
  });
});
