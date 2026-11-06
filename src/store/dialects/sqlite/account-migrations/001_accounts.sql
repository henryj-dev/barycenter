-- SQLite 계열 001 — 계정 DB 의 최종 스키마
--
-- **PG 계열 001~008 을 모두 적용한 뒤의 모양을 한 파일에 둔다.** 배포된 SQLite DB 가 없던 때에
-- 시작했으므로 PG 의 역사를 되풀이하지 않는다. 002~008 은 이름만 맞추는 빈 파일이다. 009 부터는
-- PG 와 같이 한 파일이 한 단계다.
--
-- 선언 형과 PG 와 다른 표기는 설정 계열 `dialects/sqlite/migrations/001_init.sql` 머리말의 표를 따른다.
-- 이 계열에만 있는 것:
--
-- - `DEFAULT gen_random_uuid()` → 내장 `randomblob` · `random` 으로 만드는 UUID v4 식. DDL 에는
--   사용자 정의 함수를 쓰지 않는다(다른 도구로 열어도 삽입이 된다).
-- - `lower(…)` 는 SQLite 에서 ASCII 만 바꾼다. PG 는 로캘대로 바꾼다 — ASCII 밖의 대문자 주소는
--   SQLite 에서 CHECK 를 지난다. 앱이 넣기 전에 소문자로 맞춘다.
-- - `a <@ ARRAY[…]` 는 CHECK 안에 하위 질의를 못 쓰므로 JSON 텍스트에서 허용 낱말을 지우고 `[]` 만
--   남는지 본다. 받는 집합은 PG 와 같다.

CREATE TABLE users (
  id              uuid        NOT NULL DEFAULT (lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4'
                    || substr(hex(randomblob(2)), 2) || '-' || substr('89ab', 1 + (random() & 3), 1)
                    || substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6)))),
  username        text        NOT NULL,
  display_name    text,
  email           text,
  role            text        NOT NULL,
  role_authority  text        NOT NULL DEFAULT 'local',
  status          text        NOT NULL DEFAULT 'active',
  password_hash   text,
  failed_logins   int         NOT NULL DEFAULT 0,
  locked_until    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_by      text        NOT NULL,
  updated_at      timestamptz NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  deleted_at      timestamptz,
  last_failed_at  timestamptz,
  last_login_at   timestamptz,
  idp_grant       text_array  NOT NULL DEFAULT '[]' CHECK (json_type(idp_grant) = 'array'),
  idp_deny        text_array  NOT NULL DEFAULT '[]' CHECK (json_type(idp_deny) = 'array'),
  CONSTRAINT users_pkey PRIMARY KEY (id),
  CONSTRAINT users_username_key UNIQUE (username),
  CONSTRAINT users_email_key UNIQUE (email),
  CONSTRAINT users_deleted_tombstone CHECK (
    status <> 'deleted' OR (password_hash IS NULL AND email IS NULL AND deleted_at IS NOT NULL)),
  CONSTRAINT users_email_lower CHECK (email IS NULL OR email = lower(email)),
  -- idp_grant · idp_deny <@ {read, write, apply, admin}
  CONSTRAINT users_idp_scopes CHECK (
    replace(replace(replace(replace(replace(json(idp_grant),
      '"read"', ''), '"write"', ''), '"apply"', ''), '"admin"', ''), ',', '') = '[]'
    AND replace(replace(replace(replace(replace(json(idp_deny),
      '"read"', ''), '"write"', ''), '"apply"', ''), '"admin"', ''), ',', '') = '[]'),
  CONSTRAINT users_role CHECK (role IN ('auditor', 'operator', 'admin')),
  CONSTRAINT users_role_authority CHECK (role_authority IN ('local', 'idp')),
  CONSTRAINT users_status CHECK (status IN ('active', 'suspended', 'deleted')),
  -- '^[a-z0-9][a-z0-9._-]{1,62}$'
  CONSTRAINT users_username_shape CHECK (
    length(username) BETWEEN 2 AND 63 AND username GLOB '[a-z0-9]*' AND username NOT GLOB '*[^a-z0-9._-]*')
);

CREATE TABLE sessions (
  id_hash       text        NOT NULL,
  user_id       uuid        NOT NULL CONSTRAINT sessions_user_id_fkey REFERENCES users (id),
  created_at    timestamptz NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_seen_at  timestamptz NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at    timestamptz NOT NULL,
  revoked_at    timestamptz,
  mfa_pending   boolean     NOT NULL DEFAULT 0,
  auth_methods  text_array  NOT NULL CHECK (json_type(auth_methods) = 'array'),
  mfa_at        timestamptz,
  ip            text,
  user_agent    text,
  CONSTRAINT sessions_pkey PRIMARY KEY (id_hash)
);
CREATE INDEX sessions_user_idx ON sessions (user_id) WHERE revoked_at IS NULL;

