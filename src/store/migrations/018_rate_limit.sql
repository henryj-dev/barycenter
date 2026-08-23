-- 018_rate_limit.sql
-- 제안 #6 — **레이트리밋·커넥션 제한이 모델에 없었다**
--
-- `limit_req`·`limit_conn` 은 리버스 프록시에 사실상 필수인데 정할 자리가 없었다.
--
-- `jsonb` 로 둔다. 다섯 필드가 서로 얽혀 있고(`burst` 는 `requestsPerSecond` 없이 못
-- 쓴다) 그 규칙은 nginx 의 것이라 해독기가 진다 — SQL 로 옮기면 두 자리가 갈린다.
-- 011 의 `hsts`, 014 의 `health_check`, 016·017 과 같은 판단이다.
ALTER TABLE listeners ADD COLUMN rate_limit jsonb;

-- **http·https 리스너에만.** stream 에는 `limit_req` 가 없다 (`limit_conn` 은 stream
-- 에도 있지만 zone 타입이 다르고, 그건 별건이다).
ALTER TABLE listeners ADD CONSTRAINT listener_rate_limit_http_only CHECK (
  rate_limit IS NULL OR protocol IN ('http', 'https'));

ALTER TABLE listeners ADD CONSTRAINT listener_rate_limit_shape CHECK (
  rate_limit IS NULL OR jsonb_typeof(rate_limit) = 'object');
