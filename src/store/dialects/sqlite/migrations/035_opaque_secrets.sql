-- bary:writable-schema
-- PG 계열의 035_opaque_secrets.sql 과 같은 자리 — 시크릿 저장소의 `opaque` 스킴. 이유는 그 파일 머리말에 있다.
--
-- SQLite 는 CHECK 를 `ALTER TABLE` 로 못 바꾼다. 034 와 같은 길이다 — 저장된 CREATE 문을 고친다(`writable_schema`).
-- 넓히기만 하므로 기존 행은 언제나 새 CHECK 를 통과한다.

UPDATE sqlite_schema SET sql = replace(sql,
  'CHECK (scheme IN (''store'', ''key''))',
  'CHECK (scheme IN (''store'', ''key'', ''opaque''))')
WHERE type = 'table' AND name = 'secret_materials';

UPDATE sqlite_schema SET sql = replace(sql,
  'scheme <> ''key'' OR (chain_digest IS NULL',
  'scheme NOT IN (''key'', ''opaque'') OR (chain_digest IS NULL')
WHERE type = 'table' AND name = 'secret_materials';

-- **고쳤는지 확인한다.** 글자 하나가 001 과 다르면 replace 는 조용히 아무것도 안 한다.
CREATE TEMP TABLE bary_035_guard (
  what text NOT NULL,
  got integer NOT NULL,
  want integer NOT NULL,
  CHECK (got = want));
INSERT INTO bary_035_guard SELECT '새 스킴 목록', count(*), 1 FROM sqlite_schema
  WHERE type = 'table' AND name = 'secret_materials' AND instr(sql, 'CHECK (scheme IN (''store'', ''key'', ''opaque''))') > 0;
INSERT INTO bary_035_guard SELECT '체인 없음 제약', count(*), 1 FROM sqlite_schema
  WHERE type = 'table' AND name = 'secret_materials' AND instr(sql, 'scheme NOT IN (''key'', ''opaque'') OR (chain_digest IS NULL') > 0;
DROP TABLE bary_035_guard;
