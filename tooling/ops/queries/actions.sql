-- spec: docs/06 §8.4(런북 시나리오 5 "리더보드 오염(버그성 점수)") + WT-M6-04
-- 실행: npx wrangler d1 execute wt-main-{env} --env {env} [--local|--remote] --command "<한 문장>"
-- 이 파일은 조사 후 실제로 D1을 변경하는 조치용 문장 모음이다. review.sql로 대상을 먼저
-- 특정한 뒤 아래 문장의 <플레이스홀더>를 치환해 한 문장씩 실행할 것 — 배치 실행 금지
-- (append-only 원칙과 별개로, 조치는 되돌리기 어려우니 한 건씩 검증하며 진행).

-- ── A) 버그성/오염 run 1건 무효화(§5 시나리오) ────────────────────────────────
-- 1단계: run을 rejected로 재분류(원장은 보존 — append-only 정신, verdict만 갱신)
UPDATE runs
SET verdict = 'rejected', verdict_reason = 'manual_bug_fix'
WHERE run_id = '<run_id>';

-- 2단계: 리더보드에서 해당 행 제거(이미 최고 기록으로 등재된 경우만 영향)
DELETE FROM lb_best WHERE run_id = '<run_id>';

-- ── B) 신고 임계 도달 후 수동 검토 결과 반영 ──────────────────────────────────
-- 조치(action): 대상 유저 섀도우밴
UPDATE users SET status = 'shadowbanned', updated_at = (strftime('%s','now') * 1000)
WHERE user_id = '<user_id>';

-- 반려(dismiss): 신고 상태만 종료
UPDATE reports SET status = 'dismissed' WHERE report_id = '<report_id>';

-- 조치 완료: 신고 상태 갱신 + admin_audit 기록(§3.6 운영 감사 로그)
UPDATE reports SET status = 'actioned' WHERE target_user_id = '<user_id>' AND status = 'open';
INSERT INTO admin_audit (audit_id, operator, action, target, reason, created_at)
VALUES (lower(hex(randomblob(16))), '<operator_email>', 'shadowban', '<user_id>', '<reason>', (strftime('%s','now') * 1000));

-- ── C) 계정 복구(오탐 섀도우밴 해제) ──────────────────────────────────────────
UPDATE users SET status = 'active', updated_at = (strftime('%s','now') * 1000)
WHERE user_id = '<user_id>';
INSERT INTO admin_audit (audit_id, operator, action, target, reason, created_at)
VALUES (lower(hex(randomblob(16))), '<operator_email>', 'unshadowban', '<user_id>', '<reason>', (strftime('%s','now') * 1000));
