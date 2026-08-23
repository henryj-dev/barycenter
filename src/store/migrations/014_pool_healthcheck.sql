-- 검수 2026-08-22 · B-07 — **5xx 는 healthy 가 아니다**
--
-- 프로버가 `GET /` 을 치고 본문이 비어 있지 않으면 살았다고 봤다. 그래서 500·502·503 과
-- 함께 온 에러 페이지가 전부 `healthy` 였다 — 죽은 백엔드가 계속 트래픽을 받는다.
-- 그리고 경로·기대본문을 정할 자리가 없었다: `HttpProbeOpts` 는 있는데 `HealthProber` 가
-- 안 넘겼다.
--
-- 판정은 이제 상태 코드가 한다(기본 2xx). 이 컬럼은 그것을 **좁히는** 자리다.
--
-- `jsonb` 로 둔다. 세 필드가 전부 선택이고 서로 독립이라 컬럼 셋으로 펴면 NULL 조합이
-- 여덟 가지가 되는데, 그중 의미 있는 제약은 "http 풀에만" 하나뿐이다. 011 의 `hsts` 와
-- 같은 판단이다.
ALTER TABLE pools ADD COLUMN health_check jsonb;

-- **http 풀에만.** 검증기의 `option_not_supported` 와 같은 규칙을 DB 에도 건다 —
-- stream 프로버는 연결만 보므로 거기 적힌 값은 아무도 안 읽는다.
ALTER TABLE pools ADD CONSTRAINT pool_healthcheck_http_only CHECK (
  health_check IS NULL OR protocol_class = 'http');

-- 모양만 본다. 값의 의미(경로 문법 · 상태 범위)는 해독기와 검증기가 진다.
ALTER TABLE pools ADD CONSTRAINT pool_healthcheck_shape CHECK (
  health_check IS NULL OR jsonb_typeof(health_check) = 'object');

-- ── 검수 B-12 — shared dict 크기 ────────────────────────────────────────
--
-- `lua_shared_dict` 크기가 하드코딩(`1m`·`64k`)이었다. 이건 성능 손잡이가 아니라
-- **절벽**이다: 차면 nginx 가 LRU 로 밀어내고, 밀려난 것이 `slot:` 이면
-- `balancer_by_lua` 가 `ngx.exit(ngx.ERROR)` 를 타 **그 풀의 모든 요청이 끊긴다.**
-- 백엔드가 늘면 언젠가 닿는데 그때 할 수 있는 것이 없었다.
--
-- 범위는 해독기와 같다. 하한이 있는 이유: nginx 는 너무 작은 dict 를 아예 거절하고
-- 그 실패는 apply 시점에 난다.
ALTER TABLE engine_settings
  ADD COLUMN membership_dict_kb integer CHECK (
    membership_dict_kb IS NULL OR membership_dict_kb BETWEEN 64 AND 1048576),
  ADD COLUMN acme_dict_kb integer CHECK (
    acme_dict_kb IS NULL OR acme_dict_kb BETWEEN 32 AND 1048576);
