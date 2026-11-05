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

-- 002_mail.sql
-- 002_mail.sql
-- 메일로 오가는 일회용 링크 (공통 회원정책 1차 · 계획 B1)
--
-- 비밀번호 재설정과 이메일 변경. 토큰은 해시로만 둔다. 재설정은 **MFA 를 풀지 않는다** — 메일함을
-- 가진 사람이 곧 계정 주인이 되지 않게(인증 앱은 그대로 요구된다).

CREATE TABLE password_resets (
  token_hash     text PRIMARY KEY,
  user_id        uuid NOT NULL REFERENCES users(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz NOT NULL,
  used_at        timestamptz,
  ip             text
);
CREATE INDEX password_resets_user_idx ON password_resets(user_id, created_at DESC);

-- 새 주소로 보낸 확인 링크. 확인하기 전까지 주소는 바뀌지 않는다.
CREATE TABLE email_changes (
  token_hash     text PRIMARY KEY,
  user_id        uuid NOT NULL REFERENCES users(id),
  new_email      text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz NOT NULL,
  used_at        timestamptz
);
ALTER TABLE email_changes ADD CONSTRAINT email_changes_lower CHECK (new_email = lower(new_email));

-- 003_sso.sql
-- 003_sso.sql
-- SSO 연결 (공통 회원정책 1차 · 계획 B2) — **로컬 권한 정본만**
--
-- IdP 에게는 「누구인가」(issuer, subject)만 묻는다. 무엇을 할 수 있는지는 계정이 정한다. IdP 권한 정본·
-- IdP MFA 는 공급자 계약이 미해결이라 여기 없다(lodestar 답 2026-10-18).
--
-- **이메일·username 이 같다고 이어 붙이지 않는다.** 연결은 로그인한 사람이 비밀번호를 다시 넣고 직접 하거나,
-- 관리자가 그 공급자에 JIT 를 켰을 때 새 계정(auditor)으로만 생긴다.

CREATE TABLE sso_providers (
  issuer         text PRIMARY KEY,
  -- JIT 는 **기본 꺼짐**(공통 정책). 켜도 auditor 로만 만든다 — 역할 올리기는 관리자가 한다.
  jit_enabled    boolean NOT NULL DEFAULT false,
  jit_role       text NOT NULL DEFAULT 'auditor',
  updated_at     timestamptz NOT NULL DEFAULT now(),
  updated_by     text NOT NULL
);
ALTER TABLE sso_providers ADD CONSTRAINT sso_providers_jit_role CHECK (jit_role = 'auditor');

CREATE TABLE user_identities (
  issuer         text NOT NULL,
  subject        text NOT NULL,
  user_id        uuid NOT NULL REFERENCES users(id),
  linked_at      timestamptz NOT NULL DEFAULT now(),
  linked_by      text NOT NULL,
  last_login_at  timestamptz,
  PRIMARY KEY (issuer, subject)
);
CREATE INDEX user_identities_user_idx ON user_identities(user_id);

-- OIDC 로그인 중 상태. **계정 PG 에 둔다** — 여러 인스턴스를 DNS 로 묶으면 시작과 콜백이 다른 인스턴스로
-- 갈 수 있다. 쿠키에는 흐름 id 만 간다(해시로 저장). 한 번 쓰면 지운다.
CREATE TABLE login_flows (
  id_hash        text PRIMARY KEY,
  state          text NOT NULL,
  nonce          text NOT NULL,
  code_verifier  text NOT NULL,
  intent         text NOT NULL,
  user_id        uuid REFERENCES users(id),
  expires_at     timestamptz NOT NULL
);
ALTER TABLE login_flows ADD CONSTRAINT login_flows_intent CHECK (
  (intent = 'login' AND user_id IS NULL) OR (intent = 'link' AND user_id IS NOT NULL));

-- 004_idp_roles.sql
-- 004_idp_roles.sql
-- IdP 권한 정본 (계획 B3, 2026-10-18 barycenter 사용자 결정 — 「지연을 감수하고 지원」)
--
-- 계정마다 관리자가 권한 정본을 고른다(users.role_authority: local | idp, 001 에 이미 있다). idp 인 계정은
-- **SSO 로그인 때마다** 공급자의 역할 클레임을 이 매핑으로 바꿔 역할을 맞춘다. 그 사이 IdP 쪽 변경은 다음 SSO
-- 로그인까지 반영되지 않는다 — 사용자가 이 지연을 받아들였다. 로컬 정지·삭제는 언제나 우선이다.
--
-- 역할 클레임은 문자열이거나 원소 하나짜리 배열이다(lodestar 는 `roles=[key]`). 표시명(`roles_label`)은 권한에
-- 쓰지 않는다. 매핑에 없는 값·클레임 없음은 **그 로그인을 거부**한다 — 로컬 역할로 떨어지지 않는다.

ALTER TABLE sso_providers ADD COLUMN role_claim text;
ALTER TABLE sso_providers ADD COLUMN role_map jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE sso_providers ADD CONSTRAINT sso_providers_role_map_object CHECK (jsonb_typeof(role_map) = 'object');
ALTER TABLE sso_providers ADD CONSTRAINT sso_providers_role_claim_shape CHECK (
  role_claim IS NULL OR role_claim ~ '^[A-Za-z0-9_.:/-]{1,200}$');

-- 005_throttle.sql
-- 회원 공통 수치 1차 (2026-10-18 사용자 결정, orc 경유) — 시도 제한을 **공용 저장소**에서 센다.
-- 인스턴스 메모리에서 따로 세면 DNS 다중 A 로 묶인 인스턴스 수만큼 시도가 늘어난다.
-- 키는 '<용도>:<IP>' 다(예: login:10.0.0.1, reset:10.0.0.1). 계정 단위는 users.failed_logins·locked_until 이다.
CREATE TABLE auth_throttle (
  key              text PRIMARY KEY,
  failures         integer NOT NULL,
  blocked_until    timestamptz,
  last_failure_at  timestamptz NOT NULL
);
CREATE INDEX auth_throttle_last_idx ON auth_throttle(last_failure_at);

-- 계정 단위 계수도 마지막 실패 뒤 15분이 지나면 처음부터 센다(공통 수치 1차 추가) — 그 시각을 둔다.
ALTER TABLE users ADD COLUMN last_failed_at timestamptz;

-- 006_last_login.sql
-- 006_last_login.sql
-- 마지막 로그인 (#126 사람 화면 시안). 관리자의 사용자 목록이 「마지막 로그인」을 보인다.
--
-- **세션이 생길 때 적는다** — MFA 를 다 지나 쓸 수 있는 세션이 된 순간이다. 비밀번호만 맞고 MFA 를 기다리는
-- 세션·실패한 시도는 적지 않는다. 세션 표를 훑어 구하지 않는다: 세션은 철회·탈퇴 때 지워지고, 목록이 커진다.
-- 아직 로그인한 적 없는 계정은 NULL 이다.
ALTER TABLE users ADD COLUMN last_login_at timestamptz;

-- 007_api_tokens.sql
-- 개인 API 토큰 (#126 후속, 2026-11-04 사용자 승인 설계).
--
-- **토큰은 한 사람의 것이다.** 역할은 발급할 때 고르고, 그때 주인의 역할을 넘지 못한다. 인증할 때마다
-- 실효 역할 = min(토큰 역할, 주인의 **지금** 역할)이다 — 주인이 정지·삭제되거나 역할이 내려가면 다음 요청부터
-- 반영된다(세션과 같은 규칙). 만료는 반드시 있다(기본 90일, 최대 365일).
--
-- **평문은 저장하지 않는다.** 토큰은 `bary_<lookup>_<secret>` 모양이고, `lookup` 은 행을 찾는 비밀이 아닌 짧은
-- 값이다. `token_hash` 는 토큰 전체의 SHA-256 이다(엔트로피가 높은 값이라 느린 해시가 필요 없다). 비교는
-- 상수 시간이다(`AccountService.authenticateToken`).
--
-- 파일 토큰(`BARY_TOKENS*`)은 그대로다 — 계정 PG 가 내려갔을 때의 비상 출입구다. 이 표로 옮기지 않는다.
CREATE TABLE api_tokens (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES users(id),
  name           text NOT NULL,
  role           text NOT NULL,
  lookup         text NOT NULL UNIQUE,
  token_hash     text NOT NULL,
  created_at     timestamptz NOT NULL,
  created_by     text NOT NULL,
  expires_at     timestamptz NOT NULL,
  -- 성공한 사용의 시각. 인증마다 쓰지 않는다 — 1분에 한 번까지(인증이 쓰기 병목이 되지 않게).
  last_used_at   timestamptz,
  revoked_at     timestamptz,
  revoked_by     text
);
ALTER TABLE api_tokens ADD CONSTRAINT api_tokens_role CHECK (role IN ('auditor', 'operator', 'admin'));
ALTER TABLE api_tokens ADD CONSTRAINT api_tokens_name_shape CHECK (name ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$');
ALTER TABLE api_tokens ADD CONSTRAINT api_tokens_lookup_shape CHECK (lookup ~ '^[0-9a-f]{16}$');
ALTER TABLE api_tokens ADD CONSTRAINT api_tokens_hash_shape CHECK (token_hash ~ '^[0-9a-f]{64}$');
-- 만료 없는 토큰은 없다. 최대 365일 — 앱이 먼저 거르고, 여기는 마지막 울타리다.
ALTER TABLE api_tokens ADD CONSTRAINT api_tokens_expiry CHECK (
  expires_at > created_at AND expires_at <= created_at + interval '365 days');
CREATE INDEX api_tokens_user_idx ON api_tokens(user_id) WHERE revoked_at IS NULL;

-- 008_idp_delegation.sql
-- IdP 권한 위임 (A안 — 권한 종류 단위, 2026-11-05)
--
-- IdP 정본 계정의 권한은 두 겹이다: 역할(users.role) + 범위 하나씩의 grant / deny. 실효 범위 = 역할 범위 ∪ grant − deny,
-- **deny 가 이긴다**. 로컬 정본 계정의 grant · deny 는 비어 있다 — 앱이 실효 정본을 local 로 돌릴 때(사람의 정본을
-- local 로 · 공급자 기본 정본을 끔) 지운다. 공급자 기본 정본은 행의 role_authority 가 아니라 공급자 쪽에 있어 CHECK 로 못 건다.
--
-- 공급자마다 entitlement 클레임 · 접두 · 표(접두 뒤 이름 → grant:<범위> | deny:<범위>)를 둔다. 표가 비었거나 클레임이
-- 없으면 역할만 쓴다(004 의 동작과 같다). `idp_authority` 를 켜면 그 공급자와 이어진 사람은 **모두** IdP 정본이다.
--
-- Role Change(서명된 SET push)는 다음 로그인을 기다리지 않고 바로 반영한다. 여러 인스턴스가 같은 계정 PG 를 보므로
-- 재사용 방지(jti)와 순서(txn — 사람마다 마지막으로 적용한 것)도 여기 둔다 — 인스턴스 메모리에 두면 다른 인스턴스로
-- 다시 보낸 같은 SET 이 통한다.

ALTER TABLE users ADD COLUMN idp_grant text[] NOT NULL DEFAULT '{}';
ALTER TABLE users ADD COLUMN idp_deny text[] NOT NULL DEFAULT '{}';
ALTER TABLE users ADD CONSTRAINT users_idp_scopes CHECK (
  idp_grant <@ ARRAY['read','write','apply','admin']::text[] AND idp_deny <@ ARRAY['read','write','apply','admin']::text[]);

ALTER TABLE sso_providers ADD COLUMN idp_authority boolean NOT NULL DEFAULT false;
ALTER TABLE sso_providers ADD COLUMN entitlement_claim text;
ALTER TABLE sso_providers ADD COLUMN entitlement_prefix text NOT NULL DEFAULT '';
ALTER TABLE sso_providers ADD COLUMN entitlement_map jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE sso_providers ADD CONSTRAINT sso_providers_entitlement_map_object CHECK (jsonb_typeof(entitlement_map) = 'object');
ALTER TABLE sso_providers ADD CONSTRAINT sso_providers_entitlement_claim_shape CHECK (
  entitlement_claim IS NULL OR entitlement_claim ~ '^[A-Za-z0-9_.:/-]{1,200}$');
-- 접두 없이 entitlement 를 읽으면 다른 앱의 entitlement 까지 이 앱의 권한이 된다.
ALTER TABLE sso_providers ADD CONSTRAINT sso_providers_entitlement_prefix CHECK (
  entitlement_claim IS NULL OR entitlement_prefix ~ '^[A-Za-z0-9_.:/-]{1,100}$');

-- 사람마다 마지막으로 적용한 Role Change 의 txn(발급 밀리초). 이보다 새롭지 않은 SET 은 버린다 — 늦게 온 옛 스냅숏이
-- 철회를 되돌리지 않게.
ALTER TABLE user_identities ADD COLUMN role_change_txn numeric(30, 0);

-- 적용한 SET 의 jti. 수명(exp)이 지나면 지운다 — 그 뒤의 재전송은 exp 검사가 막는다.
CREATE TABLE idp_set_jti (
  issuer         text NOT NULL,
  jti            text NOT NULL,
  expires_at     timestamptz NOT NULL,
  PRIMARY KEY (issuer, jti)
);
ALTER TABLE idp_set_jti ADD CONSTRAINT idp_set_jti_shape CHECK (length(jti) BETWEEN 1 AND 200);
