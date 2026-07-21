-- spec: docs/06 §3.6(reports/admin_audit 전문)
-- WT-M3-01: 0004 = reports, admin_audit.
-- 마이그레이션은 append-only — 이후 변경은 0005_*.sql 이상으로 추가할 것, 이 파일 수정 금지.

CREATE TABLE reports (
  report_id  TEXT PRIMARY KEY, reporter_user_id TEXT NOT NULL,
  target_user_id TEXT NOT NULL, target_run_id TEXT,
  reason TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open','actioned','dismissed')),
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_reports_target ON reports (target_user_id, status);

CREATE TABLE admin_audit (
  audit_id TEXT PRIMARY KEY, operator TEXT NOT NULL, action TEXT NOT NULL,
  target TEXT NOT NULL, reason TEXT, created_at INTEGER NOT NULL
);
