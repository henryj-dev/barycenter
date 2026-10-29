-- 프록시 라우트의 요청 헤더와 경로 접두사 바꾸기 (2026-10-29, #109)
--
-- nginx 의 `location /api/ { proxy_pass https://api.example.com/; }` 를 옮길 자리가 없었다.
-- 둘이 필요하다: 이 라우트에만 거는 요청 헤더(`Host: api.example.com`)와, 맞은 접두사를
-- 바꿔 보내는 것(`/api/` → `/`). 리스너 헤더는 같은 리스너의 다른 라우트에도 걸린다.
--
-- `request_headers` 는 jsonb 다 — 017 의 `header_rules` 와 같은 모양(`[{name, value}]`)이고
-- 이름 규칙(예약 이름·중복)은 해독기가 진다. `rewrite_prefix` 는 text 다.
ALTER TABLE http_routes ADD COLUMN request_headers jsonb;
ALTER TABLE http_routes ADD COLUMN rewrite_prefix text;

-- **proxy 라우트에만.** redirect·reject 는 업스트림으로 가지 않는다.
ALTER TABLE http_routes ADD CONSTRAINT http_route_proxy_options_proxy_only CHECK (
  action_kind = 'proxy' OR (request_headers IS NULL AND rewrite_prefix IS NULL));

ALTER TABLE http_routes ADD CONSTRAINT http_route_request_headers_shape CHECK (
  request_headers IS NULL OR jsonb_typeof(request_headers) = 'array');

-- 해독기와 같은 문자 집합. `$` 가 들어가면 nginx 가 변수로 푼다.
ALTER TABLE http_routes ADD CONSTRAINT http_route_rewrite_prefix_shape CHECK (
  rewrite_prefix IS NULL OR rewrite_prefix ~ '^/[A-Za-z0-9._~/%-]*$');
