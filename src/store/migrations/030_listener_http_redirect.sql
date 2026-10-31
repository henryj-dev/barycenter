-- 030_listener_http_redirect.sql
-- HTTPS 리스너의 평문 리다이렉트 (httpRedirect, 2026-10-31)
--
-- HTTPS 리스너가 같은 바인드의 이 포트(보통 80)에 평문 server 를 세우고 `301 https://…` 로 돌려보낸다.
-- 없으면 NULL — 리다이렉트를 안 한다. 그 평문 소켓은 모델에 따로 적히지 않고, 검증기 · 렌더러가 리스너처럼 다룬다.
ALTER TABLE listeners ADD COLUMN http_redirect_port integer;

-- **포트 범위.** 해독기와 같은 경계다.
ALTER TABLE listeners ADD CONSTRAINT listener_http_redirect_port_range CHECK (
  http_redirect_port IS NULL OR http_redirect_port BETWEEN 1 AND 65535);

-- **https 에만.** 평문 리스너가 평문으로 리다이렉트할 곳은 없다.
ALTER TABLE listeners ADD CONSTRAINT listener_http_redirect_https_only CHECK (
  http_redirect_port IS NULL OR protocol = 'https');
