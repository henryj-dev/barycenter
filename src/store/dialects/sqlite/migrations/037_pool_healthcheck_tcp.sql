-- bary:writable-schema
-- PG 계열의 037_pool_healthcheck_tcp.sql 과 같은 자리 — tcp 풀도 헬스체크를 적는다. 이유는 그 파일 머리말에 있다.
--
-- CHECK 를 바꾸는 길은 034 와 같다(저장된 CREATE 문을 고치고 `schema_version` 을 올린다). 넓히기만 하므로
-- 기존 행은 언제나 새 CHECK 를 통과한다.
UPDATE sqlite_schema SET sql = replace(sql,
  'CONSTRAINT pool_healthcheck_http_only CHECK (health_check IS NULL OR protocol_class = ''http'')',
  'CONSTRAINT pool_healthcheck_http_only CHECK (health_check IS NULL OR protocol_class <> ''udp'')')
WHERE type = 'table' AND name = 'pools';

-- **고쳤는지 확인한다.** 글자 하나가 001 과 다르면 replace 는 조용히 아무것도 안 한다.
CREATE TEMP TABLE bary_037_guard (
  what text NOT NULL,
  got integer NOT NULL,
  want integer NOT NULL,
  CHECK (got = want));
INSERT INTO bary_037_guard SELECT '새 헬스체크 규칙을 가진 pools',
  count(*), 1 FROM sqlite_schema WHERE type = 'table' AND name = 'pools'
    AND instr(sql, 'protocol_class <> ''udp''') > 0 AND instr(sql, 'protocol_class = ''http'')') = 0;
DROP TABLE bary_037_guard;
