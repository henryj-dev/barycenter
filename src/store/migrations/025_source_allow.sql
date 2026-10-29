-- 리스너 출발지 제한 (sourceAllow, 2026-10-29)
--
-- Cloudflare 프록시 뒤의 오리진처럼 **정해진 앞단만 연결해야 하는** 리스너가 있다. 지금까지는
-- 방화벽 말고 정할 자리가 없었다. 렌더는 http 계열이 `geo $realip_remote_addr` + server
-- 레벨 `if`, stream 이 `allow …; deny all;` 다 (render.ts 의 `sourceAllowGeo` 머리말).
--
-- **`text[]` 다. `cidr[]` 이 아니다.** `cidr` 은 값을 정규화한다(`1.2.3.4` → `1.2.3.4/32`,
-- IPv6 표기 축약) — 그러면 적은 것과 읽어 온 것이 달라져 plan 이 매번 바뀐 것으로 본다.
-- 모양 검사는 해독기(`cidrVersion`)가 진다. 024 의 `real_ip_header_cidrs` 와 같은 판단이다.
ALTER TABLE listeners ADD COLUMN source_allow text[];

-- **비어 있을 수 없다.** 빈 목록은 「아무도 못 들어온다」와 「제한 없음」 중 어느 쪽으로
-- 읽어도 한쪽은 운영자의 의도와 반대다 — 둘 다 이미 다른 이름이 있다(enabled · NULL).
ALTER TABLE listeners ADD CONSTRAINT listener_source_allow_nonempty CHECK (
  source_allow IS NULL OR cardinality(source_allow) > 0);

-- **stream 에서는 PROXY 수신과 같이 못 쓴다.** stream realip 이 주소를 바꾼 **뒤에** `allow`
-- 가 돌아서 앞단 대역 검사가 원본 클라이언트 검사로 바뀐다. 검증기도 같은 규칙을 건다.
ALTER TABLE listeners ADD CONSTRAINT listener_source_allow_stream_proxy CHECK (
  source_allow IS NULL OR accept_proxy_cidrs IS NULL OR protocol IN ('http', 'https'));
