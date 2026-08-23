-- 017_header_rules.sql
-- 제안 #7 — **요청·응답 헤더를 얹을 자리가 없었다**
--
-- `validateHeaderName`/`validateHeaderValue` 는 변수 화이트리스트까지 이미 있었는데
-- 해시 키만 쓰고 있었다. 얹을 자리가 없었으니까.
--
-- `jsonb` 로 둔다. 두 목록이 서로 독립이고 각 항목이 (name, value) 쌍이라, 컬럼으로
-- 펴려면 테이블을 하나 더 만들어야 한다 — 그 테이블의 유일한 소비자가 렌더러 한 곳이다.
-- 011 의 `hsts`, 014 의 `health_check`, 016 의 `proxy_limits` 와 같은 판단이다.
ALTER TABLE listeners ADD COLUMN header_rules jsonb;

-- **http·https 리스너에만.** 해독기가 `HttpProfile` 안에만 두는 것과 같은 규칙이다 —
-- stream 에는 `add_header` 도 `proxy_set_header` 도 없다.
ALTER TABLE listeners ADD CONSTRAINT listener_header_rules_http_only CHECK (
  header_rules IS NULL OR protocol IN ('http', 'https'));

-- 모양만 본다. 이름이 token 인지, 값에 CR/LF 가 없는지, 덮으면 안 되는 이름인지는
-- 해독기가 진다 — 그 규칙은 nginx 의 것이고 SQL 로 옮기면 두 자리가 갈린다.
ALTER TABLE listeners ADD CONSTRAINT listener_header_rules_shape CHECK (
  header_rules IS NULL OR jsonb_typeof(header_rules) = 'object');
