// spec: docs/00 §6 (workers/api — 단일 Cloudflare Worker), WT-M0-01
//
// M0 스캐폴드용 빈 껍데기. Hono app + wrangler.toml 3환경 + /api/v1/health는
// WT-M0-02에서 채운다(참고: docs/04 §1.2·§2.4·§7, docs/00 §7·§11-D8).

export const API_PACKAGE_NAME = "@wt/api" as const;
