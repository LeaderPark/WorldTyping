// spec: docs/06 §10-1(www→apex 301), docs/00 §7 gotcha 7(오리진 하드코딩 금지), WT-M6-06
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("www → apex redirect (WT-M6-06)", () => {
  it("301s a www.* host to the same path on the apex host, preserving query", async () => {
    const res = await SELF.fetch("http://www.local/api/v1/health?fault=bogus", { redirect: "manual" });
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe("http://local/api/v1/health?fault=bogus");
  });

  it("does not touch requests that are already on the apex host", async () => {
    const res = await SELF.fetch("http://local/api/v1/health");
    expect(res.status).toBe(200);
  });

  it("carries the usual security headers on the redirect response too", async () => {
    const res = await SELF.fetch("http://www.local/api/v1/health", { redirect: "manual" });
    expect(res.status).toBe(301);
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Strict-Transport-Security")).toContain("max-age=");
  });
});
