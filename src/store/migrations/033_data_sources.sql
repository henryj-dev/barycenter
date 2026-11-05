-- 데이터 공급 — 풀의 백엔드 출처 · 주소 집합 출처 (2026-11-05)
--
-- ① 풀의 `discovery` — `{source, query, port?, emptyMeans?}`. 014 의 `health_check`, 022 의 `upstream_tls` 와
--    같은 판단으로 `jsonb` 다. 모양은 해독기가 진다 — SQL 로 옮기면 두 자리가 갈린다.
ALTER TABLE pools ADD COLUMN discovery jsonb;
ALTER TABLE pools ADD CONSTRAINT pool_discovery_shape CHECK (
  discovery IS NULL OR jsonb_typeof(discovery) = 'object');

-- ② 주소 집합의 `source` 가 열거(`cloudflare`)에서 **출처 레지스트리의 이름**이 된다. 이름 목록을 여기 다시
--    적으면 출처 하나를 더할 때마다 마이그레이션이 따라야 한다 — 목록은 해독기가 지고, 여기서는 이름의 모양만 본다.
--    옛 값 `cloudflare` 는 이 모양에 맞으므로 **이미 있는 행은 그대로다.**
ALTER TABLE address_sets DROP CONSTRAINT address_set_source;
ALTER TABLE address_sets ADD CONSTRAINT address_set_source CHECK (
  source IS NULL OR source ~ '^[a-z][a-z0-9-]{0,31}$');
ALTER TABLE address_sets ADD COLUMN source_options jsonb;
ALTER TABLE address_sets ADD CONSTRAINT address_set_source_options CHECK (
  source_options IS NULL OR (source IS NOT NULL AND jsonb_typeof(source_options) = 'object'));

-- ③ 다시 받은 기록 — **설정이 아니라 운영 상태다.** 리비전에 넣으면 받을 때마다(바뀌지 않았어도) 리비전이
--    생긴다. 키는 집합 이름이고 FK 가 아니다: 롤백은 `address_sets` 를 지우고 다시 넣는다(이 기록이 같이 지워지면
--    「마지막 갱신」 이 롤백마다 사라진다). 집합이 없어진 행은 읽는 쪽이 거른다.
CREATE TABLE address_set_refresh (
  key          text        PRIMARY KEY,
  -- 마지막으로 물은 때 (성공 · 실패 모두)
  checked_at   timestamptz NOT NULL,
  ok           boolean     NOT NULL,
  -- 실패의 뜻 (`unavailable` · `invalid` · `empty` · `commit`) 과 사람이 읽는 사유. 성공이면 NULL.
  reason       text,
  detail       text,
  -- 마지막으로 성공한 때 — 화면의 「마지막 갱신」
  refreshed_at timestamptz,
  -- 마지막으로 목록이 **바뀌어** 커밋한 리비전
  revision     bigint,
  by_actor     text        NOT NULL
);
