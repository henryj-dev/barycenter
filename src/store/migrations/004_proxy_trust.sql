-- 인바운드 PROXY 수신에 **신뢰 경계**를 붙인다 (DESIGN.md §4.7)
--
-- 지금까지 `accept_proxy_protocol boolean` 이었다. 즉 **"켠다" 를 신뢰 경계 없이 표현할
-- 수 있었다.** 엔진으로 실측한 결과(E63) 그게 왜 위험한지가 분명하다:
--
--   realip 없음   $remote_addr = 실제 peer,  $proxy_protocol_addr = **헤더가 말하는 값**
--   peer 신뢰     $remote_addr = 헤더 값
--   peer 불신     $remote_addr = **실제 peer** (헤더가 뭐라 하든)
--
-- **`$proxy_protocol_addr` 는 어떤 경우에도 게이팅되지 않는다.** 그런데 렌더러는 그
-- 변수로 소스IP 해시를 계산했다 — 클라이언트가 자기를 원하는 백엔드로 몰 수 있었다.
--
-- **켜져 있던 것은 꺼진다.** 신뢰 경계를 지어낼 수 없기 때문이다. 임의의 기본값
-- (`0.0.0.0/0` 같은)을 넣으면 "아무나 믿는다" 를 조용히 굳히는 셈이고, 그건 지금 고치려는
-- 바로 그 상태다. 쓰던 배포는 **다시 선언해야 한다** — 그게 이 마이그레이션의 요점이다.

ALTER TABLE listeners ADD COLUMN accept_proxy_cidrs text[];

-- 옛 값은 옮기지 않는다. 위 주석의 이유로 **의도적으로** 버린다.
ALTER TABLE listeners DROP CONSTRAINT listener_udp_shape;
ALTER TABLE listeners DROP COLUMN accept_proxy_protocol;

ALTER TABLE listeners ADD CONSTRAINT listener_udp_shape CHECK (protocol <> 'udp' OR (
  udp_preset IS NOT NULL AND default_pool_id IS NOT NULL
  AND accept_proxy_cidrs IS NULL
  AND http_default_pool_id IS NULL AND http_default_reject IS NULL
  AND on_unmatched_sni_pool IS NULL AND on_unmatched_sni_reject IS NULL
  AND preread_timeout_s IS NULL));

-- **빈 배열은 켠 것도 끈 것도 아니다.** 아무도 안 믿을 거면 켜지 않는다.
ALTER TABLE listeners ADD CONSTRAINT listener_proxy_cidrs_nonempty CHECK (
  accept_proxy_cidrs IS NULL OR cardinality(accept_proxy_cidrs) > 0);