CREATE TABLE invitations (
  id          uuid        NOT NULL DEFAULT (lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4'
                || substr(hex(randomblob(2)), 2) || '-' || substr('89ab', 1 + (random() & 3), 1)
                || substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6)))),
  token_hash  text        NOT NULL,
  kind        text        NOT NULL,
  for_user    uuid        CONSTRAINT invitations_for_user_fkey REFERENCES users (id),
  email       text,
  role        text        NOT NULL,
  invited_by  text        NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  used_by     uuid        CONSTRAINT invitations_used_by_fkey REFERENCES users (id),
  revoked_at  timestamptz,
  CONSTRAINT invitations_pkey PRIMARY KEY (id),
  CONSTRAINT invitations_token_hash_key UNIQUE (token_hash),
  CONSTRAINT invitations_email_lower CHECK (email IS NULL OR email = lower(email)),
  CONSTRAINT invitations_kind CHECK (
    (kind IN ('invite', 'bootstrap') AND for_user IS NULL) OR (kind = 'recovery' AND for_user IS NOT NULL)),
  CONSTRAINT invitations_role CHECK (role IN ('auditor', 'operator', 'admin'))
);

CREATE TABLE mfa_totp (
  user_id        uuid        NOT NULL CONSTRAINT mfa_totp_user_id_fkey REFERENCES users (id),
  secret_sealed  text        NOT NULL,
  last_step      bigint      NOT NULL DEFAULT 0,
  created_at     timestamptz NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  confirmed_at   timestamptz,
  CONSTRAINT mfa_totp_pkey PRIMARY KEY (user_id)
);

CREATE TABLE mfa_recovery_codes (
  user_id     uuid        NOT NULL CONSTRAINT mfa_recovery_codes_user_id_fkey REFERENCES users (id),
  code_hash   text        NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  used_at     timestamptz,
  CONSTRAINT mfa_recovery_codes_pkey PRIMARY KEY (user_id, code_hash)
);

CREATE TABLE account_audit (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  at            timestamptz NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  actor         text        NOT NULL,
  action        text        NOT NULL,
  subject_user  uuid,
  ip            text,
  detail        json_text   CHECK (detail IS NULL OR json_valid(detail))
);
CREATE INDEX account_audit_at_idx ON account_audit (at DESC);

-- ── 메일 ─────────────────────────────────────────────────────────────────

CREATE TABLE password_resets (
  token_hash  text        NOT NULL,
  user_id     uuid        NOT NULL CONSTRAINT password_resets_user_id_fkey REFERENCES users (id),
  created_at  timestamptz NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  ip          text,
  CONSTRAINT password_resets_pkey PRIMARY KEY (token_hash)
);
CREATE INDEX password_resets_user_idx ON password_resets (user_id, created_at DESC);

CREATE TABLE email_changes (
  token_hash  text        NOT NULL,
  user_id     uuid        NOT NULL CONSTRAINT email_changes_user_id_fkey REFERENCES users (id),
  new_email   text        NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  CONSTRAINT email_changes_pkey PRIMARY KEY (token_hash),
  CONSTRAINT email_changes_lower CHECK (new_email = lower(new_email))
);

-- ── SSO ──────────────────────────────────────────────────────────────────

CREATE TABLE sso_providers (
  issuer              text        NOT NULL,
  jit_enabled         boolean     NOT NULL DEFAULT 0,
  jit_role            text        NOT NULL DEFAULT 'auditor',
  updated_at          timestamptz NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by          text        NOT NULL,
  role_claim          text,
  role_map            json_text   NOT NULL DEFAULT '{}' CHECK (json_valid(role_map)),
  idp_authority       boolean     NOT NULL DEFAULT 0,
  entitlement_claim   text,
  entitlement_prefix  text        NOT NULL DEFAULT '',
  entitlement_map     json_text   NOT NULL DEFAULT '{}' CHECK (json_valid(entitlement_map)),
  CONSTRAINT sso_providers_pkey PRIMARY KEY (issuer),
  -- '^[A-Za-z0-9_.:/-]{1,200}$'
  CONSTRAINT sso_providers_entitlement_claim_shape CHECK (
    entitlement_claim IS NULL
    OR (length(entitlement_claim) BETWEEN 1 AND 200 AND entitlement_claim NOT GLOB '*[^A-Za-z0-9_.:/-]*')),
  CONSTRAINT sso_providers_entitlement_map_object CHECK (json_type(entitlement_map) = 'object'),
  -- '^[A-Za-z0-9_.:/-]{1,100}$'
  CONSTRAINT sso_providers_entitlement_prefix CHECK (
    entitlement_claim IS NULL
    OR (length(entitlement_prefix) BETWEEN 1 AND 100 AND entitlement_prefix NOT GLOB '*[^A-Za-z0-9_.:/-]*')),
  CONSTRAINT sso_providers_jit_role CHECK (jit_role = 'auditor'),
  CONSTRAINT sso_providers_role_claim_shape CHECK (
    role_claim IS NULL OR (length(role_claim) BETWEEN 1 AND 200 AND role_claim NOT GLOB '*[^A-Za-z0-9_.:/-]*')),
  CONSTRAINT sso_providers_role_map_object CHECK (json_type(role_map) = 'object')
);

