-- 038_listener_http3.sql
-- HTTPS 리스너의 HTTP/3 (QUIC, 2026-11-22)
--
-- 켜면 같은 포트를 UDP 로도 열고(`listen … quic`), TCP 응답에 `Alt-Svc` 를 싣는다. 없으면 NULL — 끈다.
-- http2(011) 와 같은 모양이다: `NULL`(안 정함) 과 `false`(끄라고 함) 를 구분한다.
ALTER TABLE listeners ADD COLUMN http3 boolean;

-- **https 에만.** 검증기의 `notHere('http3', …)` 와 같은 규칙을 DB 에도 건다.
ALTER TABLE listeners ADD CONSTRAINT listener_http3_only_https CHECK (
  http3 IS NULL OR protocol = 'https');
