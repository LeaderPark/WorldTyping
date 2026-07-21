-- spec: docs/06 §1.3(users/runs 전문) · §4.3(user_unlocks 전문) · docs/04 §4(daily_challenges 채택)
--       docs/00 §11-D9(06이 canonical) · §11-D10(device_id → device_hash) · §11-D14(닉네임 2~12자)
-- WT-M3-01: 0001 = users, runs, user_unlocks, daily_challenges, shares.
-- 마이그레이션은 append-only — 이후 변경은 0005_*.sql 이상으로 추가할 것, 이 파일 수정 금지.

-- 유저 (docs/06 §4에서 재확인)
CREATE TABLE users (
  user_id        TEXT PRIMARY KEY,                 -- UUIDv7 (시간정렬 가능)
  -- device_id 원문은 저장하지 않는다(§11-D10 절충 확정).
  -- device_hash = base58(HMAC(SESSION_HMAC_SECRET, deviceId)) — 결정적 파생이라 bootstrap 조회 가능
  -- + 원문 비저장으로 프라이버시 성질 유지(docs/04 §5.1 성질 계승).
  device_hash    TEXT NOT NULL UNIQUE,
  nickname       TEXT NOT NULL,                    -- 표시용 원문. 길이 2~12자(코드포인트, §11-D14), 검증은 app 레이어 NICK_RE
  nickname_norm  TEXT NOT NULL UNIQUE,              -- 중복검사용 정규화형, docs/06 §4.2
  passport_cover TEXT NOT NULL DEFAULT 'basic-green', -- 코스메틱 id, docs/06 §4.4
  geo            TEXT,                             -- 가입 시 CF-IPCountry (alpha-2, 'T1'/'XX'는 NULL 처리)
  status         TEXT NOT NULL DEFAULT 'active'
                 CHECK (status IN ('active','shadowbanned','banned','deleted')),
  streak_daily   INTEGER NOT NULL DEFAULT 0,
  streak_updated TEXT,                             -- 마지막 스트릭 인정일 'YYYY-MM-DD' (KST)
  created_at     INTEGER NOT NULL,                 -- epoch ms
  updated_at     INTEGER NOT NULL
);

-- 판 원장 (모든 제출 기록. 리더보드 반영 여부와 무관하게 append-only)
CREATE TABLE runs (
  run_id             TEXT PRIMARY KEY,             -- UUIDv7
  user_id            TEXT NOT NULL REFERENCES users(user_id),
  mode_key           TEXT NOT NULL,                -- docs/06 §1.1
  lang               TEXT NOT NULL CHECK (lang IN ('ko','en')),
  platform           TEXT NOT NULL CHECK (platform IN ('desktop','mobile')),
  score              INTEGER NOT NULL,
  pi                 INTEGER NOT NULL,             -- CPM × ACC² 반올림
  cpm                INTEGER NOT NULL,
  acc_milli          INTEGER NOT NULL,             -- ACC × 1000
  elapsed_ms         INTEGER NOT NULL,
  countries_cleared  INTEGER NOT NULL,
  countries_skipped  INTEGER NOT NULL,
  max_combo          INTEGER NOT NULL,
  completed          INTEGER NOT NULL,             -- 0/1
  grade              TEXT NOT NULL,                -- 'S'|'A'|'B'|'C'|'D'
  seed               TEXT,                         -- 티어/데일리/멀티 세트 시드
  session_id         TEXT NOT NULL,                -- 서명 세션 id (docs/06 §3.1)
  -- session_id는 UNIQUE 제약을 걸지 않는다: 재사용 방지는 KV `sess:{sid}` 사용 플래그(TTL 2h)로
  -- 수행하고(docs/06 §3.1), DB 유니크 제약은 그 목적이 아니다 — 동일 sid의 재시도/재수리 경로에서
  -- DB 레벨 충돌로 막으면 KV와 이중 진실 소스가 되어 재현·복구가 어려워진다.
  verdict            TEXT NOT NULL DEFAULT 'valid'
                     CHECK (verdict IN ('valid','practice','flagged','rejected')),
  verdict_reason     TEXT,                         -- 예: 'cpm_over_hard_cap', 'replay_variance_low'
  geo                TEXT,                         -- 제출 시 CF-IPCountry
  detail_json        TEXT NOT NULL,                -- perCountry 배열 등 원시 제출 페이로드 (docs/06 §3.2)
  created_at         INTEGER NOT NULL
);
CREATE INDEX idx_runs_user    ON runs (user_id, created_at DESC);
CREATE INDEX idx_runs_mode    ON runs (mode_key, created_at DESC);
CREATE INDEX idx_runs_flagged ON runs (verdict, created_at DESC) WHERE verdict IN ('flagged','rejected');

-- 코스메틱/업적 보유 (docs/06 §4.3 전문)
CREATE TABLE user_unlocks (
  user_id    TEXT NOT NULL REFERENCES users(user_id),
  unlock_type TEXT NOT NULL CHECK (unlock_type IN ('cover','stamp','achievement','tier')),
  unlock_id  TEXT NOT NULL,          -- 'cover:gold', 'stamp:continent:europe:S', 'ach:daily_30', 'tier:3'
  meta_json  TEXT,                   -- 스탬프의 완주일/등급 등
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, unlock_type, unlock_id)
) WITHOUT ROWID;

-- 데일리 챌린지 세트 확정본 (docs/04 §4에서 채택 — 사후 분쟁 방지를 위해 cron이 확정 저장)
CREATE TABLE daily_challenges (
  date_kst      TEXT PRIMARY KEY,            -- '2026-07-21'
  daily_no      INTEGER NOT NULL UNIQUE,
  seed          TEXT NOT NULL,
  country_ids   TEXT NOT NULL,               -- JSON array (10개)
  created_at    INTEGER NOT NULL
);

-- 공유용 결과 카드 단축 id (docs/06 §9.1)
CREATE TABLE shares (
  share_id   TEXT PRIMARY KEY,               -- 8자 base58
  run_id     TEXT NOT NULL REFERENCES runs(run_id),
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_shares_run ON shares (run_id);
