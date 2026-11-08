-- MySQL · MariaDB 계열 001 — 계정 DB 의 최종 스키마
--
-- **PG 계열 001~008 을 모두 적용한 뒤의 모양을 한 파일에 둔다.** 002~008 은 이름만 맞추는 주석 파일이다.
-- 009 부터는 PG 와 같이 한 파일이 한 단계다.
--
-- 형 · 표기 · 「다시 돌려도 안전하다」 는 설정 계열 `dialects/mysql/migrations/001_init.sql` 머리말을 따른다. 이 계열에만 있는 것:
--
-- - `DEFAULT gen_random_uuid()` → `DEFAULT (UUID())`. MySQL 의 `UUID()` 는 v1(시각 + 노드)이다 — 이 id 들은 비밀이 아니다
--   (토큰 · 세션은 해시로만 둔다). 저장소의 `gen_random_uuid()` 는 드라이버가 v4 리터럴로 바꾼다.
-- - `a <@ ARRAY[…]` 는 CHECK 안에 하위 질의를 못 쓰므로 JSON 텍스트에서 허용 낱말 · 쉼표 · 공백을 지우고 `[]` 만
--   남는지 본다(SQLite 계열과 같은 방식). 받는 집합은 PG 와 같다.
-- - 부분 색인(`… WHERE revoked_at IS NULL`)은 성능용이라 그냥 색인이다.
-- - `interval '365 days'` → `INTERVAL 365 DAY`.

