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
