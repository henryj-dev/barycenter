-- 001_accounts.sql
-- 001_accounts.sql
-- 사람 계정 (공통 회원정책 1차 · 2026-10-18, 계획 A 단계)
--
-- **설정 정본과 다른 DB 다.** 계정은 모든 지역·전역이 함께 쓰는 공용 계정 PG 에 산다 — 지역 PG 에
-- 두면 지역마다 같은 사람이 따로 생기고, 정지·철회가 지역마다 갈린다. 그래서 마이그레이션 계열도
-- 따로다(`account_schema_migrations`). 백엔드 멤버십(풀·백엔드)·설정 모델·export·backup 과 섞지 않는다.
--
-- SSO(identity·공급자·로그인 흐름)·메일 재설정은 B 단계의 다음 마이그레이션이 더한다.

CREATE TABLE users (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- **바꾸지 않는다.** 감사 기록이 `user:<username>` 으로 사람을 가리킨다 — 이름이 바뀌면 옛 기록이
  -- 다른 사람을 가리키거나 아무도 안 가리킨다. 표시 이름은 따로 둔다.
  username       text NOT NULL UNIQUE,
  display_name   text,
  email          text UNIQUE,
  role           text NOT NULL,
  -- 권한 정본. A 단계에서는 local 만 쓴다(IdP 정본은 B 단계·미해결).
  role_authority text NOT NULL DEFAULT 'local',
  status         text NOT NULL DEFAULT 'active',
  password_hash  text,
  failed_logins  int NOT NULL DEFAULT 0,
  locked_until   timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     text NOT NULL,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  deleted_at     timestamptz
);

ALTER TABLE users ADD CONSTRAINT users_username_shape CHECK (username ~ '^[a-z0-9][a-z0-9._-]{1,62}$');
ALTER TABLE users ADD CONSTRAINT users_email_lower CHECK (email IS NULL OR email = lower(email));
ALTER TABLE users ADD CONSTRAINT users_role CHECK (role IN ('auditor', 'operator', 'admin'));
ALTER TABLE users ADD CONSTRAINT users_role_authority CHECK (role_authority IN ('local', 'idp'));
ALTER TABLE users ADD CONSTRAINT users_status CHECK (status IN ('active', 'suspended', 'deleted'));
-- 삭제된 계정은 묘비다 — 로그인 수단을 남기지 않는다.
ALTER TABLE users ADD CONSTRAINT users_deleted_tombstone CHECK (
  status <> 'deleted' OR (password_hash IS NULL AND email IS NULL AND deleted_at IS NOT NULL));

-- **서버 세션.** 쿠키에는 불투명 id 만 간다. 모든 보호된 요청이 이 행을 확인한다 — 로그아웃·정지·
-- 역할 하향이 **다음 요청부터** 반영되는 근거다(공통 정책). 원문 id 는 저장하지 않는다(해시).
CREATE TABLE sessions (
  id_hash        text PRIMARY KEY,
  user_id        uuid NOT NULL REFERENCES users(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  last_seen_at   timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz NOT NULL,
  revoked_at     timestamptz,
  -- 비밀번호는 맞았고 MFA 를 기다린다. 이 상태로는 MFA 단계 말고 아무 데도 못 간다.
  mfa_pending    boolean NOT NULL DEFAULT false,
  auth_methods   text[] NOT NULL,
  mfa_at         timestamptz,
  ip             text,
  user_agent     text
);
CREATE INDEX sessions_user_idx ON sessions(user_id) WHERE revoked_at IS NULL;

-- 일회용 링크 — 공개 가입은 없다(공통 정책). 토큰은 해시로만 둔다.
--   invite     관리자가 역할을 정해 초대한다
--   bootstrap  첫 관리자. 활성 admin 이 하나도 없을 때만 만든다(호스트 CLI)
--   recovery   기존 계정(`for_user`)의 비밀번호·MFA 를 다시 정한다 — 관리자 MFA 초기화·호스트 CLI 복구.
--              SMTP 없이도 마지막 관리자를 살리는 길이다
CREATE TABLE invitations (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash     text NOT NULL UNIQUE,
  kind           text NOT NULL,
  for_user       uuid REFERENCES users(id),
  email          text,
  role           text NOT NULL,
  invited_by     text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz NOT NULL,
  used_at        timestamptz,
  used_by        uuid REFERENCES users(id),
  revoked_at     timestamptz
);
ALTER TABLE invitations ADD CONSTRAINT invitations_role CHECK (role IN ('auditor', 'operator', 'admin'));
ALTER TABLE invitations ADD CONSTRAINT invitations_kind CHECK (
  (kind IN ('invite', 'bootstrap') AND for_user IS NULL)
  OR (kind = 'recovery' AND for_user IS NOT NULL));
ALTER TABLE invitations ADD CONSTRAINT invitations_email_lower CHECK (email IS NULL OR email = lower(email));

-- TOTP (RFC 6238). 비밀은 봉투 암호화한 값만 둔다 — 덤프만으로는 코드를 못 만든다.
CREATE TABLE mfa_totp (
  user_id        uuid PRIMARY KEY REFERENCES users(id),
  secret_sealed  text NOT NULL,
  -- 마지막으로 받아 준 시간창. 같은 창의 코드를 두 번 못 쓴다(재사용 방지).
  last_step      bigint NOT NULL DEFAULT 0,
  created_at     timestamptz NOT NULL DEFAULT now(),
  confirmed_at   timestamptz
);

CREATE TABLE mfa_recovery_codes (
  user_id        uuid NOT NULL REFERENCES users(id),
  code_hash      text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  used_at        timestamptz,
  PRIMARY KEY (user_id, code_hash)
);

-- 계정 감사. 설정 감사(`audit`, 지역 PG)와 다른 곳에 있다 — 계정은 지역에 속하지 않는다.
-- 비밀(비밀번호·코드·토큰)은 어떤 형태로도 싣지 않는다.
CREATE TABLE account_audit (
  id             bigserial PRIMARY KEY,
  at             timestamptz NOT NULL DEFAULT now(),
  actor          text NOT NULL,
  action         text NOT NULL,
  subject_user   uuid,
  ip             text,
  detail         jsonb
);
CREATE INDEX account_audit_at_idx ON account_audit(at DESC);
