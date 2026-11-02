-- 032_route_source_rules.sql
-- 라우트 출발지 규칙 (sourceRules, 2026-11-02)
--
-- 요청의 출발지가 규칙의 대역에 들면 라우트 기본 동작 대신 그 규칙의 동작을 한다. 위에서부터 처음 맞는 것이다.
-- 없으면 NULL — 지금처럼 기본 동작 하나다. 순서가 뜻이라 jsonb 배열로 둔다(행으로 펴면 순서 열을 따로 들어야 한다).
-- 규칙이 가리키는 풀은 FK 로 못 건다(jsonb 안이다). 검증기가 커밋 전에 본다 — 기본 동작의 풀과 같은 `needPool` 이다.
ALTER TABLE http_routes ADD COLUMN source_rules jsonb;

-- **배열이고 비어 있지 않다.** 해독기와 같은 규칙이다.
ALTER TABLE http_routes ADD CONSTRAINT http_route_source_rules_array CHECK (
  source_rules IS NULL OR (jsonb_typeof(source_rules) = 'array' AND jsonb_array_length(source_rules) BETWEEN 1 AND 20));
