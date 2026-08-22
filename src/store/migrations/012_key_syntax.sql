-- 검수 2026-08-22 · S-01b — **key 는 파일 경로가 된다**
--
-- 인증서 key 는 `certs/<key>/<version>/privkey.pem` 으로 세대에 들어가고(`certPaths`),
-- ACME 는 `acme-<key>` 를 SecretStore 이름으로 쓴다. 그런데 key 에 형식 검증이 하나도
-- 없었다 — `../` 하나로 세대 디렉토리 밖에 개인키를 쓸 수 있었고, 실행으로 재현했다.
--
-- §4.0 이 제약을 세 층으로 나눈 그대로다: 해독은 모양을, **DB 는 마지막 그물**을 진다.
-- 애플리케이션의 `shapeCheck` 를 잊거나 우회해도 여기서 막힌다.
--
-- ⚠️ **해독기(`decodeModel`)에는 같은 규칙을 걸지 않았다.** `modelAt` 이 옛 리비전
-- 스냅샷을 그 해독기로 읽기 때문이다 — 좁히면 규칙 밖의 key 가 든 리비전이 통째로
-- 해독 불가가 되고 **그 리비전으로 롤백할 수 없다.** 이 CHECK 도 새 행에만 걸린다
-- (기존 행은 마이그레이션 시점에 검사되지만, 그 검사가 실패하면 배포 전에 알게 된다 —
-- 착수 전 조사 쿼리가 그것을 위한 것이다).
--
-- 문자 집합은 `FsSecretStore` 의 이름 규칙과 **같게** 맞춘다. 안 맞추면 "모델에는
-- 저장되는데 ACME 가 그 인증서만 발급 못 하는" 조합이 생긴다.

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'pools', 'backends', 'listeners', 'http_routes', 'passthrough_routes',
    'certificates', 'tls_policies', 'sni_certificate_bindings'
  ] LOOP
    EXECUTE format(
      'ALTER TABLE %I ADD CONSTRAINT %I CHECK (key ~ %L)',
      t, t || '_key_syntax', '^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$');
  END LOOP;
END $$;
