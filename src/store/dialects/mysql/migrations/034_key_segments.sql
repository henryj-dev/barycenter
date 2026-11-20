-- PG 계열의 034_key_segments.sql 과 같은 자리 — 리소스 key 가 `:` 로 구간을 잇고 127 자까지 간다.
-- 규칙과 이유는 그 파일 머리말에 있다. MySQL 계열에서 001 뒤의 **첫 실제 단계**다.
--
-- `DROP CONSTRAINT` 를 쓴다 — MySQL 8.0.19+ 와 MariaDB 가 둘 다 받는 꼴이다(`DROP CHECK` 는 MySQL 만).
-- MySQL 의 DDL 은 트랜잭션이 아니다 — 중간에 멈추면 실행기가 이 단계를 "적용됨" 으로 적지 않고,
-- 다음 기동이 처음부터 다시 돈다. 그래서 **지우기와 달기를 한 `ALTER` 에 묶는다.** 한 문장은 통째로
-- 되거나 안 되므로 제약은 언제나 옛것이든 새것이든 하나 있고, 다시 돌아도 `DROP` 이 그것을 찾는다.
-- (`DROP CONSTRAINT IF EXISTS` 는 MariaDB 만 받는다.) MySQL 8.4 · MariaDB 11 에서 두 번 돌려 확인했다.
--
-- `RIGHT(..., 1)` 은 001 과 같은 이유로 남긴다 — MySQL 의 `$` 는 맨 끝 줄바꿈 앞에서도 맞는다.

ALTER TABLE `pools` DROP CONSTRAINT `pools_key_syntax`, ADD CONSTRAINT `pools_key_syntax` CHECK ((CHAR_LENGTH(`key`) <= 127 AND `key` REGEXP '^[A-Za-z0-9][A-Za-z0-9._-]*(:[A-Za-z0-9][A-Za-z0-9._-]*)*$' AND RIGHT(`key`, 1) REGEXP '[A-Za-z0-9._-]'));

ALTER TABLE `backends` DROP CONSTRAINT `backends_key_syntax`, ADD CONSTRAINT `backends_key_syntax` CHECK ((CHAR_LENGTH(`key`) <= 127 AND `key` REGEXP '^[A-Za-z0-9][A-Za-z0-9._-]*(:[A-Za-z0-9][A-Za-z0-9._-]*)*$' AND RIGHT(`key`, 1) REGEXP '[A-Za-z0-9._-]'));

ALTER TABLE `listeners` DROP CONSTRAINT `listeners_key_syntax`, ADD CONSTRAINT `listeners_key_syntax` CHECK ((CHAR_LENGTH(`key`) <= 127 AND `key` REGEXP '^[A-Za-z0-9][A-Za-z0-9._-]*(:[A-Za-z0-9][A-Za-z0-9._-]*)*$' AND RIGHT(`key`, 1) REGEXP '[A-Za-z0-9._-]'));

ALTER TABLE `http_routes` DROP CONSTRAINT `http_routes_key_syntax`, ADD CONSTRAINT `http_routes_key_syntax` CHECK ((CHAR_LENGTH(`key`) <= 127 AND `key` REGEXP '^[A-Za-z0-9][A-Za-z0-9._-]*(:[A-Za-z0-9][A-Za-z0-9._-]*)*$' AND RIGHT(`key`, 1) REGEXP '[A-Za-z0-9._-]'));

ALTER TABLE `passthrough_routes` DROP CONSTRAINT `passthrough_routes_key_syntax`, ADD CONSTRAINT `passthrough_routes_key_syntax` CHECK ((CHAR_LENGTH(`key`) <= 127 AND `key` REGEXP '^[A-Za-z0-9][A-Za-z0-9._-]*(:[A-Za-z0-9][A-Za-z0-9._-]*)*$' AND RIGHT(`key`, 1) REGEXP '[A-Za-z0-9._-]'));

