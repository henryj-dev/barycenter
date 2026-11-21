-- tcp 풀도 헬스체크를 적는다 (2026-11-21).
--
-- 014 는 "http 풀에만" 을 DB 에도 걸었다. 그 이유는 "stream 프로버는 연결만 본다" 였다. 그러나
-- 프로버는 풀 종류와 상관없이 헬스체크 계획(`probePlanOf`)을 따른다 — tcp 풀에서도 방식 · 포트 ·
-- 찌를 주소 · 주기 · rise · fall 이 다 쓰인다. 해독기도 tcp 풀의 헬스체크를 받는다(§4.3.1: TCP 서비스의
-- HTTP 헬스 포트). 의미 검증기와 이 CHECK 만 막아서, GUI 가 tcp 풀에 보이는 편집기로 저장하면
-- 거절되었다.
--
-- 이제 udp 풀만 막는다. udp 프로브는 없다(§13-6).
--
-- **이름은 그대로 둔다** (`pool_healthcheck_http_only`). 034 와 같은 이유다 — MySQL 계열에서 지우기와
-- 달기를 같은 이름으로 한 `ALTER` 에 묶어야, 중간에 멈춘 뒤 다시 돌아도 `DROP` 이 그것을 찾는다.
-- 세 방언이 같은 이름을 쓴다. 이름이 옛 뜻을 말하지만 조건은 이 파일이 정한다.
ALTER TABLE pools
  DROP CONSTRAINT pool_healthcheck_http_only,
  ADD CONSTRAINT pool_healthcheck_http_only CHECK (
    health_check IS NULL OR protocol_class <> 'udp');
