-- PG 계열의 036_notify_settings.sql 과 같은 자리 — 알림 설정 · 통로 · 보낸 기록. 이유는 그 파일 머리말에 있다.

CREATE TABLE notify_settings (
  only_one    boolean     NOT NULL DEFAULT 1 CONSTRAINT notify_settings_only_one_check CHECK (only_one),
  repeat_s    int         NOT NULL CHECK (repeat_s BETWEEN 60 AND 2592000),
  cert_days   int         NOT NULL CHECK (cert_days BETWEEN 1 AND 365),
  interval_s  int         NOT NULL CHECK (interval_s BETWEEN 5 AND 86400),
  queue       int         NOT NULL CHECK (queue BETWEEN 1 AND 10000),
  version     bigint      NOT NULL DEFAULT 1,
  seeded_from text        NOT NULL CHECK (seeded_from IN ('env', 'default')),
  updated_at  timestamptz NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by  text        NOT NULL,
  CONSTRAINT notify_settings_pkey PRIMARY KEY (only_one)
);

CREATE TABLE notify_channels (
  name        text        NOT NULL CHECK (length(name) BETWEEN 1 AND 63 AND name GLOB '[a-z0-9]*' AND name NOT GLOB '*[^a-z0-9_-]*'),
  kind        text        NOT NULL CHECK (kind IN ('webhook', 'slack', 'mail')),
  enabled     boolean     NOT NULL,
  settings    json_text   NOT NULL CHECK (json_valid(settings) AND json_type(settings) = 'object'),
  secret_ref  text        CHECK (secret_ref IS NULL OR (secret_ref GLOB 'opaque://?*@*'
    AND substr(secret_ref, 10, instr(secret_ref, '@') - 10) NOT GLOB '*[^A-Za-z0-9._:-]*'
    AND length(substr(secret_ref, instr(secret_ref, '@') + 1)) = 32
    AND substr(secret_ref, instr(secret_ref, '@') + 1) NOT GLOB '*[^a-f0-9]*')),
  updated_at  timestamptz NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by  text        NOT NULL,
  CONSTRAINT notify_channels_pkey PRIMARY KEY (name)
);

CREATE TABLE notify_deliveries (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  at          timestamptz NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  channel     text,
  kind        text        NOT NULL,
  severity    text        NOT NULL CHECK (severity IN ('critical', 'warning', 'info')),
  event_key   text        NOT NULL,
  outcome     text        NOT NULL CHECK (outcome IN
    ('sent', 'suppressed', 'dropped', 'auth', 'rejected', 'rate-limited', 'unavailable', 'insecure')),
  detail      text,
  test        boolean     NOT NULL DEFAULT 0,
  node        text        NOT NULL
);
CREATE INDEX notify_deliveries_at_idx ON notify_deliveries (at DESC);
