-- 리스너 호스트 (hosts, ADR-VHOST, 2026-10-31)
--
-- http · https 리스너가 nginx `server_name` 을 가진다. 있으면 「호스트 리스너」 이고, 같은 소켓을 다른 호스트
-- 리스너와 함께 쓴다(호스트가 겹치지 않을 때 — 검증기가 본다). 없으면 그 소켓의 기본 리스너다(지금 동작).
--
-- **`text[]` 다.** 대소문자 · 순서는 해독기와 편집 API 가 맞춘다 — DB 가 다시 정규화하면 적은 것과 읽어 온
-- 것이 달라져 plan 이 매번 바뀐 것으로 본다(025 의 `source_allow` 와 같은 판단).
ALTER TABLE listeners ADD COLUMN hosts text[];

-- **비어 있을 수 없다.** 호스트 없는 리스너는 NULL 이다 — 빈 목록과 「안 정함」 을 둘 다 두면 뜻이 갈린다.
ALTER TABLE listeners ADD CONSTRAINT listener_hosts_nonempty CHECK (
  hosts IS NULL OR cardinality(hosts) > 0);

-- **http 계열에만.** stream 에는 server_name 이 없다 — 포트로만 가른다.
ALTER TABLE listeners ADD CONSTRAINT listener_hosts_http_only CHECK (
  hosts IS NULL OR protocol IN ('http', 'https'));
