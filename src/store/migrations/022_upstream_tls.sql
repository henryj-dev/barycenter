-- 022_upstream_tls.sql
-- §4.3 — **백엔드로 가는 TLS** (2026-08-24)
--
-- 표에 오래 적혀만 있고 코드에 없던 필드다. 넣으면서 지킨 것:
--
--   · 스킴으로 켠다 — `proxy_ssl_*` 만 내고 `proxy_pass http://` 를 두면 평문으로 나간다
--   · `verify` 는 신뢰 번들 없이 못 켠다 — "켰다" 와 "걸린다" 가 갈린다
--   · udp 금지 (엔진이 안 한다) · 패스스루가 가리키는 풀 금지 (TLS-over-TLS)
--
-- `jsonb` 로 둔다. 네 필드가 서로 얽혀 있고(`verify` 는 `caBundle` 없이 못 쓴다) 그
-- 규칙은 nginx 의 것이라 해독기·검증기가 진다 — SQL 로 옮기면 두 자리가 갈린다.
-- 011 의 `hsts`, 014 의 `health_check`, 016~018 과 같은 판단이다.
ALTER TABLE pools ADD COLUMN upstream_tls jsonb;

-- **udp 는 안 된다.** 엔진에 `proxy_ssl` 이 udp 용으로 없다.
ALTER TABLE pools ADD CONSTRAINT pool_upstream_tls_not_udp CHECK (
  upstream_tls IS NULL OR protocol_class <> 'udp');

ALTER TABLE pools ADD CONSTRAINT pool_upstream_tls_shape CHECK (
  upstream_tls IS NULL OR jsonb_typeof(upstream_tls) = 'object');

-- **패스스루 금지는 여기서 못 건다.** 그건 라우트 표를 봐야 하는 규칙이라 행 하나의
-- CHECK 으로 표현되지 않는다 — 검증기가 진다 (`option_not_supported`).
