-- spec: docs/06 §8.4(런북 — 리더보드 오염/치트 웨이브 대응 조사 쿼리) + WT-M6-04
-- 실행: npx wrangler d1 execute wt-main-{env} --env {env} [--local|--remote] --json --file tooling/ops/queries/review.sql
-- (또는 --command로 섹션 하나씩 실행 — 아래는 여러 SELECT를 순서대로 붙여둔 조사용 모음이다.
--  파라미터 자리(:xxx로 표기)는 wrangler d1 execute가 바인딩 파라미터를 지원하지 않으므로
--  실행 전 값을 직접 치환할 것 — CLI 스크립트가 아니라 사람이 조사할 때 쓰는 참고 쿼리 모음이다.)

-- ── 1) 최근 N시간 verdict 분포(치트 웨이브 1차 진단) ──────────────────────────────
SELECT verdict, COUNT(*) AS n
FROM runs
WHERE created_at >= (strftime('%s','now') * 1000) - 6 * 60 * 60 * 1000
GROUP BY verdict
ORDER BY n DESC;

-- ── 2) 최근 고득점 이상치(리더보드 오염 조사, §5) — 동일 보드 상위 20 대비 비정상 튀는 값 ──
SELECT run_id, user_id, mode_key, lang, platform, score, pi, cpm, acc_milli, elapsed_ms, verdict, created_at
FROM runs
WHERE verdict = 'valid'
ORDER BY pi DESC
LIMIT 50;

-- ── 3) 특정 유저의 최근 제출 이력(신고/조사 대상 단건 검토) ───────────────────────
-- user_id를 실제 값으로 치환
SELECT run_id, mode_key, verdict, verdict_reason, score, cpm, acc_milli, elapsed_ms, created_at
FROM runs
WHERE user_id = '<user_id>'
ORDER BY created_at DESC
LIMIT 30;

-- ── 4) flagged 급증 구간 탐색(시간대별 버킷) ──────────────────────────────────
SELECT (created_at / (5*60*1000)) AS bucket_5min, COUNT(*) AS total,
       SUM(CASE WHEN verdict IN ('flagged','rejected') THEN 1 ELSE 0 END) AS bad
FROM runs
WHERE created_at >= (strftime('%s','now') * 1000) - 24 * 60 * 60 * 1000
GROUP BY bucket_5min
ORDER BY bucket_5min DESC
LIMIT 50;

-- ── 5) 열린 신고(§3.6) 대상별 집계 — 신고 임계(5건) 근접 확인 ──────────────────
SELECT target_user_id, COUNT(*) AS open_reports
FROM reports
WHERE status = 'open'
GROUP BY target_user_id
ORDER BY open_reports DESC
LIMIT 30;

-- ── 6) 섀도우밴 대상 확인 ────────────────────────────────────────────────────
SELECT user_id, nickname, status, updated_at
FROM users
WHERE status = 'shadowbanned'
ORDER BY updated_at DESC
LIMIT 50;

-- ── 7) D1 용량/성능 참고(§8.2 "D1 용량/성능 | 주간 Cron 리포트") ──────────────
SELECT
  (SELECT COUNT(*) FROM users) AS users_count,
  (SELECT COUNT(*) FROM runs) AS runs_count,
  (SELECT COUNT(*) FROM lb_best) AS lb_best_count,
  (SELECT COUNT(*) FROM reports WHERE status='open') AS open_reports_count;
