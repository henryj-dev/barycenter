-- 016_proxy_limits.sql
-- 제안 #8 — **타임아웃·본문 크기가 nginx 기본값 고정이었다**
--
-- `proxy_connect_timeout`(60s) · `proxy_read_timeout`(60s) · `client_max_body_size`(1m)
-- 를 정할 자리가 없었다. 마지막 것이 특히 물린다: 기본 1m 이라 조금 큰 업로드가 413 으로
-- 죽는데 고칠 손잡이가 없었다.
--
-- `jsonb` 로 둔다. 네 필드가 전부 선택이고 서로 독립이라 컬럼 넷으로 펴면 NULL 조합이
-- 열여섯 가지가 되는데, 그중 의미 있는 제약은 "http 계열 리스너에만" 하나뿐이다.
-- 011 의 `hsts`, 014 의 `health_check` 와 같은 판단이다.
ALTER TABLE listeners ADD COLUMN proxy_limits jsonb;

-- **http·https 리스너에만.** 해독기가 `HttpProfile` 안에만 두는 것과 같은 규칙을 DB 에도
-- 건다 — tcp·udp·패스스루에 적힌 값은 아무도 안 읽고, 안 읽는 값이 저장되면 다음 사람은
-- 그게 동작한다고 믿는다.
ALTER TABLE listeners ADD CONSTRAINT listener_proxy_limits_http_only CHECK (
  proxy_limits IS NULL OR protocol IN ('http', 'https'));

-- 모양만 본다. 값의 의미(nginx 의 75s 상한 등)는 해독기가 진다.
ALTER TABLE listeners ADD CONSTRAINT listener_proxy_limits_shape CHECK (
  proxy_limits IS NULL OR jsonb_typeof(proxy_limits) = 'object');
