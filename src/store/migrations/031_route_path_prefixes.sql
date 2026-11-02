-- 031_route_path_prefixes.sql
-- 라우트 하나에 경로 여럿 (pathPrefixes, 2026-11-02)
--
-- 같은 동작 · 헤더로 `/api/` · `/v2/` · `/graphql` 을 함께 덮는다. 없으면 NULL — 지금처럼 `path_prefix` 하나(또는 `/`)다.
ALTER TABLE http_routes ADD COLUMN path_prefixes text[];

-- **하나와 여럿을 함께 두지 않는다.** 해독기와 같은 규칙이다 — 어느 쪽이 맞는지 고를 근거가 없다.
ALTER TABLE http_routes ADD CONSTRAINT http_route_path_one_or_many CHECK (
  path_prefixes IS NULL OR path_prefix IS NULL);

-- **빈 목록은 실수다.** `/` 하나를 뜻하려면 NULL 로 둔다.
ALTER TABLE http_routes ADD CONSTRAINT http_route_path_prefixes_nonempty CHECK (
  path_prefixes IS NULL OR cardinality(path_prefixes) > 0);
