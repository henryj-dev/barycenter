-- 021_strict_priority.sql
-- S10 — **전역 숫자 priority 를 옵트인으로 연다** (§7.5-4)
--
-- 기본에서 사용자 priority 는 같은 매치 클래스 안에서만 뜻이 있다 — nginx 가 정확일치
-- → 와일드카드 → 정규식 순으로 보기 때문이다(E20.1). 켜면 겨루는 것들을 전부 앵커
-- 정규식으로 내려 등장 순서로 정렬한다(E20.3).
--
-- ⚠️ **S10 은 자기 기준을 못 넘었다** (2026-08-23). §12.0 이 "라우트 500개 p99 영향
-- < 5%" 를 요구했는데 `spike/s10` 실측은 강등 50개 +3.4%, 250개 +9.8% 다. 그래서
-- 검증기가 강등 수에 상한(128)을 건다 — §7.5-4 의 *"라우트 수 상한과 벤치 기준을 함께
-- 정의한다"* 가 그것이다.
--
-- `boolean` 이지 jsonb 가 아니다. 얽힌 필드가 없다 — 켜거나 끄거나다.
ALTER TABLE listeners ADD COLUMN http_strict_priority boolean;

-- **http·https 리스너에만.** stream 에는 server_name 이 없다.
ALTER TABLE listeners ADD CONSTRAINT listener_strict_priority_http_only CHECK (
  http_strict_priority IS NULL OR protocol IN ('http', 'https'));

-- 켜져 있지도 않은 플래그를 false 로 적으면 "안 정함" 과 구분이 안 된다 —
-- `http_default_reject` 와 같은 규칙이다.
ALTER TABLE listeners ADD CONSTRAINT listener_strict_priority_flag CHECK (
  http_strict_priority IS NOT FALSE);
