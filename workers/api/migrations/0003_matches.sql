-- spec: docs/05 §10.1(matches/match_participants 전문)
-- WT-M3-01 [산출물]: 이 작업 블록의 산출물 명명은 0003_matches.sql이다 — docs/05 §10.1 원문 내
-- SQL 블록 첫 줄 주석("-- migrations/0004_matches.sql")은 05 문서 자체의 예시 표기일 뿐,
-- docs/07 WT-M3-01의 산출물 목록(0001~0004 배치)이 실제 파일명 계약이므로 그쪽을 따른다.
-- 마이그레이션은 append-only — 이후 변경은 0005_*.sql 이상으로 추가할 것, 이 파일 수정 금지.

CREATE TABLE IF NOT EXISTS matches (
  id             TEXT PRIMARY KEY,             -- raceId (ULID)
  room_code      TEXT NOT NULL,
  lang           TEXT NOT NULL CHECK (lang IN ('ko','en')),
  mode           TEXT NOT NULL,                -- 'race-mixed' | 'race-continent' | 'race-tier'
  pool_param     TEXT,
  seed           TEXT NOT NULL,                -- 32-hex
  country_ids    TEXT NOT NULL,                -- JSON array, 재현/리플레이용
  data_version   TEXT NOT NULL,
  started_at     INTEGER NOT NULL,             -- epoch ms
  finished_at    INTEGER NOT NULL,
  finish_reason  TEXT NOT NULL CHECK (finish_reason IN ('all-finished','hardcap','all-left')),
  player_count   INTEGER NOT NULL,
  is_bot_match   INTEGER NOT NULL DEFAULT 0,
  rematch_of     TEXT REFERENCES matches(id)   -- 리매치 체인 추적
);

CREATE TABLE IF NOT EXISTS match_participants (
  match_id           TEXT NOT NULL REFERENCES matches(id),
  player_id          TEXT NOT NULL,
  nickname           TEXT NOT NULL,
  is_guest           INTEGER NOT NULL,
  is_bot             INTEGER NOT NULL DEFAULT 0,
  rank               INTEGER NOT NULL,
  finished           INTEGER NOT NULL,
  countries_cleared  INTEGER NOT NULL,
  elapsed_ms         INTEGER,                  -- 완주자만
  correct_keystrokes INTEGER NOT NULL,
  error_keystrokes   INTEGER NOT NULL,
  cpm                INTEGER NOT NULL,
  acc                REAL NOT NULL,
  pi                 INTEGER NOT NULL,
  disconnected       INTEGER NOT NULL DEFAULT 0,
  suspicion          TEXT,                     -- JSON array of flags, null이면 클린
  avg_rtt_ms         INTEGER,                  -- docs/05 §8-5 정책 데이터
  PRIMARY KEY (match_id, player_id)
);

CREATE INDEX IF NOT EXISTS idx_mp_player  ON match_participants(player_id, match_id);
CREATE INDEX IF NOT EXISTS idx_matches_at ON matches(started_at);