CREATE TABLE IF NOT EXISTS users (
  id              char(36)     NOT NULL DEFAULT (UUID()),
  username        varchar(255) NOT NULL,
  display_name    longtext,
  email           varchar(255),
  role            longtext     NOT NULL,
  role_authority  varchar(255) NOT NULL DEFAULT 'local',
  status          varchar(255) NOT NULL DEFAULT 'active',
  password_hash   longtext,
  failed_logins   int          NOT NULL DEFAULT 0,
  locked_until    datetime(6),
  created_at      datetime(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  created_by      longtext     NOT NULL,
  updated_at      datetime(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  deleted_at      datetime(6),
  last_failed_at  datetime(6),
  last_login_at   datetime(6),
  idp_grant       json         NOT NULL DEFAULT ('[]') COMMENT 'bary:array',
  idp_deny        json         NOT NULL DEFAULT ('[]') COMMENT 'bary:array',
  CONSTRAINT users_pkey PRIMARY KEY (id),
  CONSTRAINT users_username_key UNIQUE (username),
  CONSTRAINT users_email_key UNIQUE (email),
  CONSTRAINT users_idp_arrays CHECK (JSON_TYPE(idp_grant) = 'ARRAY' AND JSON_TYPE(idp_deny) = 'ARRAY'),
  CONSTRAINT users_deleted_tombstone CHECK (
    status <> 'deleted' OR (password_hash IS NULL AND email IS NULL AND deleted_at IS NOT NULL)),
  CONSTRAINT users_email_lower CHECK (email IS NULL OR email = lower(email)),
  -- idp_grant · idp_deny <@ {read, write, apply, admin}
  CONSTRAINT users_idp_scopes CHECK (
    replace(replace(replace(replace(replace(replace(CAST(idp_grant AS CHAR),
      '"read"', ''), '"write"', ''), '"apply"', ''), '"admin"', ''), ',', ''), ' ', '') = '[]'
    AND replace(replace(replace(replace(replace(replace(CAST(idp_deny AS CHAR),
      '"read"', ''), '"write"', ''), '"apply"', ''), '"admin"', ''), ',', ''), ' ', '') = '[]'),
  CONSTRAINT users_role CHECK (role IN ('auditor', 'operator', 'admin')),
  CONSTRAINT users_role_authority CHECK (role_authority IN ('local', 'idp')),
  CONSTRAINT users_status CHECK (status IN ('active', 'suspended', 'deleted')),
  CONSTRAINT users_username_shape CHECK ((username REGEXP '^[a-z0-9][a-z0-9._-]{1,62}$' AND RIGHT(username, 1) REGEXP '[a-z0-9._-]'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS sessions (
  id_hash       varchar(255) NOT NULL,
  user_id       char(36)     NOT NULL,
  created_at    datetime(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  last_seen_at  datetime(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  expires_at    datetime(6)  NOT NULL,
  revoked_at    datetime(6),
  mfa_pending   boolean      NOT NULL DEFAULT FALSE,
  auth_methods  json         NOT NULL COMMENT 'bary:array',
  mfa_at        datetime(6),
  ip            longtext,
  user_agent    longtext,
  CONSTRAINT sessions_pkey PRIMARY KEY (id_hash),
  KEY sessions_user_idx (user_id),
  CONSTRAINT sessions_user_id_fkey FOREIGN KEY (user_id) REFERENCES users (id),
  CONSTRAINT sessions_auth_methods_array CHECK (JSON_TYPE(auth_methods) = 'ARRAY')
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS invitations (
  id          char(36)     NOT NULL DEFAULT (UUID()),
  token_hash  varchar(255) NOT NULL,
  kind        varchar(255) NOT NULL,
  for_user    char(36),
  email       longtext,
  role        longtext     NOT NULL,
  invited_by  longtext     NOT NULL,
  created_at  datetime(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  expires_at  datetime(6)  NOT NULL,
  used_at     datetime(6),
  used_by     char(36),
  revoked_at  datetime(6),
  CONSTRAINT invitations_pkey PRIMARY KEY (id),
  CONSTRAINT invitations_token_hash_key UNIQUE (token_hash),
  CONSTRAINT invitations_for_user_fkey FOREIGN KEY (for_user) REFERENCES users (id),
  CONSTRAINT invitations_used_by_fkey FOREIGN KEY (used_by) REFERENCES users (id),
  CONSTRAINT invitations_email_lower CHECK (email IS NULL OR email = lower(email)),
  CONSTRAINT invitations_kind CHECK (
    (kind IN ('invite', 'bootstrap') AND for_user IS NULL) OR (kind = 'recovery' AND for_user IS NOT NULL)),
  CONSTRAINT invitations_role CHECK (role IN ('auditor', 'operator', 'admin'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS mfa_totp (
  user_id        char(36)    NOT NULL,
  secret_sealed  longtext    NOT NULL,
  last_step      bigint      NOT NULL DEFAULT 0,
  created_at     datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  confirmed_at   datetime(6),
  CONSTRAINT mfa_totp_pkey PRIMARY KEY (user_id),
  CONSTRAINT mfa_totp_user_id_fkey FOREIGN KEY (user_id) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS mfa_recovery_codes (
  user_id     char(36)     NOT NULL,
  code_hash   varchar(255) NOT NULL,
  created_at  datetime(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  used_at     datetime(6),
  CONSTRAINT mfa_recovery_codes_pkey PRIMARY KEY (user_id, code_hash),
  CONSTRAINT mfa_recovery_codes_user_id_fkey FOREIGN KEY (user_id) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS account_audit (
  id            bigint      NOT NULL AUTO_INCREMENT,
  at            datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  actor         longtext    NOT NULL,
  action        longtext    NOT NULL,
  subject_user  char(36),
  ip            longtext,
  detail        json        COMMENT 'bary:json',
  CONSTRAINT account_audit_pkey PRIMARY KEY (id),
  KEY account_audit_at_idx (at DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS password_resets (
  token_hash  varchar(255) NOT NULL,
  user_id     char(36)     NOT NULL,
  created_at  datetime(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  expires_at  datetime(6)  NOT NULL,
  used_at     datetime(6),
  ip          longtext,
  CONSTRAINT password_resets_pkey PRIMARY KEY (token_hash),
  KEY password_resets_user_idx (user_id, created_at DESC),
  CONSTRAINT password_resets_user_id_fkey FOREIGN KEY (user_id) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS email_changes (
  token_hash  varchar(255) NOT NULL,
  user_id     char(36)     NOT NULL,
  new_email   longtext     NOT NULL,
  created_at  datetime(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  expires_at  datetime(6)  NOT NULL,
  used_at     datetime(6),
  CONSTRAINT email_changes_pkey PRIMARY KEY (token_hash),
  CONSTRAINT email_changes_user_id_fkey FOREIGN KEY (user_id) REFERENCES users (id),
  CONSTRAINT email_changes_lower CHECK (new_email = lower(new_email))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS sso_providers (
  issuer              varchar(768) NOT NULL,
  jit_enabled         boolean      NOT NULL DEFAULT FALSE,
  jit_role            varchar(255) NOT NULL DEFAULT 'auditor',
  updated_at          datetime(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_by          longtext     NOT NULL,
  role_claim          longtext,
  role_map            json         NOT NULL DEFAULT ('{}') COMMENT 'bary:json',
  idp_authority       boolean      NOT NULL DEFAULT FALSE,
  entitlement_claim   longtext,
  entitlement_prefix  longtext     NOT NULL DEFAULT (''),
  entitlement_map     json         NOT NULL DEFAULT ('{}') COMMENT 'bary:json',
  CONSTRAINT sso_providers_pkey PRIMARY KEY (issuer),
  CONSTRAINT sso_providers_entitlement_claim_shape CHECK (
    entitlement_claim IS NULL OR (entitlement_claim REGEXP '^[A-Za-z0-9_.:/-]{1,200}$' AND RIGHT(entitlement_claim, 1) REGEXP '[A-Za-z0-9_.:/-]')),
  CONSTRAINT sso_providers_entitlement_map_object CHECK (JSON_TYPE(entitlement_map) = 'OBJECT'),
  CONSTRAINT sso_providers_entitlement_prefix CHECK (
    entitlement_claim IS NULL OR (entitlement_prefix REGEXP '^[A-Za-z0-9_.:/-]{1,100}$' AND RIGHT(entitlement_prefix, 1) REGEXP '[A-Za-z0-9_.:/-]')),
  CONSTRAINT sso_providers_jit_role CHECK (jit_role = 'auditor'),
  CONSTRAINT sso_providers_role_claim_shape CHECK (
    role_claim IS NULL OR (role_claim REGEXP '^[A-Za-z0-9_.:/-]{1,200}$' AND RIGHT(role_claim, 1) REGEXP '[A-Za-z0-9_.:/-]')),
  CONSTRAINT sso_providers_role_map_object CHECK (JSON_TYPE(role_map) = 'OBJECT')
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS user_identities (
  issuer           varchar(512) NOT NULL,
  subject          varchar(255) NOT NULL,
  user_id          char(36)     NOT NULL,
  linked_at        datetime(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  linked_by        longtext     NOT NULL,
  last_login_at    datetime(6),
  role_change_txn  decimal(30, 0),
  CONSTRAINT user_identities_pkey PRIMARY KEY (issuer, subject),
  KEY user_identities_user_idx (user_id),
  CONSTRAINT user_identities_user_id_fkey FOREIGN KEY (user_id) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS login_flows (
  id_hash        varchar(255) NOT NULL,
  state          longtext     NOT NULL,
  nonce          longtext     NOT NULL,
  code_verifier  longtext     NOT NULL,
  intent         varchar(255) NOT NULL,
  user_id        char(36),
  expires_at     datetime(6)  NOT NULL,
  CONSTRAINT login_flows_pkey PRIMARY KEY (id_hash),
  CONSTRAINT login_flows_user_id_fkey FOREIGN KEY (user_id) REFERENCES users (id),
  CONSTRAINT login_flows_intent CHECK (
    (intent = 'login' AND user_id IS NULL) OR (intent = 'link' AND user_id IS NOT NULL))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS idp_set_jti (
  issuer      varchar(512) NOT NULL,
  jti         varchar(255) NOT NULL,
  expires_at  datetime(6)  NOT NULL,
  CONSTRAINT idp_set_jti_pkey PRIMARY KEY (issuer, jti),
  CONSTRAINT idp_set_jti_shape CHECK (char_length(jti) >= 1 AND char_length(jti) <= 200)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS auth_throttle (
  `key`            varchar(512) NOT NULL,
  failures         int          NOT NULL,
  blocked_until    datetime(6),
  last_failure_at  datetime(6)  NOT NULL,
  CONSTRAINT auth_throttle_pkey PRIMARY KEY (`key`),
  KEY auth_throttle_last_idx (last_failure_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS api_tokens (
  id            char(36)     NOT NULL DEFAULT (UUID()),
  user_id       char(36)     NOT NULL,
  name          longtext     NOT NULL,
  role          longtext     NOT NULL,
  lookup        varchar(255) NOT NULL,
  token_hash    longtext     NOT NULL,
  created_at    datetime(6)  NOT NULL,
  created_by    longtext     NOT NULL,
  expires_at    datetime(6)  NOT NULL,
  last_used_at  datetime(6),
  revoked_at    datetime(6),
  revoked_by    longtext,
  CONSTRAINT api_tokens_pkey PRIMARY KEY (id),
  CONSTRAINT api_tokens_lookup_key UNIQUE (lookup),
  KEY api_tokens_user_idx (user_id),
  CONSTRAINT api_tokens_user_id_fkey FOREIGN KEY (user_id) REFERENCES users (id),
  CONSTRAINT api_tokens_expiry CHECK (expires_at > created_at AND expires_at <= created_at + INTERVAL 365 DAY),
  CONSTRAINT api_tokens_hash_shape CHECK ((token_hash REGEXP '^[0-9a-f]{64}$' AND RIGHT(token_hash, 1) REGEXP '[0-9a-f]')),
  CONSTRAINT api_tokens_lookup_shape CHECK ((lookup REGEXP '^[0-9a-f]{16}$' AND RIGHT(lookup, 1) REGEXP '[0-9a-f]')),
  CONSTRAINT api_tokens_name_shape CHECK ((name REGEXP '^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$' AND RIGHT(name, 1) REGEXP '[A-Za-z0-9._-]')),
  CONSTRAINT api_tokens_role CHECK (role IN ('auditor', 'operator', 'admin'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