ALTER TABLE `certificates` DROP CONSTRAINT `certificates_key_syntax`, ADD CONSTRAINT `certificates_key_syntax` CHECK ((CHAR_LENGTH(`key`) <= 127 AND `key` REGEXP '^[A-Za-z0-9][A-Za-z0-9._-]*(:[A-Za-z0-9][A-Za-z0-9._-]*)*$' AND RIGHT(`key`, 1) REGEXP '[A-Za-z0-9._-]'));

ALTER TABLE `tls_policies` DROP CONSTRAINT `tls_policies_key_syntax`, ADD CONSTRAINT `tls_policies_key_syntax` CHECK ((CHAR_LENGTH(`key`) <= 127 AND `key` REGEXP '^[A-Za-z0-9][A-Za-z0-9._-]*(:[A-Za-z0-9][A-Za-z0-9._-]*)*$' AND RIGHT(`key`, 1) REGEXP '[A-Za-z0-9._-]'));

ALTER TABLE `sni_certificate_bindings` DROP CONSTRAINT `sni_certificate_bindings_key_syntax`, ADD CONSTRAINT `sni_certificate_bindings_key_syntax` CHECK ((CHAR_LENGTH(`key`) <= 127 AND `key` REGEXP '^[A-Za-z0-9][A-Za-z0-9._-]*(:[A-Za-z0-9][A-Za-z0-9._-]*)*$' AND RIGHT(`key`, 1) REGEXP '[A-Za-z0-9._-]'));

ALTER TABLE `address_sets` DROP CONSTRAINT `address_sets_key_syntax`, ADD CONSTRAINT `address_sets_key_syntax` CHECK ((CHAR_LENGTH(`key`) <= 127 AND `key` REGEXP '^[A-Za-z0-9][A-Za-z0-9._-]*(:[A-Za-z0-9][A-Za-z0-9._-]*)*$' AND RIGHT(`key`, 1) REGEXP '[A-Za-z0-9._-]'));

ALTER TABLE `secret_materials` DROP CONSTRAINT `secret_materials_name_shape`, ADD CONSTRAINT `secret_materials_name_shape` CHECK ((name REGEXP '^[A-Za-z0-9._:-]+$' AND RIGHT(name, 1) REGEXP '[A-Za-z0-9._:-]'));

ALTER TABLE `certificates` DROP CONSTRAINT `certificates_material_ref_check`, ADD CONSTRAINT `certificates_material_ref_check` CHECK (material_ref IS NULL OR (material_ref REGEXP '^store://[A-Za-z0-9._:-]+@[a-f0-9]{16,64}$' AND RIGHT(material_ref, 1) REGEXP '[a-f0-9]'));

ALTER TABLE `acme_accounts` DROP CONSTRAINT `acme_accounts_account_key_ref_check`, ADD CONSTRAINT `acme_accounts_account_key_ref_check` CHECK ((account_key_ref REGEXP '^key://[A-Za-z0-9._:-]+@[a-f0-9]{16,64}$' AND RIGHT(account_key_ref, 1) REGEXP '[a-f0-9]'));

ALTER TABLE `acme_orders` DROP CONSTRAINT `acme_orders_issued_ref_check`, ADD CONSTRAINT `acme_orders_issued_ref_check` CHECK (issued_ref IS NULL OR (issued_ref REGEXP '^store://[A-Za-z0-9._:-]+@[a-f0-9]{16,64}$' AND RIGHT(issued_ref, 1) REGEXP '[a-f0-9]'));

ALTER TABLE `acme_orders` DROP CONSTRAINT `acme_orders_cert_key_ref_check`, ADD CONSTRAINT `acme_orders_cert_key_ref_check` CHECK (cert_key_ref IS NULL OR (cert_key_ref REGEXP '^key://[A-Za-z0-9._:-]+@[a-f0-9]{16,64}$' AND RIGHT(cert_key_ref, 1) REGEXP '[a-f0-9]'));
