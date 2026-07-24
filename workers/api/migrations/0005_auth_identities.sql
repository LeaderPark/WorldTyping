-- spec: docs/00 §11-D68(계정 로그인 하이브리드 — 계정 매핑 테이블), docs/04 §5.5(계정 계층) + WT-AUTH-01
-- 마이그레이션은 append-only — 0001~0004는 절대 수정하지 않는다(CLAUDE.md gotcha 4). 이 파일은 신규 0005.
--
-- Google 계정 ↔ users 매핑. user_id는 계정에서도 derivePlayerId(SESSION_HMAC_SECRET, "google:"+sub)로
-- 결정적 파생하므로(D38 규약 승계) 별도 랜덤 키/매핑 없이 users PK를 그대로 재사용한다. 이 테이블은
-- "이 (provider, subject)가 어느 user_id인가 + 이메일/이름/로그인 시각" 기록만 담당한다.
--
--   provider   : 현재 'google'만(CHECK). v2에서 다른 IdP 추가 시 CHECK를 완화하는 append-only 마이그레이션.
--   subject    : Google ID-token의 sub 클레임(계정 고유·불변 식별자). 이메일이 아니라 sub가 신원 키다.
--   user_id    : users(user_id) FK. UNIQUE 인덱스로 1 계정 ↔ 1 user 강제(derivePlayerId가 sub당 결정적이라
--                자연히 유일하지만, 인덱스로 불변식을 스키마에 못박는다).
--   email/name : email은 email_verified인 경우에만 저장(§5.5 — 미검증 이메일은 신뢰하지 않는다). NULL 허용.
--   created_at : 최초 로그인(계정 생성) 시각(epoch ms). last_login: 매 로그인 갱신.
--
-- WITHOUT ROWID: (provider, subject) 복합 PK 조회가 유일 접근 경로라 rowid 오버헤드를 없앤다
-- (0001 user_unlocks 선례와 동일 패턴).
CREATE TABLE auth_identities (
  provider   TEXT NOT NULL CHECK (provider IN ('google')),
  subject    TEXT NOT NULL,
  user_id    TEXT NOT NULL REFERENCES users(user_id),
  email      TEXT,
  name       TEXT,
  created_at INTEGER NOT NULL,
  last_login INTEGER NOT NULL,
  PRIMARY KEY (provider, subject)
) WITHOUT ROWID;

-- 1 계정 ↔ 1 user 불변식 + user_id로 auth_identities 역조회(DELETE /users/me 삭제 등)를 인덱스로 지원.
CREATE UNIQUE INDEX idx_auth_identities_user ON auth_identities (user_id);
