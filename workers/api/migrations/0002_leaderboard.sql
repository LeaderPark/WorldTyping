-- spec: docs/06 §1.3(lb_best/seasons 전문) · §1.2(랭킹 키 정의) · §5.4(kpi_daily 용도 — 전문 DDL 미수록)
--       docs/00 §11-D9(06이 canonical) · §11-D24(1분 dirty cron + 단일 KV lb: 프리픽스)
-- WT-M3-01: 0002 = lb_best(+idx_lb_rank/idx_lb_geo), seasons, kpi_daily.
-- 마이그레이션은 append-only — 이후 변경은 0005_*.sql 이상으로 추가할 것, 이 파일 수정 금지.

-- 보드별 유저 베스트 (materialized — 조회의 주 대상)
CREATE TABLE lb_best (
  board_key   TEXT NOT NULL,
  user_id     TEXT NOT NULL,
  run_id      TEXT NOT NULL,
  score       INTEGER NOT NULL,
  elapsed_ms  INTEGER NOT NULL,
  acc_milli   INTEGER NOT NULL,
  achieved_at INTEGER NOT NULL,
  geo         TEXT,                                 -- 지역 보드 필터용 (제출 시점 스냅샷)
  PRIMARY KEY (board_key, user_id)
) WITHOUT ROWID;

-- 순위 스캔용 복합 인덱스 — docs/06 §1.2 랭킹 키와 완전 동일한 순서.
-- 순서 하나라도 다르면 순위 불일치 버그(docs/07 WT-M3-01 구현 세부 지시 #3).
CREATE INDEX idx_lb_rank ON lb_best
  (board_key, score DESC, elapsed_ms ASC, acc_milli DESC, achieved_at ASC);
-- 지역 보드용
CREATE INDEX idx_lb_geo  ON lb_best
  (board_key, geo, score DESC, elapsed_ms ASC, acc_milli DESC, achieved_at ASC);

-- 시즌 메타 (docs/00 §11-D15: v1 스코프에서는 스키마만 예약, UI·운영 미노출)
CREATE TABLE seasons (
  season_id TEXT PRIMARY KEY,        -- 's:2026q3'
  starts_at INTEGER NOT NULL,        -- epoch ms, KST 경계
  ends_at   INTEGER NOT NULL
);

-- 일 1회 KPI 스냅샷 (docs/06 §5.4 노스스타/보조 지표 원천, §8.3 /ops 대시보드가 조회).
-- 주의: docs/06·07 어디에도 이 테이블의 컬럼 전문(DDL)은 수록되어 있지 않다(§5.4는 지표
-- 목록만 서술). 아래 컬럼은 §5.4에 열거된 지표(WCR 산출용 완주판수, DAU, 데일리 참여율,
-- K-factor 근사, 매치 성사율/대기시간, 부정 기록 비율)를 하루 단위로 적재할 수 있도록 이번
-- 구현에서 합리적으로 설계한 것 — 리드 확인 전까지 잠정안으로 취급할 것(최종 보고 escalations 참조).
CREATE TABLE kpi_daily (
  date_kst                  TEXT PRIMARY KEY,        -- 'YYYY-MM-DD' KST
  dau                       INTEGER NOT NULL DEFAULT 0,
  completed_runs            INTEGER NOT NULL DEFAULT 0, -- WCR(주간 완주 판수)는 대시보드에서 7일 합산
  daily_play_users          INTEGER NOT NULL DEFAULT 0, -- §5.4 데일리 참여율(DAU 중 daily_play 비율) 분자
  share_clicks              INTEGER NOT NULL DEFAULT 0,
  share_driven_visits       INTEGER NOT NULL DEFAULT 0, -- K-factor 근사 분자(§5.4)
  matchmaking_queued        INTEGER NOT NULL DEFAULT 0,
  matchmaking_started       INTEGER NOT NULL DEFAULT 0, -- 매치 성사율 = started/queued
  matchmaking_wait_ms_sum   INTEGER NOT NULL DEFAULT 0, -- 평균 매칭 대기 = sum/started
  flagged_runs              INTEGER NOT NULL DEFAULT 0,
  rejected_runs             INTEGER NOT NULL DEFAULT 0,
  total_runs                INTEGER NOT NULL DEFAULT 0, -- 부정 기록 비율 = (flagged+rejected)/total_runs
  created_at                INTEGER NOT NULL
);
