-- bary:writable-schema
-- PG 계열의 034_key_segments.sql 과 같은 자리 — 리소스 key 가 `:` 로 구간을 잇고 127 자까지 간다.
-- 규칙과 이유는 그 파일 머리말에 있다. SQLite 계열에서 001 뒤의 **첫 실제 단계**다.
--
-- ── 왜 sqlite_schema 를 직접 고치는가
--
-- SQLite 는 CHECK 를 `ALTER TABLE` 로 못 바꾼다. 공식 절차는 둘이다:
--
--   (a) 테이블을 새로 만들어 옮긴다 — `foreign_keys=OFF` 가 필요한데, 그 PRAGMA 는 트랜잭션
--       안에서 아무 일도 안 한다. 마이그레이션은 한 트랜잭션이다(`BEGIN IMMEDIATE`). 켠 채로
--       옛 테이블을 지우면 `ON DELETE CASCADE` 가 자식 행을 지운다.
--   (b) `PRAGMA writable_schema` 로 저장된 CREATE 문을 고치고 `schema_version` 을 올린다 —
--       디스크의 데이터 모양이 안 바뀌는 변경(CHECK 를 더하고 빼고 바꾸는 것)에 쓰라고 SQLite 문서
--       ("Making Other Kinds Of Table Schema Changes")가 적은 길이다.
--
-- (b) 다. 넓히기만 하므로 기존 행은 언제나 새 CHECK 를 통과한다. 첫 줄의 표시를 보고 실행기가
-- 이 파일 동안만 방어 모드를 끄고 `writable_schema` 를 켜며, 끝나면 `schema_version` 을 올린다
-- (`src/store/sqlite.ts` 의 `applyOne`). 트랜잭션 안이므로 실패하면 통째로 되돌아간다.

-- ① 리소스 key — 9 개 테이블이 같은 글자로 적혀 있다(001_init.sql).
UPDATE sqlite_schema SET sql = replace(sql,
  'length(key) BETWEEN 1 AND 63 AND key GLOB ''[A-Za-z0-9]*'' AND key NOT GLOB ''*[^A-Za-z0-9._-]*''',
  'length(key) BETWEEN 1 AND 127 AND key GLOB ''[A-Za-z0-9]*'' AND key NOT GLOB ''*[^A-Za-z0-9._:-]*'''
  || ' AND key NOT GLOB ''*:'' AND key NOT GLOB ''*:[^A-Za-z0-9]*''')
WHERE type = 'table';

-- ② 시크릿 이름.
UPDATE sqlite_schema SET sql = replace(sql,
  'name NOT GLOB ''*[^A-Za-z0-9._-]*''',
  'name NOT GLOB ''*[^A-Za-z0-9._:-]*''')
WHERE type = 'table' AND name = 'secret_materials';

-- ③ 참조의 이름 부분 — `store://<이름>@…` · `key://<이름>@…` (certificates · acme_accounts · acme_orders).
UPDATE sqlite_schema SET sql = replace(sql,
  '''@'') - 1) NOT GLOB ''*[^A-Za-z0-9._-]*''',
  '''@'') - 1) NOT GLOB ''*[^A-Za-z0-9._:-]*''')
WHERE type = 'table' AND name IN ('certificates', 'acme_accounts', 'acme_orders');

-- **고쳤는지 확인한다.** 글자 하나가 001 과 다르면 replace 는 조용히 아무것도 안 한다 — 그러면
-- 마이그레이션은 "적용됨" 으로 남고 규칙은 옛것 그대로다. CHECK 가 걸린 임시 테이블에 센 값을
-- 넣어 맞지 않으면 이 단계를 실패시킨다.
CREATE TEMP TABLE bary_034_guard (
  what text NOT NULL,
  got integer NOT NULL,
  want integer NOT NULL,
  CHECK (got = want));
INSERT INTO bary_034_guard SELECT '옛 문자 집합이 남은 테이블',
  count(*), 0 FROM sqlite_schema WHERE type = 'table' AND instr(sql, '[^A-Za-z0-9._-]') > 0;
INSERT INTO bary_034_guard SELECT '새 key 규칙을 가진 테이블',
  count(*), 9 FROM sqlite_schema WHERE type = 'table' AND instr(sql, 'length(key) BETWEEN 1 AND 127') > 0;
INSERT INTO bary_034_guard SELECT '새 참조 규칙의 개수',
  (SELECT count(*) FROM sqlite_schema WHERE type = 'table' AND name = 'certificates' AND instr(sql, '''@'') - 1) NOT GLOB ''*[^A-Za-z0-9._:-]*''') > 0)
  + (SELECT count(*) FROM sqlite_schema WHERE type = 'table' AND name = 'acme_accounts' AND instr(sql, '''@'') - 1) NOT GLOB ''*[^A-Za-z0-9._:-]*''') > 0)
  + (SELECT count(*) FROM sqlite_schema WHERE type = 'table' AND name = 'acme_orders'
       AND length(sql) - length(replace(sql, '''@'') - 1) NOT GLOB ''*[^A-Za-z0-9._:-]*''', '')) = 2 * length('''@'') - 1) NOT GLOB ''*[^A-Za-z0-9._:-]*''')),
  3;
DROP TABLE bary_034_guard;
