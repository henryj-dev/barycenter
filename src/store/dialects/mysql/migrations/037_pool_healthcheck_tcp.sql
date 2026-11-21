-- PG 계열의 037_pool_healthcheck_tcp.sql 과 같은 자리 — tcp 풀도 헬스체크를 적는다. 이유는 그 파일 머리말에 있다.
--
-- 지우기와 달기를 한 `ALTER` 에 묶는다(034 와 같다). 한 문장은 통째로 되거나 안 되므로, 다시 돌아도
-- `DROP` 이 옛것이든 새것이든 같은 이름의 제약을 찾는다.
ALTER TABLE `pools` DROP CONSTRAINT `pool_healthcheck_http_only`, ADD CONSTRAINT `pool_healthcheck_http_only` CHECK (health_check IS NULL OR protocol_class <> 'udp');
