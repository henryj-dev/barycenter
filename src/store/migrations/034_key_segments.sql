-- 2026-11-20 — **리소스 key 가 `:` 로 구간을 잇고 127 자까지 간다**
--
-- 운영자가 `{호스트}:{서비스}[:{세부}][:{분산 구분}]` 으로 이름을 짓는다 —
-- 예: `web-01.dc1:shop:api:01`. `.` 는 호스트 이름 안에서 이미 쓰이므로
-- 구분자가 못 된다. 63 자는 호스트 FQDN 하나로 거의 찬다.
--
-- 규칙은 `src/validate/syntax.ts` 의 `RESOURCE_KEY_SYNTAX` 와 같다: 각 구간은 영숫자로
-- 시작하고 영숫자·점·밑줄·하이픈만, 빈 구간(`::` · 맨 앞 · 맨 뒤 `:`)은 없다.
--
-- **넓히기만 한다.** 지금 있는 key 는 모두 새 규칙에도 맞으므로 기존 행 검사는 언제나 통과한다.
--
-- key 는 시크릿 이름(`acme-<key>`)과 참조(`store://<이름>@…` · `key://<이름>@…`)로도 간다.
-- 그 자리가 `:` 를 거절하면 "모델에는 저장되는데 ACME 가 그 인증서만 발급 못 하는" 조합이
-- 생긴다(012 머리말) — 그래서 셋을 함께 넓힌다. 참조의 이름과 digest 경계는 첫 `@` 이고,
-- 이름에는 여전히 `@` 가 없다.

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'pools', 'backends', 'listeners', 'http_routes', 'passthrough_routes',
    'certificates', 'tls_policies', 'sni_certificate_bindings', 'address_sets'
  ] LOOP
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', t, t || '_key_syntax');
    EXECUTE format(
      'ALTER TABLE %I ADD CONSTRAINT %I CHECK (length(key) <= 127 AND key ~ %L)',
      t, t || '_key_syntax',
      '^[A-Za-z0-9][A-Za-z0-9._-]*(:[A-Za-z0-9][A-Za-z0-9._-]*)*$');
  END LOOP;
END $$;

ALTER TABLE secret_materials DROP CONSTRAINT secret_materials_name_shape;
ALTER TABLE secret_materials ADD CONSTRAINT secret_materials_name_shape
  CHECK (name ~ '^[A-Za-z0-9._:-]+$');

-- 008 · 009 는 이 제약에 이름을 안 줬다 — PG 가 지은 이름(`<테이블>_<열>_check`)이다.
ALTER TABLE certificates DROP CONSTRAINT certificates_material_ref_check;
ALTER TABLE certificates ADD CONSTRAINT certificates_material_ref_check
  CHECK (material_ref ~ '^store://[A-Za-z0-9._:-]+@[a-f0-9]{16,64}$');

ALTER TABLE acme_accounts DROP CONSTRAINT acme_accounts_account_key_ref_check;
ALTER TABLE acme_accounts ADD CONSTRAINT acme_accounts_account_key_ref_check
  CHECK (account_key_ref ~ '^key://[A-Za-z0-9._:-]+@[a-f0-9]{16,64}$');

ALTER TABLE acme_orders DROP CONSTRAINT acme_orders_issued_ref_check;
ALTER TABLE acme_orders ADD CONSTRAINT acme_orders_issued_ref_check
  CHECK (issued_ref IS NULL OR issued_ref ~ '^store://[A-Za-z0-9._:-]+@[a-f0-9]{16,64}$');

ALTER TABLE acme_orders DROP CONSTRAINT acme_orders_cert_key_ref_check;
ALTER TABLE acme_orders ADD CONSTRAINT acme_orders_cert_key_ref_check
  CHECK (cert_key_ref IS NULL OR cert_key_ref ~ '^key://[A-Za-z0-9._:-]+@[a-f0-9]{16,64}$');
