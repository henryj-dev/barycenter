-- PG 계열의 036_notify_settings.sql 과 같은 자리 — 알림 설정 · 통로 · 보낸 기록. 이유는 그 파일 머리말에 있다.
-- 표마다 `CREATE TABLE IF NOT EXISTS` 이고 색인 · 제약은 표 안에 둔다 — 다시 돌아도 같은 끝 상태다.

CREATE TABLE IF NOT EXISTS notify_settings (
  only_one    boolean      NOT NULL DEFAULT TRUE,
  repeat_s    int          NOT NULL,
  cert_days   int          NOT NULL,
  interval_s  int          NOT NULL,
  queue       int          NOT NULL,
  version     bigint       NOT NULL DEFAULT 1,
  seeded_from longtext     NOT NULL,
  updated_at  datetime(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_by  longtext     NOT NULL,
  CONSTRAINT notify_settings_pkey PRIMARY KEY (only_one),
  CONSTRAINT notify_settings_only_one_check CHECK (only_one = TRUE),
  CONSTRAINT notify_settings_repeat_s_check CHECK (repeat_s BETWEEN 60 AND 2592000),
  CONSTRAINT notify_settings_cert_days_check CHECK (cert_days BETWEEN 1 AND 365),
  CONSTRAINT notify_settings_interval_s_check CHECK (interval_s BETWEEN 5 AND 86400),
  CONSTRAINT notify_settings_queue_check CHECK (queue BETWEEN 1 AND 10000),
  CONSTRAINT notify_settings_seeded_from_check CHECK (seeded_from IN ('env', 'default'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS notify_channels (
  name        varchar(255) NOT NULL,
  kind        longtext     NOT NULL,
  enabled     boolean      NOT NULL,
  settings    json         NOT NULL COMMENT 'bary:json',
  secret_ref  longtext,
  updated_at  datetime(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_by  longtext     NOT NULL,
  CONSTRAINT notify_channels_pkey PRIMARY KEY (name),
  CONSTRAINT notify_channels_name_check CHECK ((name REGEXP '^[a-z0-9][a-z0-9_-]{0,62}$' AND RIGHT(name, 1) REGEXP '[a-z0-9_-]')),
  CONSTRAINT notify_channels_kind_check CHECK (kind IN ('webhook', 'slack', 'mail')),
  CONSTRAINT notify_channels_settings_check CHECK (JSON_TYPE(settings) = 'OBJECT'),
  CONSTRAINT notify_channels_secret_ref_check CHECK (secret_ref IS NULL OR (secret_ref REGEXP '^opaque://[A-Za-z0-9._:-]+@[a-f0-9]{32}$' AND RIGHT(secret_ref, 1) REGEXP '[a-f0-9]'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS notify_deliveries (
  id          bigint       NOT NULL AUTO_INCREMENT,
  at          datetime(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  channel     longtext,
  kind        longtext     NOT NULL,
  severity    longtext     NOT NULL,
  event_key   longtext     NOT NULL,
  outcome     longtext     NOT NULL,
  detail      longtext,
  test        boolean      NOT NULL DEFAULT FALSE,
  node        longtext     NOT NULL,
  CONSTRAINT notify_deliveries_pkey PRIMARY KEY (id),
  KEY notify_deliveries_at_idx (at DESC),
  CONSTRAINT notify_deliveries_severity_check CHECK (severity IN ('critical', 'warning', 'info')),
  CONSTRAINT notify_deliveries_outcome_check CHECK (outcome IN
    ('sent', 'suppressed', 'dropped', 'auth', 'rejected', 'rate-limited', 'unavailable', 'insecure'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
