-- 시크릿 저장소에 **불투명 값**을 둔다 — 알림 통로의 비밀(웹훅 서명 비밀 · Slack 웹훅 URL) (2026-11-20).
--
-- 지금까지 저장소는 두 가지만 들었다: `store`(인증서 한 벌) · `key`(인증서 없는 개인키). 알림 비밀은 둘 다 아니다 —
-- PEM 이 아니고 짝도 없다. `key` 에 넣으면 「개인키」 라는 뜻이 거짓이 되고, 개인키 검사(`createPrivateKey`)가 막는다.
-- 그래서 스킴을 하나 더한다: `opaque://<이름>@<버전>`. 값은 다른 자료와 같이 KEK 로 감싼다(봉투 암호화).
--
-- `opaque` 행은 체인 · 사실을 들지 않는다(`key` 와 같다) — 「체인이 없어야 한다」 제약을 두 스킴에 건다.
-- `key_digest` 는 값의 digest 다. 청소(`secret-gc`)는 `opaque` 를 보지 않는다 — 쓰는 쪽(알림 설정)이 값을 바꿀 때
-- 옛 버전을 직접 지운다.
ALTER TABLE secret_materials DROP CONSTRAINT secret_materials_scheme;
ALTER TABLE secret_materials ADD CONSTRAINT secret_materials_scheme
  CHECK (scheme IN ('store', 'key', 'opaque'));
ALTER TABLE secret_materials DROP CONSTRAINT secret_materials_key_has_no_chain;
ALTER TABLE secret_materials ADD CONSTRAINT secret_materials_key_has_no_chain
  CHECK (scheme NOT IN ('key', 'opaque') OR (chain_digest IS NULL AND sha256 IS NULL AND facts IS NULL));
