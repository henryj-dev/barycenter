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