-- role_change_txn 은 발급 밀리초다 — 64비트 정수 안이라 numeric 친화도가 정수로 담는다.
CREATE TABLE user_identities (
  issuer           text        NOT NULL,
  subject          text        NOT NULL,
  user_id          uuid        NOT NULL CONSTRAINT user_identities_user_id_fkey REFERENCES users (id),
  linked_at        timestamptz NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  linked_by        text        NOT NULL,
  last_login_at    timestamptz,
  role_change_txn  numeric,
  CONSTRAINT user_identities_pkey PRIMARY KEY (issuer, subject)
);
CREATE INDEX user_identities_user_idx ON user_identities (user_id);

CREATE TABLE login_flows (
  id_hash        text        NOT NULL,
  state          text        NOT NULL,
  nonce          text        NOT NULL,
  code_verifier  text        NOT NULL,
  intent         text        NOT NULL,
  user_id        uuid        CONSTRAINT login_flows_user_id_fkey REFERENCES users (id),
  expires_at     timestamptz NOT NULL,
  CONSTRAINT login_flows_pkey PRIMARY KEY (id_hash),
  CONSTRAINT login_flows_intent CHECK (
    (intent = 'login' AND user_id IS NULL) OR (intent = 'link' AND user_id IS NOT NULL))
);

CREATE TABLE idp_set_jti (
  issuer      text        NOT NULL,
  jti         text        NOT NULL,
  expires_at  timestamptz NOT NULL,
  CONSTRAINT idp_set_jti_pkey PRIMARY KEY (issuer, jti),
  CONSTRAINT idp_set_jti_shape CHECK (length(jti) >= 1 AND length(jti) <= 200)
);

-- ── 로그인 실패 조절 ─────────────────────────────────────────────────────

CREATE TABLE auth_throttle (
  key              text        NOT NULL,
  failures         int         NOT NULL,
  blocked_until    timestamptz,
  last_failure_at  timestamptz NOT NULL,
  CONSTRAINT auth_throttle_pkey PRIMARY KEY (key)
);
CREATE INDEX auth_throttle_last_idx ON auth_throttle (last_failure_at);

-- ── API 토큰 ─────────────────────────────────────────────────────────────

CREATE TABLE api_tokens (
  id            uuid        NOT NULL DEFAULT (lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4'
                  || substr(hex(randomblob(2)), 2) || '-' || substr('89ab', 1 + (random() & 3), 1)
                  || substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6)))),
  user_id       uuid        NOT NULL CONSTRAINT api_tokens_user_id_fkey REFERENCES users (id),
  name          text        NOT NULL,
  role          text        NOT NULL,
  lookup        text        NOT NULL,
  token_hash    text        NOT NULL,
  created_at    timestamptz NOT NULL,
  created_by    text        NOT NULL,
  expires_at    timestamptz NOT NULL,
  last_used_at  timestamptz,
  revoked_at    timestamptz,
  revoked_by    text,
  CONSTRAINT api_tokens_pkey PRIMARY KEY (id),
  CONSTRAINT api_tokens_lookup_key UNIQUE (lookup),
  -- interval '365 days' → julianday 의 날 수.
  CONSTRAINT api_tokens_expiry CHECK (
    julianday(expires_at) > julianday(created_at) AND julianday(expires_at) <= julianday(created_at) + 365),
  CONSTRAINT api_tokens_hash_shape CHECK (length(token_hash) = 64 AND token_hash NOT GLOB '*[^0-9a-f]*'),
  CONSTRAINT api_tokens_lookup_shape CHECK (length(lookup) = 16 AND lookup NOT GLOB '*[^0-9a-f]*'),
  -- '^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$'
  CONSTRAINT api_tokens_name_shape CHECK (
    length(name) BETWEEN 1 AND 63 AND name GLOB '[A-Za-z0-9]*' AND name NOT GLOB '*[^A-Za-z0-9._-]*'),
  CONSTRAINT api_tokens_role CHECK (role IN ('auditor', 'operator', 'admin'))
);
CREATE INDEX api_tokens_user_idx ON api_tokens (user_id) WHERE revoked_at IS NULL;
