// spec: docs/06 §1.3(users/runs/lb_best/seasons)·§3.6(reports/admin_audit)·§4.3(user_unlocks),
//       docs/04 §4(daily_challenges)·§9.1(shares), docs/05 §10.1(matches/match_participants)
//       docs/00 §11-D9,D10 반영 — workers/api/migrations/000{1..4}_*.sql의 행 타입 수동 미러.
// WT-M3-01: D1 쿼리 결과 캐스팅용 타입만 정의한다(런타임 검증 없음 — zod 스키마는 라우트 계층 소관).
// 컬럼이 마이그레이션과 어긋나면 버그다 — SQL을 바꿀 때 반드시 이 파일도 같이 갱신할 것.

// ---- 0001_users_runs.sql ---------------------------------------------------

export interface UserRow {
  user_id: string;
  device_hash: string;
  nickname: string;
  nickname_norm: string;
  passport_cover: string;
  geo: string | null;
  status: "active" | "shadowbanned" | "banned" | "deleted";
  streak_daily: number;
  streak_updated: string | null;
  created_at: number;
  updated_at: number;
}

export type RunLang = "ko" | "en";
export type RunPlatform = "desktop" | "mobile";
export type RunVerdict = "valid" | "practice" | "flagged" | "rejected";
export type RunGrade = "S" | "A" | "B" | "C" | "D";

export interface RunRow {
  run_id: string;
  user_id: string;
  mode_key: string;
  lang: RunLang;
  platform: RunPlatform;
  score: number;
  pi: number;
  cpm: number;
  acc_milli: number;
  elapsed_ms: number;
  countries_cleared: number;
  countries_skipped: number;
  max_combo: number;
  completed: 0 | 1;
  grade: RunGrade;
  seed: string | null;
  session_id: string;
  verdict: RunVerdict;
  verdict_reason: string | null;
  geo: string | null;
  detail_json: string;
  created_at: number;
}

export type UnlockType = "cover" | "stamp" | "achievement" | "tier";

export interface UserUnlockRow {
  user_id: string;
  unlock_type: UnlockType;
  unlock_id: string;
  meta_json: string | null;
  created_at: number;
}

export interface DailyChallengeRow {
  date_kst: string;
  daily_no: number;
  seed: string;
  country_ids: string; // JSON array
  created_at: number;
}

export interface ShareRow {
  share_id: string;
  run_id: string;
  created_at: number;
}

// ---- 0002_leaderboard.sql ---------------------------------------------------

export interface LbBestRow {
  board_key: string;
  user_id: string;
  run_id: string;
  score: number;
  elapsed_ms: number;
  acc_milli: number;
  achieved_at: number;
  geo: string | null;
}

export interface SeasonRow {
  season_id: string;
  starts_at: number;
  ends_at: number;
}

// kpi_daily: docs/06 §5.4가 지표 목록만 서술하고 컬럼 전문(DDL)은 미수록 — 이번 구현에서
// 잠정 설계(최종 보고 escalations 참조). 리드 확정 전까지 이 타입도 잠정으로 취급.
export interface KpiDailyRow {
  date_kst: string;
  dau: number;
  completed_runs: number;
  daily_play_users: number;
  share_clicks: number;
  share_driven_visits: number;
  matchmaking_queued: number;
  matchmaking_started: number;
  matchmaking_wait_ms_sum: number;
  flagged_runs: number;
  rejected_runs: number;
  total_runs: number;
  created_at: number;
}

// ---- 0003_matches.sql ---------------------------------------------------

export type MatchMode = "race-mixed" | "race-continent" | "race-tier";
export type MatchFinishReason = "all-finished" | "hardcap" | "all-left";

export interface MatchRow {
  id: string;
  room_code: string;
  lang: RunLang;
  mode: MatchMode;
  pool_param: string | null;
  seed: string;
  country_ids: string; // JSON array
  data_version: string;
  started_at: number;
  finished_at: number;
  finish_reason: MatchFinishReason;
  player_count: number;
  is_bot_match: 0 | 1;
  rematch_of: string | null;
}

export interface MatchParticipantRow {
  match_id: string;
  player_id: string;
  nickname: string;
  is_guest: 0 | 1;
  is_bot: 0 | 1;
  rank: number;
  finished: 0 | 1;
  countries_cleared: number;
  elapsed_ms: number | null;
  correct_keystrokes: number;
  error_keystrokes: number;
  cpm: number;
  acc: number;
  pi: number;
  disconnected: 0 | 1;
  suspicion: string | null; // JSON array of flags
  avg_rtt_ms: number | null;
}

// ---- 0004_moderation.sql ---------------------------------------------------

export type ReportStatus = "open" | "actioned" | "dismissed";

export interface ReportRow {
  report_id: string;
  reporter_user_id: string;
  target_user_id: string;
  target_run_id: string | null;
  reason: string;
  status: ReportStatus;
  created_at: number;
}

export interface AdminAuditRow {
  audit_id: string;
  operator: string;
  action: string;
  target: string;
  reason: string | null;
  created_at: number;
}

// ---- 0005_auth_identities.sql ---------------------------------------------------

export interface AuthIdentityRow {
  provider: "google";
  subject: string;
  user_id: string;
  email: string | null;
  name: string | null;
  created_at: number;
  last_login: number;
}
