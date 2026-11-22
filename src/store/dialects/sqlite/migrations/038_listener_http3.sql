-- PG 계열의 038_listener_http3.sql 과 같은 자리 — HTTPS 리스너의 HTTP/3. 이유는 그 파일 머리말에 있다.
--
-- SQLite 는 `ADD CONSTRAINT` 가 없다. 열 제약으로 CHECK 를 함께 단다 — 새 열이라 기존 행은 NULL 이고 언제나 통과한다.
ALTER TABLE listeners ADD COLUMN http3 boolean
  CONSTRAINT listener_http3_only_https CHECK (http3 IS NULL OR protocol = 'https');
