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
