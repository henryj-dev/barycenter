-- 알림 설정을 DB 에 둔다 — 화면에서 고치고, 보낸 기록을 남긴다 (2026-11-20).
--
-- 전에는 `BARY_NOTIFY_*` 환경 변수만 있었다. 바꾸려면 서버에서 파일을 고치고 데몬을 다시 띄워야 했고, 보냈는지는
-- 계측(`bary_notify_total`)으로만 알 수 있었다.
--
-- **설정 DB 에 둔다(계정 DB 가 아니다).** 알림은 지역 데몬의 일이다 — 사건(적용 실패 · 리더 교체 · 인증서 만료)이
-- 지역 것이고, 보내는 것도 그 지역의 리더다. 계정 DB 는 여러 지역이 함께 쓰고 꺼져 있을 수도 있다.
--
-- **비밀은 여기 없다.** 웹훅 서명 비밀과 Slack 웹훅 URL 은 시크릿 저장소(`opaque://`, 035)에 두고 참조만 적는다.
-- 웹훅 URL · 받는 메일 주소는 비밀이 아니다 — `settings` 에 그대로 둔다(화면이 보여 준다).

-- ① 공통 값 — 한 행. **행이 없으면 아직 씨를 안 뿌린 것이다**: 데몬이 처음 뜰 때 환경 변수를 옮겨 넣는다.
--    `version` 은 바뀔 때마다 오른다 — 다른 노드가 이 값만 보고 다시 읽는다.
CREATE TABLE notify_settings (
  only_one    boolean     PRIMARY KEY DEFAULT true CHECK (only_one),
  repeat_s    integer     NOT NULL CHECK (repeat_s BETWEEN 60 AND 2592000),
  cert_days   integer     NOT NULL CHECK (cert_days BETWEEN 1 AND 365),
  interval_s  integer     NOT NULL CHECK (interval_s BETWEEN 5 AND 86400),
  queue       integer     NOT NULL CHECK (queue BETWEEN 1 AND 10000),
  version     bigint      NOT NULL DEFAULT 1,
  -- 첫 값이 어디서 왔나 — `env`(환경 변수를 옮겼다) · `default`(환경 변수가 없었다).
  seeded_from text        NOT NULL CHECK (seeded_from IN ('env', 'default')),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  text        NOT NULL
);

-- ② 통로. `settings` 의 모양은 해독기(`src/notify/settings.ts`)가 진다 — SQL 로 옮기면 두 자리가 갈린다.
CREATE TABLE notify_channels (
  name        text        PRIMARY KEY CHECK (name ~ '^[a-z0-9][a-z0-9_-]{0,62}$'),
  kind        text        NOT NULL CHECK (kind IN ('webhook', 'slack', 'mail')),
  enabled     boolean     NOT NULL,
  settings    jsonb       NOT NULL CHECK (jsonb_typeof(settings) = 'object'),
  secret_ref  text        CHECK (secret_ref IS NULL OR secret_ref ~ '^opaque://[A-Za-z0-9._:-]+@[a-f0-9]{32}$'),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  text        NOT NULL
);

-- ③ 보낸 기록 — **운영 상태다.** 오래된 것은 DB 보존이 지운다(기본 30일, `BARY_NOTIFY_DELIVERY_RETENTION_DAYS`).
--    `channel` 이 NULL 이면 허브에서 걸렀다(`suppressed` · `dropped`). `detail` 에는 비밀을 싣지 않는다 — 쓰는 쪽이
--    비밀 값을 가린다.
CREATE TABLE notify_deliveries (
  id          bigserial   PRIMARY KEY,
  at          timestamptz NOT NULL DEFAULT now(),
  channel     text,
  kind        text        NOT NULL,
  severity    text        NOT NULL CHECK (severity IN ('critical', 'warning', 'info')),
  event_key   text        NOT NULL,
  outcome     text        NOT NULL CHECK (outcome IN
    ('sent', 'suppressed', 'dropped', 'auth', 'rejected', 'rate-limited', 'unavailable', 'insecure')),
  detail      text,
  test        boolean     NOT NULL DEFAULT false,
  node        text        NOT NULL
);
CREATE INDEX notify_deliveries_at_idx ON notify_deliveries(at DESC);
