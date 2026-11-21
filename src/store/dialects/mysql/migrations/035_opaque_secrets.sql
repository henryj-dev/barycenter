-- PG 계열의 035_opaque_secrets.sql 과 같은 자리 — 시크릿 저장소의 `opaque` 스킴. 이유는 그 파일 머리말에 있다.
--
-- 034 와 같이 **지우기와 달기를 한 `ALTER` 에 묶는다.** DDL 이 트랜잭션이 아니어서, 중간에 멈춰 다시 돌아도 제약은
-- 언제나 옛것이든 새것이든 하나 있고 `DROP` 이 그것을 찾는다.

ALTER TABLE `secret_materials` DROP CONSTRAINT `secret_materials_scheme`, ADD CONSTRAINT `secret_materials_scheme` CHECK (scheme IN ('store', 'key', 'opaque'));

ALTER TABLE `secret_materials` DROP CONSTRAINT `secret_materials_key_has_no_chain`, ADD CONSTRAINT `secret_materials_key_has_no_chain` CHECK (scheme NOT IN ('key', 'opaque') OR (chain_digest IS NULL AND sha256 IS NULL AND facts IS NULL));
