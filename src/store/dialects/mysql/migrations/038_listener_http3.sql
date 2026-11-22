-- PG 계열의 038_listener_http3.sql 과 같은 자리 — HTTPS 리스너의 HTTP/3. 이유는 그 파일 머리말에 있다.
--
-- 열과 제약을 한 `ALTER` 에 묶는다(034 · 037 과 같다). 한 문장은 통째로 되거나 안 된다 — 반쯤 단 상태가 안 남는다.
ALTER TABLE `listeners` ADD COLUMN `http3` boolean, ADD CONSTRAINT `listener_http3_only_https` CHECK (`http3` IS NULL OR `protocol` = 'https');
