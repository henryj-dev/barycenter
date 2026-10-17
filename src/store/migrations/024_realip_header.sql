-- 헤더로 받는 원본 IP (DESIGN.md §4.7 의 HTTP 판, 2026-10-18)
--
-- 지금까지 원본 IP 의 출처는 PROXY protocol 하나였다(004). 그런데 Cloudflare 일반 프록시처럼
-- PROXY 를 안 보내는 앞단은 원본 IP 를 **HTTP 헤더**(`CF-Connecting-IP`·`X-Forwarded-For`)로
-- 넘긴다. 그 헤더를 쓰려면 http·https 리스너에 신뢰 대역과 헤더 이름을 적을 자리가 필요하다.
--
-- **004 의 원칙을 그대로 잇는다: 신뢰 대역 없이는 켤 수 없다.** 헤더는 누구나 붙인다 —
-- 대역 없이 받으면 클라이언트가 자기 IP 를 정한다. 그래서 두 컬럼은 함께만 있다.

ALTER TABLE listeners ADD COLUMN real_ip_header text;
ALTER TABLE listeners ADD COLUMN real_ip_header_cidrs text[];

-- 헤더 이름과 신뢰 대역은 **같이 있거나 같이 없다.** 대역은 비어 있을 수 없다.
ALTER TABLE listeners ADD CONSTRAINT listener_real_ip_header_pair CHECK (
  (real_ip_header IS NULL AND real_ip_header_cidrs IS NULL)
  OR (real_ip_header IS NOT NULL AND real_ip_header_cidrs IS NOT NULL
      AND cardinality(real_ip_header_cidrs) > 0));

-- 해독기의 `REAL_IP_HEADERS` 와 같은 목록이다. 자유 문자열이면 오타가 realip 을 조용히 끈다.
ALTER TABLE listeners ADD CONSTRAINT listener_real_ip_header_name CHECK (
  real_ip_header IS NULL
  OR real_ip_header IN ('CF-Connecting-IP', 'X-Forwarded-For', 'X-Real-IP'));

-- **http·https 에만.** 헤더는 HTTP 를 푼 뒤에만 보인다.
ALTER TABLE listeners ADD CONSTRAINT listener_real_ip_header_http_only CHECK (
  real_ip_header IS NULL OR protocol IN ('http', 'https'));

-- **원본 IP 의 출처는 하나다.** nginx 의 `real_ip_header` 는 server 마다 하나라 PROXY 와
-- 헤더를 같이 적으면 어느 쪽이 이기는지가 렌더 순서에 달린다. 검증기도 같은 규칙을 건다.
ALTER TABLE listeners ADD CONSTRAINT listener_real_ip_single_source CHECK (
  real_ip_header IS NULL OR accept_proxy_cidrs IS NULL);
