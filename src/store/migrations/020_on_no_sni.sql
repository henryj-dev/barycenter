-- 020_on_no_sni.sql
-- S9 통과 — **"TLS 인데 SNI 가 없다" 를 설정 가능으로 승격한다** (§4.1, §12.0, §13.8)
--
-- 오래 `reject` 고정이었다. 근거는 "SNI 부재와 파싱 실패를 안정적으로 못 가른다" 였고,
-- 그 판정을 §12.0 이 S9 에 걸어 두었다. `spike/s9` 가 실물에서 재 보니 갈린다:
--
--     TLS + SNI 없음   → $ssl_preread_protocol 이 차 있다      (별도 분기)
--     malformed        → preread 가 DECLINED, protocol 이 비었다 (비-TLS 와 한 통)
--     preread timeout  → nginx 가 연결을 끊는다                  (분기에 안 온다)
--
-- **malformed 가 비-TLS 와 같은 통으로 가는 것**이 이 승격을 안전하게 만든다. §4.1 이
-- "파싱 실패는 어디로도 안 보낸다" 고 적은 규칙이 컬럼 하나 늘어난 뒤에도 그대로 산다 —
-- 여기에 풀을 걸어도 TLS 로 안 읽히는 바이트는 그 풀에 안 닿는다.
ALTER TABLE listeners ADD COLUMN on_no_sni_pool   uuid;
ALTER TABLE listeners ADD COLUMN on_no_sni_cls    protocol_class;
ALTER TABLE listeners ADD COLUMN on_no_sni_reject boolean;

-- `on_unmatched_sni` 가 지는 규칙을 **하나도 빠짐없이** 같이 진다. 새 컬럼이 옛 컬럼보다
-- 느슨하면, 같은 그림의 두 분기 중 하나만 DB 가 지켜 주는 상태가 된다.
ALTER TABLE listeners ADD CONSTRAINT listener_no_sni_pool_fk
  FOREIGN KEY (on_no_sni_pool, on_no_sni_cls) REFERENCES pools (id, protocol_class);

-- 패스스루는 TLS 를 종단하지 않으므로 폴백 풀은 **tcp** 다.
ALTER TABLE listeners ADD CONSTRAINT listener_no_sni_pool_class CHECK (
  on_no_sni_cls IS NULL OR on_no_sni_cls = 'tcp');

-- 'reject' 와 {pool} 은 둘 중 하나다.
ALTER TABLE listeners ADD CONSTRAINT listener_no_sni_action_xor CHECK (
  (on_no_sni_reject IS TRUE)::int + (on_no_sni_pool IS NOT NULL)::int <= 1);

-- 켜져 있지도 않은 플래그를 false 로 적으면 "설정 안 함" 과 구분이 안 된다.
ALTER TABLE listeners ADD CONSTRAINT listener_no_sni_reject_flag CHECK (
  on_no_sni_reject IS NOT FALSE);

-- **패스스루에만.** 001 의 네 shape CHECK 은 컬럼이 없던 시절 것이라 이 컬럼을 안 본다.
-- 거기에 손대는 대신(그러면 001 의 정본이 흔들린다) 같은 뜻의 제약을 하나로 건다.
ALTER TABLE listeners ADD CONSTRAINT listener_no_sni_passthrough_only CHECK (
  protocol = 'tls_passthrough'
  OR (on_no_sni_pool IS NULL AND on_no_sni_cls IS NULL AND on_no_sni_reject IS NULL));
