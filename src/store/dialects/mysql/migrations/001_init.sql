-- MySQL · MariaDB 계열 001 — 설정 DB 의 최종 스키마 (docs/adr-multi-db.md 「3단계 — MySQL/MariaDB」)
--
-- **PG 계열 001~033 을 모두 적용한 뒤의 모양을 한 파일에 둔다**(SQLite 계열과 같은 결정). 배포된 MySQL DB 가 없던
-- 때에 시작했다. 002~033 은 이름만 맞추는 주석 파일이다. 034 부터는 PG 와 같이 한 파일이 한 단계다.
--
-- ── 다시 돌려도 안전하다 ────────────────────────────────────────────────
--
-- **MySQL 의 DDL 은 트랜잭션이 아니다**(문장마다 암묵 커밋). 이 파일이 중간에 깨지면 앞 문장들은 남고 기록은
-- 없다 — 다음 기동이 이 파일을 처음부터 다시 돈다. 그래서 모든 문장이 두 번 돌아도 같은 끝 상태다:
-- `CREATE TABLE IF NOT EXISTS`(색인 · 제약은 표 안에 — 표 하나가 원자적으로 생긴다) · `CREATE TRIGGER IF NOT EXISTS` ·
-- 씨앗 행은 `ON DUPLICATE KEY UPDATE`. 실행기(`src/store/mysql.ts`)는 `;` 로 문장을 가른다 — 트리거 몸은 `BEGIN … END`.
--
-- ── 형 ──────────────────────────────────────────────────────────────────
--
-- 모든 표는 `utf8mb4` · `utf8mb4_bin`(바이트 비교 — PG `text` 처럼 대소문자를 가른다) · InnoDB.
-- 모양 읽기(`src/store/schema-shape.ts` 의 `mysqlLogicalType`)가 아래 대응으로 논리 형을 읽는다.
--
--   PG                  MySQL                                  비고
--   text (키 · 색인)    varchar(255) (URL 은 varchar(768))     색인에는 길이가 있어야 한다. 키 문법 CHECK 가 더 좁다
--   text (그 밖)        longtext
--   uuid                char(36)                               char(36) 은 uuid 에만 쓴다. 생성 열의 바탕이면 varchar(36) COMMENT 'bary:uuid'
--                                                          (MariaDB 는 CHAR 를 읽는 식을 생성 열에 못 쓴다 — 1901)
--   integer             int
--   bigint              bigint
--   bigserial           bigint AUTO_INCREMENT
--   boolean             boolean (tinyint(1))
--   timestamptz         datetime(6), UTC                       세션 time_zone '+00:00' 이 CURRENT_TIMESTAMP(6) 를 UTC 로 만든다
--   jsonb               json COMMENT 'bary:json'               MariaDB 는 longtext + json_valid — 주석이 논리 형을 말한다
--   text[]              json COMMENT 'bary:array'              + CHECK (JSON_TYPE(…) = 'ARRAY')
--   enum                ENUM(…)                                라벨의 선언 순서가 PG enum 의 순서와 같다
--   bytea               longblob
--
-- ── PG 와 다른 표기 ──────────────────────────────────────────────────────
--
-- - 정규식 CHECK(`~`) → `REGEXP`. 패턴은 PG 그대로다. MySQL(ICU) · MariaDB(PCRE)의 `$` 는 **끝의 줄바꿈 앞에서도** 맞으므로
--   「마지막 글자도 허용 집합 안」(`RIGHT(x, 1) REGEXP '[…]'`)을 함께 건다. `\z` 는 쓰지 않는다 — CHECK 의 식은 저장될 때
--   역슬래시가 다시 이스케이프되어 `sql_mode` 에 따라 뜻이 바뀐다(MySQL 8.4 에서 잼).
-- - 제약 이름은 PG 와 같다 — 오류의 `constraint` 가 방언마다 같다(드라이버가 PG SQLSTATE 와 함께 옮긴다).
-- - **부분 유일 색인**(`… WHERE state IN (…)`) → 생성 열 + 유일 색인(`acme_orders.live_certificate_id`). NULL 은 유일 검사에서
--   빠진다. 부분 색인이 성능용일 뿐이면(`… WHERE revoked_at IS NULL`) 그냥 색인이다.
-- - **FK 의 연쇄 삭제는 트리거를 깨우지 않는다**(InnoDB). PG 013 의 「백엔드가 지워지면 운영 상태도 지운다」 트리거는
--   풀 삭제(백엔드 연쇄 삭제)에서도 돌아야 하므로 `pools` 의 BEFORE DELETE 트리거가 같은 일을 한다.
-- - MySQL 은 **CHECK 가 보는 열에 연쇄 동작(CASCADE) FK 를 못 건다**(3823). `sni_certificate_bindings.listener_proto` 가 그렇다 —
--   FK 는 연쇄 없이 두고 `listeners` 의 BEFORE DELETE 트리거가 연쇄를 한다. 생성 열의 바탕 열도 연쇄 FK 를 못 가진다 —
--   `acme_orders.certificate_id` 도 같은 방식(`certificates` 의 트리거)이다.
-- - 시퀀스 → `bary_sequences`(`last_value` 는 마지막으로 낸 값). nextval 은
--   `UPDATE … SET last_value = LAST_INSERT_ID(last_value + 1)` 뒤 `SELECT LAST_INSERT_ID()` — 같은 연결 · 같은 트랜잭션.
--   `last_value` 는 MySQL 8 의 예약어라 늘 따옴표를 친다.

CREATE TABLE IF NOT EXISTS bary_sequences (
  name          varchar(64) NOT NULL,
  `last_value`  bigint      NOT NULL,
  CONSTRAINT bary_sequences_pkey PRIMARY KEY (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
INSERT INTO bary_sequences (name, `last_value`) VALUES
  ('config_revision_seq', 1),
  ('activation_epoch_seq', 0),
  ('leader_token_seq', 0)
  ON DUPLICATE KEY UPDATE name = name;

-- ── 전역 좌표 ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS config_head (
  only_one  boolean NOT NULL DEFAULT TRUE,
  revision  bigint  NOT NULL,
  CONSTRAINT config_head_pkey PRIMARY KEY (only_one),
  CONSTRAINT config_head_only_one_check CHECK (only_one = TRUE)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS config_revisions (
  revision     bigint      NOT NULL,
  parent       bigint,
  rollback_of  bigint,
  model        json        NOT NULL COMMENT 'bary:json',
  created_at   datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  created_by   longtext    NOT NULL,
  note         longtext,
  CONSTRAINT config_revisions_pkey PRIMARY KEY (revision),
  CONSTRAINT config_revisions_parent_fkey FOREIGN KEY (parent) REFERENCES config_revisions (revision),
  CONSTRAINT config_revisions_rollback_of_fkey FOREIGN KEY (rollback_of) REFERENCES config_revisions (revision),
  CONSTRAINT config_revisions_check CHECK (rollback_of IS NULL OR rollback_of < revision),
  CONSTRAINT revision_not_self_rollback CHECK (rollback_of IS NULL OR rollback_of <> revision)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS changesets (
  id                  char(36)    NOT NULL,
  base_revision       bigint      NOT NULL,
  state               ENUM('open', 'sealed', 'committed', 'discarded') NOT NULL DEFAULT 'open',
  patch               json        NOT NULL DEFAULT ('[]') COMMENT 'bary:json',
  created_at          datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  created_by          longtext    NOT NULL,
  sealed_at           datetime(6),
  committed_revision  bigint,
  CONSTRAINT changesets_pkey PRIMARY KEY (id),
  CONSTRAINT changesets_base_revision_fkey FOREIGN KEY (base_revision) REFERENCES config_revisions (revision),
  CONSTRAINT changesets_committed_revision_fkey FOREIGN KEY (committed_revision) REFERENCES config_revisions (revision),
  CONSTRAINT changeset_committed CHECK ((state = 'committed') = (committed_revision IS NOT NULL)),
  CONSTRAINT changeset_sealed_at CHECK ((state = 'open') = (sealed_at IS NULL) OR state IN ('committed', 'discarded'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS plans (
  id                char(36)    NOT NULL,
  changeset_id      char(36),
  state             ENUM('planned', 'committed', 'operation_bound', 'applied', 'expired', 'superseded', 'failed') NOT NULL DEFAULT 'planned',
  base_revision     bigint      NOT NULL,
  model             json        NOT NULL COMMENT 'bary:json',
  impact            json        NOT NULL COMMENT 'bary:json',
  render_digest     longtext    NOT NULL,
  renderer_version  longtext    NOT NULL,
  created_at        datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  expires_at        datetime(6) NOT NULL,
  target_revision   bigint,
  activation_epoch  bigint,
  CONSTRAINT plans_pkey PRIMARY KEY (id),
  KEY plans_changeset_idx (changeset_id),
  CONSTRAINT plans_changeset_id_fkey FOREIGN KEY (changeset_id) REFERENCES changesets (id) ON DELETE CASCADE,
  CONSTRAINT plans_target_revision_fkey FOREIGN KEY (target_revision) REFERENCES config_revisions (revision),
  CONSTRAINT plan_reserved_together CHECK ((target_revision IS NULL) = (activation_epoch IS NULL)),
  CONSTRAINT plan_reserved_when_committed CHECK (state = 'planned' OR state = 'expired' OR target_revision IS NOT NULL)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS operations (
  id                char(36)    NOT NULL,
  plan_id           char(36)    NOT NULL,
  revision          bigint      NOT NULL,
  activation_epoch  bigint      NOT NULL,
  generation        longtext    NOT NULL,
  phase             longtext    NOT NULL,
  detail            json        COMMENT 'bary:json',
  created_at        datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at        datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  created_by        longtext    NOT NULL,
  envelope          json        COMMENT 'bary:json',
  CONSTRAINT operations_pkey PRIMARY KEY (id),
  CONSTRAINT operations_plan_id_key UNIQUE (plan_id),
  CONSTRAINT operations_plan_id_fkey FOREIGN KEY (plan_id) REFERENCES plans (id),
  CONSTRAINT operations_revision_fkey FOREIGN KEY (revision) REFERENCES config_revisions (revision)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS audit (
  id         bigint      NOT NULL AUTO_INCREMENT,
  at         datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  principal  longtext    NOT NULL,
  action     longtext    NOT NULL,
  subject    longtext    NOT NULL,
  `before`   json        COMMENT 'bary:json',
  after      json        COMMENT 'bary:json',
  revision   bigint,
  CONSTRAINT audit_pkey PRIMARY KEY (id),
  KEY audit_at_idx (at DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

-- ── 리더 선출 ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS leadership (
  token        bigint       NOT NULL,
  holder       longtext     NOT NULL,
  acquired_at  datetime(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  released_at  datetime(6),
  CONSTRAINT leadership_pkey PRIMARY KEY (token),
  KEY leadership_acquired_idx (acquired_at DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS cluster_nodes (
  name               varchar(255) NOT NULL,
  url                longtext,
  role               longtext     NOT NULL,
  active_epoch       bigint,
  active_generation  longtext,
  state              longtext     NOT NULL,
  last_error         longtext,
  last_seen          datetime(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at         datetime(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  CONSTRAINT cluster_nodes_pkey PRIMARY KEY (name),
  CONSTRAINT cluster_node_role CHECK (role IN ('leader', 'follower')),
  CONSTRAINT cluster_node_state CHECK (state IN ('in_sync', 'following', 'failed', 'standalone'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

-- ── 풀과 백엔드 ──────────────────────────────────────────────────────────
--
-- `(id, protocol_class)` UNIQUE 는 복합 FK 의 과녁이다(PG 001 머리말).
CREATE TABLE IF NOT EXISTS pools (
  id                   char(36)     NOT NULL,
  `key`                varchar(255) NOT NULL,
  name                 longtext     NOT NULL,
  protocol_class       ENUM('http', 'tcp', 'udp') NOT NULL,
  algorithm            ENUM('round_robin', 'source_ip_hash', 'hash', 'least_conn') NOT NULL,
  hash_key             longtext,
  send_proxy_protocol  longtext,
  version              int          NOT NULL DEFAULT 1,
  created_at           datetime(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at           datetime(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  created_by           longtext     NOT NULL,
  updated_by           longtext     NOT NULL,
  revision             bigint       NOT NULL,
  health_check         json         COMMENT 'bary:json',
  upstream_tls         json         COMMENT 'bary:json',
  discovery            json         COMMENT 'bary:json',
  CONSTRAINT pools_pkey PRIMARY KEY (id),
  CONSTRAINT pools_key_key UNIQUE (`key`),
  CONSTRAINT pool_id_class_uq UNIQUE (id, protocol_class),
  CONSTRAINT pool_discovery_shape CHECK (discovery IS NULL OR JSON_TYPE(discovery) = 'OBJECT'),
  CONSTRAINT pool_hash_key_iff CHECK ((algorithm = 'hash') = (hash_key IS NOT NULL)),
  CONSTRAINT pool_healthcheck_http_only CHECK (health_check IS NULL OR protocol_class = 'http'),
  CONSTRAINT pool_healthcheck_shape CHECK (health_check IS NULL OR JSON_TYPE(health_check) = 'OBJECT'),
  CONSTRAINT pool_send_pp_tcp_only CHECK (
    send_proxy_protocol IS NULL OR (send_proxy_protocol = 'v1' AND protocol_class = 'tcp')),
  CONSTRAINT pool_upstream_tls_not_udp CHECK (upstream_tls IS NULL OR protocol_class <> 'udp'),
  CONSTRAINT pool_upstream_tls_shape CHECK (upstream_tls IS NULL OR JSON_TYPE(upstream_tls) = 'OBJECT'),
  CONSTRAINT pools_key_syntax CHECK ((`key` REGEXP '^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$' AND RIGHT(`key`, 1) REGEXP '[A-Za-z0-9._-]'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS backends (
  id          char(36)     NOT NULL,
  `key`       varchar(255) NOT NULL,
  pool_id     char(36)     NOT NULL,
  host        longtext     NOT NULL,
  port        int          NOT NULL,
  weight      int          NOT NULL,
  enabled     boolean      NOT NULL DEFAULT TRUE,
  version     int          NOT NULL DEFAULT 1,
  created_at  datetime(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at  datetime(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  created_by  longtext     NOT NULL,
  updated_by  longtext     NOT NULL,
  revision    bigint       NOT NULL,
  CONSTRAINT backends_pkey PRIMARY KEY (id),
  CONSTRAINT backends_key_key UNIQUE (`key`),
  KEY backends_pool_idx (pool_id),
  CONSTRAINT backends_pool_id_fkey FOREIGN KEY (pool_id) REFERENCES pools (id) ON DELETE CASCADE,
  CONSTRAINT backends_host_check CHECK (host <> ''),
  CONSTRAINT backends_key_syntax CHECK ((`key` REGEXP '^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$' AND RIGHT(`key`, 1) REGEXP '[A-Za-z0-9._-]')),
  CONSTRAINT backends_port_check CHECK (port >= 1 AND port <= 65535),
  CONSTRAINT backends_weight_check CHECK (weight >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

-- ── 운영 상태 (백엔드 key 로 잇는다) ──────────────────────────────────────

CREATE TABLE IF NOT EXISTS backend_drain (
  backend_key  varchar(255) NOT NULL,
  started_at   datetime(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  deadline_at  datetime(6),
  started_by   longtext     NOT NULL,
  CONSTRAINT backend_drain_pkey PRIMARY KEY (backend_key),
  KEY backend_drain_deadline_idx (deadline_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS backend_health (
  backend_key      varchar(255) NOT NULL,
  state            ENUM('healthy', 'unhealthy', 'unknown') NOT NULL DEFAULT 'unknown',
  probe_start_seq  bigint       NOT NULL DEFAULT 0,
  last_ok          boolean      NOT NULL DEFAULT TRUE,
  consecutive      int          NOT NULL DEFAULT 0,
  observed_at      datetime(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  detail           longtext,
  CONSTRAINT backend_health_pkey PRIMARY KEY (backend_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

-- 한 행짜리 표 — 다음 health_events.seq.
CREATE TABLE IF NOT EXISTS health_cursor (
  only_one  boolean NOT NULL DEFAULT TRUE,
  next_seq  bigint  NOT NULL DEFAULT 1,
  CONSTRAINT health_cursor_pkey PRIMARY KEY (only_one),
  CONSTRAINT health_cursor_only_one_check CHECK (only_one = TRUE)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
INSERT INTO health_cursor () VALUES () ON DUPLICATE KEY UPDATE only_one = only_one;

CREATE TABLE IF NOT EXISTS health_events (
  seq          bigint       NOT NULL,
  backend_key  varchar(255) NOT NULL,
  state        ENUM('healthy', 'unhealthy', 'unknown') NOT NULL,
  at           datetime(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  detail       longtext,
  CONSTRAINT health_events_pkey PRIMARY KEY (seq),
  KEY health_events_at_idx (at),
  KEY health_events_backend_idx (backend_key, seq DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

-- 운영 상태가 백엔드보다 오래 살면 안 된다 — FK 가 아니라 지우는 쪽의 트리거다(PG 013 의 근거 그대로).
CREATE TRIGGER IF NOT EXISTS backend_state_cleanup
  AFTER DELETE ON backends
  FOR EACH ROW
BEGIN
  DELETE FROM backend_drain  WHERE backend_key = OLD.`key`;
  DELETE FROM backend_health WHERE backend_key = OLD.`key`;
END;

-- InnoDB 는 FK 의 연쇄 삭제에서 트리거를 깨우지 않는다 — 풀을 지우면 백엔드가 연쇄로 지워지므로 그 전에 치운다.
CREATE TRIGGER IF NOT EXISTS pool_backend_state_cleanup
  BEFORE DELETE ON pools
  FOR EACH ROW
BEGIN
  DELETE FROM backend_drain  WHERE backend_key IN (SELECT b.`key` FROM backends b WHERE b.pool_id = OLD.id);
  DELETE FROM backend_health WHERE backend_key IN (SELECT b.`key` FROM backends b WHERE b.pool_id = OLD.id);
END;

CREATE TABLE IF NOT EXISTS engine_settings (
  only_one                   boolean     NOT NULL DEFAULT TRUE,
  worker_shutdown_timeout_s  int,
  updated_at                 datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_by                 longtext    NOT NULL,
  revision                   bigint      NOT NULL,
  membership_dict_kb         int,
  acme_dict_kb               int,
  CONSTRAINT engine_settings_pkey PRIMARY KEY (only_one),
  CONSTRAINT engine_settings_only_one_check CHECK (only_one = TRUE),
  CONSTRAINT engine_settings_acme_dict_kb_check CHECK (
    acme_dict_kb IS NULL OR (acme_dict_kb >= 32 AND acme_dict_kb <= 1048576)),
  CONSTRAINT engine_settings_membership_dict_kb_check CHECK (
    membership_dict_kb IS NULL OR (membership_dict_kb >= 64 AND membership_dict_kb <= 1048576)),
  CONSTRAINT engine_settings_worker_shutdown_timeout_s_check CHECK (
    worker_shutdown_timeout_s IS NULL OR (worker_shutdown_timeout_s >= 1 AND worker_shutdown_timeout_s <= 86400))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

-- ── TLS ──────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS tls_policies (
  id                 char(36)     NOT NULL,
  `key`              varchar(255) NOT NULL,
  name               longtext     NOT NULL,
  min_version        ENUM('1.2', '1.3') NOT NULL,
  max_version        ENUM('1.2', '1.3'),
  version            int          NOT NULL DEFAULT 1,
  created_at         datetime(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at         datetime(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  created_by         longtext     NOT NULL,
  updated_by         longtext     NOT NULL,
  revision           bigint       NOT NULL,
  sni_host_mismatch  longtext,
  cipher_policy      longtext,
  hsts               json         COMMENT 'bary:json',
  CONSTRAINT tls_policies_pkey PRIMARY KEY (id),
  CONSTRAINT tls_policies_key_key UNIQUE (`key`),
  CONSTRAINT tls_policies_key_syntax CHECK ((`key` REGEXP '^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$' AND RIGHT(`key`, 1) REGEXP '[A-Za-z0-9._-]')),
  CONSTRAINT tls_policy_cipher_known CHECK (
    cipher_policy IS NULL OR cipher_policy IN ('modern-2026', 'intermediate-2026')),
  -- jsonb 의 'number' 는 JSON_TYPE 의 'INTEGER' · 'DOUBLE' · 'DECIMAL' · 'UNSIGNED INTEGER' 다.
  CONSTRAINT tls_policy_hsts_shape CHECK (
    hsts IS NULL OR (JSON_TYPE(hsts) = 'OBJECT'
      AND JSON_TYPE(JSON_EXTRACT(hsts, '$.maxAgeSeconds')) IN ('INTEGER', 'DOUBLE', 'DECIMAL', 'UNSIGNED INTEGER'))),
  CONSTRAINT tls_policy_range CHECK (max_version IS NULL OR max_version >= min_version),
  CONSTRAINT tls_policy_sni_mismatch_known CHECK (
    sni_host_mismatch IS NULL OR sni_host_mismatch IN ('allow', 'reject_421'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS certificates (
  id            char(36)     NOT NULL,
  `key`         varchar(255) NOT NULL,
  name          longtext     NOT NULL,
  material_ref  longtext,
  chain_digest  longtext,
  key_digest    longtext,
  version       int          NOT NULL DEFAULT 1,
  created_at    datetime(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at    datetime(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  created_by    longtext     NOT NULL,
  updated_by    longtext     NOT NULL,
  revision      bigint       NOT NULL,
  acme_account  longtext,
  acme_domains  json         COMMENT 'bary:array',
  CONSTRAINT certificates_pkey PRIMARY KEY (id),
  CONSTRAINT certificates_key_key UNIQUE (`key`),
  CONSTRAINT certificates_acme_domains_array CHECK (acme_domains IS NULL OR JSON_TYPE(acme_domains) = 'ARRAY'),
  CONSTRAINT certificate_acme_together CHECK (
    (acme_account IS NULL AND acme_domains IS NULL)
    OR (acme_account IS NOT NULL AND acme_domains IS NOT NULL AND JSON_LENGTH(acme_domains) > 0)),
  CONSTRAINT certificate_material_together CHECK (
    (material_ref IS NULL AND chain_digest IS NULL AND key_digest IS NULL)
    OR (material_ref IS NOT NULL AND chain_digest IS NOT NULL AND key_digest IS NOT NULL)),
  CONSTRAINT certificate_useful CHECK (material_ref IS NOT NULL OR acme_account IS NOT NULL),
  CONSTRAINT certificates_chain_digest_check CHECK (chain_digest IS NULL OR (chain_digest REGEXP '^sha256:[a-f0-9]{64}$' AND RIGHT(chain_digest, 1) REGEXP '[a-f0-9]')),
  CONSTRAINT certificates_key_digest_check CHECK (key_digest IS NULL OR (key_digest REGEXP '^sha256:[a-f0-9]{64}$' AND RIGHT(key_digest, 1) REGEXP '[a-f0-9]')),
  CONSTRAINT certificates_key_syntax CHECK ((`key` REGEXP '^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$' AND RIGHT(`key`, 1) REGEXP '[A-Za-z0-9._-]')),
  CONSTRAINT certificates_material_ref_check CHECK (
    material_ref IS NULL OR (material_ref REGEXP '^store://[A-Za-z0-9._-]+@[a-f0-9]{16,64}$' AND RIGHT(material_ref, 1) REGEXP '[a-f0-9]'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

-- ── 리스너 ───────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS listeners (
  id                       char(36)     NOT NULL,
  `key`                    varchar(255) NOT NULL,
  name                     longtext     NOT NULL,
  protocol                 ENUM('http', 'tls_passthrough', 'tcp', 'udp', 'https') NOT NULL,
  bind                     longtext     NOT NULL,
  port                     int          NOT NULL,
  enabled                  boolean      NOT NULL DEFAULT TRUE,
  udp_preset               ENUM('dns', 'wireguard', 'game_generic', 'custom'),
  http_default_pool_id     char(36),
  http_default_pool_cls    ENUM('http', 'tcp', 'udp'),
  http_default_reject      boolean,
  on_unmatched_sni_pool    char(36),
  on_unmatched_sni_cls     ENUM('http', 'tcp', 'udp'),
  on_unmatched_sni_reject  boolean,
  preread_timeout_s        int,
  default_pool_id          char(36),
  default_pool_cls         ENUM('http', 'tcp', 'udp'),
  version                  int          NOT NULL DEFAULT 1,
  created_at               datetime(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at               datetime(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  created_by               longtext     NOT NULL,
  updated_by               longtext     NOT NULL,
  revision                 bigint       NOT NULL,
  accept_proxy_cidrs       json         COMMENT 'bary:array',
  tls_policy_id            char(36),
  tls_default_cert_id      char(36),
  http2                    boolean,
  proxy_limits             json         COMMENT 'bary:json',
  header_rules             json         COMMENT 'bary:json',
  rate_limit               json         COMMENT 'bary:json',
  on_no_sni_pool           char(36),
  on_no_sni_cls            ENUM('http', 'tcp', 'udp'),
  on_no_sni_reject         boolean,
  http_strict_priority     boolean,
  real_ip_header           longtext,
  real_ip_header_cidrs     json         COMMENT 'bary:array',
  source_allow             json         COMMENT 'bary:array',
  hosts                    json         COMMENT 'bary:array',
  http_redirect_port       int,
  CONSTRAINT listeners_pkey PRIMARY KEY (id),
  CONSTRAINT listeners_key_key UNIQUE (`key`),
  CONSTRAINT listener_id_protocol_uq UNIQUE (id, protocol),
  CONSTRAINT listeners_tls_policy_id_fkey FOREIGN KEY (tls_policy_id) REFERENCES tls_policies (id) ON DELETE RESTRICT,
  CONSTRAINT listeners_tls_default_cert_id_fkey FOREIGN KEY (tls_default_cert_id) REFERENCES certificates (id) ON DELETE RESTRICT,
  CONSTRAINT listener_default_pool_fk FOREIGN KEY (default_pool_id, default_pool_cls)
    REFERENCES pools (id, protocol_class) ON DELETE RESTRICT,
  CONSTRAINT listener_http_pool_fk FOREIGN KEY (http_default_pool_id, http_default_pool_cls)
    REFERENCES pools (id, protocol_class) ON DELETE RESTRICT,
  CONSTRAINT listener_no_sni_pool_fk FOREIGN KEY (on_no_sni_pool, on_no_sni_cls)
    REFERENCES pools (id, protocol_class),
  CONSTRAINT listener_sni_pool_fk FOREIGN KEY (on_unmatched_sni_pool, on_unmatched_sni_cls)
    REFERENCES pools (id, protocol_class) ON DELETE RESTRICT,
  CONSTRAINT listeners_array_shapes CHECK (
    (accept_proxy_cidrs IS NULL OR JSON_TYPE(accept_proxy_cidrs) = 'ARRAY')
    AND (real_ip_header_cidrs IS NULL OR JSON_TYPE(real_ip_header_cidrs) = 'ARRAY')
    AND (source_allow IS NULL OR JSON_TYPE(source_allow) = 'ARRAY')
    AND (hosts IS NULL OR JSON_TYPE(hosts) = 'ARRAY')),
  CONSTRAINT listener_default_pool_class CHECK (
    default_pool_cls IS NULL
    OR (protocol = 'udp' AND default_pool_cls = 'udp')
    OR (protocol = 'tcp' AND default_pool_cls = 'tcp')),
  CONSTRAINT listener_header_rules_http_only CHECK (header_rules IS NULL OR protocol IN ('http', 'https')),
  CONSTRAINT listener_header_rules_shape CHECK (header_rules IS NULL OR JSON_TYPE(header_rules) = 'OBJECT'),
  CONSTRAINT listener_hosts_http_only CHECK (hosts IS NULL OR protocol IN ('http', 'https')),
  CONSTRAINT listener_hosts_nonempty CHECK (hosts IS NULL OR JSON_LENGTH(hosts) > 0),
  CONSTRAINT listener_http2_only_https CHECK (http2 IS NULL OR protocol = 'https'),
  CONSTRAINT listener_http_action_xor CHECK (
    (http_default_reject IS TRUE) + (http_default_pool_id IS NOT NULL) <= 1),
  CONSTRAINT listener_http_pool_class CHECK (http_default_pool_cls IS NULL OR http_default_pool_cls = 'http'),
  CONSTRAINT listener_http_redirect_https_only CHECK (http_redirect_port IS NULL OR protocol = 'https'),
  CONSTRAINT listener_http_redirect_port_range CHECK (
    http_redirect_port IS NULL OR (http_redirect_port >= 1 AND http_redirect_port <= 65535)),
  CONSTRAINT listener_http_shape CHECK (
    protocol <> 'http'
    OR (udp_preset IS NULL AND default_pool_id IS NULL AND on_unmatched_sni_pool IS NULL
        AND on_unmatched_sni_reject IS NULL AND preread_timeout_s IS NULL)),
  CONSTRAINT listener_https_shape CHECK (
    protocol <> 'https'
    OR (udp_preset IS NULL AND default_pool_id IS NULL AND on_unmatched_sni_pool IS NULL
        AND on_unmatched_sni_reject IS NULL AND preread_timeout_s IS NULL
        AND tls_policy_id IS NOT NULL AND tls_default_cert_id IS NOT NULL)),
  CONSTRAINT listener_no_sni_action_xor CHECK (
    (on_no_sni_reject IS TRUE) + (on_no_sni_pool IS NOT NULL) <= 1),
  CONSTRAINT listener_no_sni_passthrough_only CHECK (
    protocol = 'tls_passthrough' OR (on_no_sni_pool IS NULL AND on_no_sni_cls IS NULL AND on_no_sni_reject IS NULL)),
  CONSTRAINT listener_no_sni_pool_class CHECK (on_no_sni_cls IS NULL OR on_no_sni_cls = 'tcp'),
  CONSTRAINT listener_no_sni_reject_flag CHECK (on_no_sni_reject IS NOT FALSE),
  CONSTRAINT listener_passthrough_shape CHECK (
    protocol <> 'tls_passthrough'
    OR (udp_preset IS NULL AND default_pool_id IS NULL AND http_default_pool_id IS NULL AND http_default_reject IS NULL)),
  CONSTRAINT listener_proxy_cidrs_nonempty CHECK (accept_proxy_cidrs IS NULL OR JSON_LENGTH(accept_proxy_cidrs) > 0),
  CONSTRAINT listener_proxy_limits_http_only CHECK (proxy_limits IS NULL OR protocol IN ('http', 'https')),
  CONSTRAINT listener_proxy_limits_shape CHECK (proxy_limits IS NULL OR JSON_TYPE(proxy_limits) = 'OBJECT'),
  CONSTRAINT listener_rate_limit_http_only CHECK (rate_limit IS NULL OR protocol IN ('http', 'https')),
  CONSTRAINT listener_rate_limit_shape CHECK (rate_limit IS NULL OR JSON_TYPE(rate_limit) = 'OBJECT'),
  CONSTRAINT listener_real_ip_header_http_only CHECK (real_ip_header IS NULL OR protocol IN ('http', 'https')),
  CONSTRAINT listener_real_ip_header_name CHECK (
    real_ip_header IS NULL OR real_ip_header IN ('CF-Connecting-IP', 'X-Forwarded-For', 'X-Real-IP')),
  CONSTRAINT listener_real_ip_header_pair CHECK (
    (real_ip_header IS NULL AND real_ip_header_cidrs IS NULL)
    OR (real_ip_header IS NOT NULL AND real_ip_header_cidrs IS NOT NULL AND JSON_LENGTH(real_ip_header_cidrs) > 0)),
  CONSTRAINT listener_real_ip_single_source CHECK (real_ip_header IS NULL OR accept_proxy_cidrs IS NULL),
  CONSTRAINT listener_reject_flags CHECK (http_default_reject IS NOT FALSE AND on_unmatched_sni_reject IS NOT FALSE),
  CONSTRAINT listener_sni_action_xor CHECK (
    (on_unmatched_sni_reject IS TRUE) + (on_unmatched_sni_pool IS NOT NULL) <= 1),
  CONSTRAINT listener_sni_pool_class CHECK (on_unmatched_sni_cls IS NULL OR on_unmatched_sni_cls = 'tcp'),
  CONSTRAINT listener_source_allow_nonempty CHECK (source_allow IS NULL OR JSON_LENGTH(source_allow) > 0),
  CONSTRAINT listener_source_allow_stream_proxy CHECK (
    source_allow IS NULL OR accept_proxy_cidrs IS NULL OR protocol IN ('http', 'https')),
  CONSTRAINT listener_strict_priority_flag CHECK (http_strict_priority IS NOT FALSE),
  CONSTRAINT listener_strict_priority_http_only CHECK (http_strict_priority IS NULL OR protocol IN ('http', 'https')),
  CONSTRAINT listener_tcp_shape CHECK (
    protocol <> 'tcp'
    OR (udp_preset IS NULL AND default_pool_id IS NOT NULL AND http_default_pool_id IS NULL
        AND http_default_reject IS NULL AND on_unmatched_sni_pool IS NULL
        AND on_unmatched_sni_reject IS NULL AND preread_timeout_s IS NULL)),
  CONSTRAINT listener_tls_only_https CHECK (
    protocol = 'https' OR (tls_policy_id IS NULL AND tls_default_cert_id IS NULL)),
  CONSTRAINT listener_udp_shape CHECK (
    protocol <> 'udp'
    OR (udp_preset IS NOT NULL AND default_pool_id IS NOT NULL AND accept_proxy_cidrs IS NULL
        AND http_default_pool_id IS NULL AND http_default_reject IS NULL AND on_unmatched_sni_pool IS NULL
        AND on_unmatched_sni_reject IS NULL AND preread_timeout_s IS NULL)),
  CONSTRAINT listeners_bind_check CHECK (bind <> ''),
  CONSTRAINT listeners_key_syntax CHECK ((`key` REGEXP '^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$' AND RIGHT(`key`, 1) REGEXP '[A-Za-z0-9._-]')),
  CONSTRAINT listeners_port_check CHECK (port >= 1 AND port <= 65535),
  CONSTRAINT listeners_preread_timeout_s_check CHECK (preread_timeout_s IS NULL OR preread_timeout_s > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

-- ── 라우트 ───────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS http_routes (
  id                 char(36)     NOT NULL,
  `key`              varchar(255) NOT NULL,
  listener_id        char(36)     NOT NULL,
  listener_protocol  ENUM('http', 'tls_passthrough', 'tcp', 'udp', 'https') NOT NULL,
  hosts              json         NOT NULL COMMENT 'bary:array',
  priority           int          NOT NULL,
  path_prefix        longtext,
  action_kind        longtext     NOT NULL,
  pool_id            char(36),
  pool_cls           ENUM('http', 'tcp', 'udp'),
  websocket          boolean,
  redirect_to        longtext,
  status             int,
  version            int          NOT NULL DEFAULT 1,
  created_at         datetime(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at         datetime(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  created_by         longtext     NOT NULL,
  updated_by         longtext     NOT NULL,
  revision           bigint       NOT NULL,
  request_headers    json         COMMENT 'bary:json',
  rewrite_prefix     longtext,
  path_prefixes      json         COMMENT 'bary:array',
  source_rules       json         COMMENT 'bary:json',
  CONSTRAINT http_routes_pkey PRIMARY KEY (id),
  CONSTRAINT http_routes_key_key UNIQUE (`key`),
  KEY http_routes_listener_idx (listener_id),
  CONSTRAINT http_route_listener_fk FOREIGN KEY (listener_id, listener_protocol)
    REFERENCES listeners (id, protocol) ON DELETE RESTRICT,
  CONSTRAINT http_route_pool_fk FOREIGN KEY (pool_id, pool_cls)
    REFERENCES pools (id, protocol_class) ON DELETE RESTRICT,
  CONSTRAINT http_routes_array_shapes CHECK (
    JSON_TYPE(hosts) = 'ARRAY' AND (path_prefixes IS NULL OR JSON_TYPE(path_prefixes) = 'ARRAY')),
  CONSTRAINT http_route_listener_is_http CHECK (listener_protocol IN ('http', 'https')),
  CONSTRAINT http_route_path_one_or_many CHECK (path_prefixes IS NULL OR path_prefix IS NULL),
  CONSTRAINT http_route_path_prefixes_nonempty CHECK (path_prefixes IS NULL OR JSON_LENGTH(path_prefixes) > 0),
  CONSTRAINT http_route_pool_is_http CHECK (pool_cls IS NULL OR pool_cls = 'http'),
  CONSTRAINT http_route_proxy_options_proxy_only CHECK (
    action_kind = 'proxy' OR (request_headers IS NULL AND rewrite_prefix IS NULL)),
  CONSTRAINT http_route_proxy_shape CHECK (
    action_kind <> 'proxy'
    OR (pool_id IS NOT NULL AND websocket IS NOT NULL AND redirect_to IS NULL AND status IS NULL)),
  CONSTRAINT http_route_redirect_shape CHECK (
    action_kind <> 'redirect'
    OR (redirect_to IS NOT NULL AND status IN (301, 302, 307, 308) AND pool_id IS NULL AND websocket IS NULL)),
  CONSTRAINT http_route_reject_shape CHECK (
    action_kind <> 'reject'
    OR (status IN (403, 404, 444) AND pool_id IS NULL AND websocket IS NULL AND redirect_to IS NULL)),
  CONSTRAINT http_route_request_headers_shape CHECK (request_headers IS NULL OR JSON_TYPE(request_headers) = 'ARRAY'),
  CONSTRAINT http_route_rewrite_prefix_shape CHECK (
    rewrite_prefix IS NULL OR (rewrite_prefix REGEXP '^/[A-Za-z0-9._~/%-]*$' AND RIGHT(rewrite_prefix, 1) REGEXP '[A-Za-z0-9._~/%-]')),
  CONSTRAINT http_route_source_rules_array CHECK (
    source_rules IS NULL
    OR (JSON_TYPE(source_rules) = 'ARRAY' AND JSON_LENGTH(source_rules) >= 1 AND JSON_LENGTH(source_rules) <= 20)),
  CONSTRAINT http_routes_action_kind_check CHECK (action_kind IN ('proxy', 'redirect', 'reject')),
  CONSTRAINT http_routes_key_syntax CHECK ((`key` REGEXP '^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$' AND RIGHT(`key`, 1) REGEXP '[A-Za-z0-9._-]'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS passthrough_routes (
  id                 char(36)     NOT NULL,
  `key`              varchar(255) NOT NULL,
  listener_id        char(36)     NOT NULL,
  listener_protocol  ENUM('http', 'tls_passthrough', 'tcp', 'udp', 'https') NOT NULL,
  snis               json         NOT NULL COMMENT 'bary:array',
  priority           int          NOT NULL,
  action_kind        longtext     NOT NULL,
  pool_id            char(36),
  pool_cls           ENUM('http', 'tcp', 'udp'),
  version            int          NOT NULL DEFAULT 1,
  created_at         datetime(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at         datetime(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  created_by         longtext     NOT NULL,
  updated_by         longtext     NOT NULL,
  revision           bigint       NOT NULL,
  CONSTRAINT passthrough_routes_pkey PRIMARY KEY (id),
  CONSTRAINT passthrough_routes_key_key UNIQUE (`key`),
  KEY passthrough_routes_listener_idx (listener_id),
  CONSTRAINT pt_route_listener_fk FOREIGN KEY (listener_id, listener_protocol)
    REFERENCES listeners (id, protocol) ON DELETE RESTRICT,
  CONSTRAINT pt_route_pool_fk FOREIGN KEY (pool_id, pool_cls)
    REFERENCES pools (id, protocol_class) ON DELETE RESTRICT,
  CONSTRAINT passthrough_routes_snis_array CHECK (JSON_TYPE(snis) = 'ARRAY'),
  CONSTRAINT passthrough_routes_action_kind_check CHECK (action_kind IN ('proxy', 'reject')),
  CONSTRAINT passthrough_routes_key_syntax CHECK ((`key` REGEXP '^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$' AND RIGHT(`key`, 1) REGEXP '[A-Za-z0-9._-]')),
  CONSTRAINT pt_route_listener_is_pt CHECK (listener_protocol = 'tls_passthrough'),
  CONSTRAINT pt_route_pool_is_tcp CHECK (pool_cls IS NULL OR pool_cls = 'tcp'),
  CONSTRAINT pt_route_proxy_shape CHECK ((action_kind = 'proxy') = (pool_id IS NOT NULL))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

-- 리스너를 지우면 바인딩도 지워진다(PG 는 FK 의 ON DELETE CASCADE). MySQL 은 CHECK 가 보는 열(`listener_proto`)에 연쇄
-- FK 를 못 건다 — FK 는 연쇄 없이 두고 아래 트리거가 연쇄를 한다.
CREATE TABLE IF NOT EXISTS sni_certificate_bindings (
  id               char(36)     NOT NULL,
  `key`            varchar(255) NOT NULL,
  listener_id      char(36)     NOT NULL,
  listener_proto   ENUM('http', 'tls_passthrough', 'tcp', 'udp', 'https') NOT NULL,
  certificate_id   char(36)     NOT NULL,
  hosts            json         NOT NULL COMMENT 'bary:array',
  ovr_min_version  ENUM('1.2', '1.3'),
  ovr_max_version  ENUM('1.2', '1.3'),
  version          int          NOT NULL DEFAULT 1,
  created_at       datetime(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at       datetime(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  created_by       longtext     NOT NULL,
  updated_by       longtext     NOT NULL,
  revision         bigint       NOT NULL,
  CONSTRAINT sni_certificate_bindings_pkey PRIMARY KEY (id),
  CONSTRAINT sni_certificate_bindings_key_key UNIQUE (`key`),
  CONSTRAINT sni_certificate_bindings_certificate_id_fkey FOREIGN KEY (certificate_id)
    REFERENCES certificates (id) ON DELETE RESTRICT,
  CONSTRAINT sni_binding_listener_fk FOREIGN KEY (listener_id, listener_proto)
    REFERENCES listeners (id, protocol),
  CONSTRAINT sni_binding_is_https CHECK (listener_proto = 'https'),
  CONSTRAINT sni_binding_range CHECK (
    ovr_max_version IS NULL OR ovr_min_version IS NULL OR ovr_max_version >= ovr_min_version),
  CONSTRAINT sni_certificate_bindings_hosts_check CHECK (JSON_TYPE(hosts) = 'ARRAY' AND JSON_LENGTH(hosts) > 0),
  CONSTRAINT sni_certificate_bindings_key_syntax CHECK ((`key` REGEXP '^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$' AND RIGHT(`key`, 1) REGEXP '[A-Za-z0-9._-]'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TRIGGER IF NOT EXISTS listener_sni_bindings_cascade
  BEFORE DELETE ON listeners
  FOR EACH ROW
BEGIN
  DELETE FROM sni_certificate_bindings WHERE listener_id = OLD.id;
END;

-- ── 비밀 재료 ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS secret_materials (
  scheme        varchar(255) NOT NULL,
  name          varchar(255) NOT NULL,
  version       varchar(255) NOT NULL,
  kek_id        longtext     NOT NULL,
  wrapped_dek   longblob     NOT NULL,
  nonce         longblob     NOT NULL,
  ciphertext    longblob     NOT NULL,
  sha256        longtext,
  chain_digest  longtext,
  key_digest    longtext     NOT NULL,
  facts         json         COMMENT 'bary:json',
  created_at    datetime(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  CONSTRAINT secret_materials_pkey PRIMARY KEY (scheme, name, version),
  KEY secret_materials_scheme_idx (scheme),
  CONSTRAINT secret_materials_key_has_no_chain CHECK (
    scheme <> 'key' OR (chain_digest IS NULL AND sha256 IS NULL AND facts IS NULL)),
  CONSTRAINT secret_materials_name_shape CHECK ((name REGEXP '^[A-Za-z0-9._-]+$' AND RIGHT(name, 1) REGEXP '[A-Za-z0-9._-]')),
  CONSTRAINT secret_materials_scheme CHECK (scheme IN ('store', 'key')),
  CONSTRAINT secret_materials_store_has_chain CHECK (
    scheme <> 'store' OR (chain_digest IS NOT NULL AND sha256 IS NOT NULL)),
  CONSTRAINT secret_materials_version_shape CHECK ((version REGEXP '^[a-f0-9]{32}$' AND RIGHT(version, 1) REGEXP '[a-f0-9]'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

-- ── ACME ─────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS acme_accounts (
  id               char(36)     NOT NULL,
  `key`            varchar(255) NOT NULL,
  directory_url    varchar(768) NOT NULL,
  contact          json         NOT NULL DEFAULT ('[]') COMMENT 'bary:array',
  account_key_ref  longtext     NOT NULL,
  account_url      longtext,
  tos_agreed_at    datetime(6),
  created_at       datetime(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at       datetime(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  created_by       longtext     NOT NULL,
  CONSTRAINT acme_accounts_pkey PRIMARY KEY (id),
  CONSTRAINT acme_accounts_key_key UNIQUE (`key`),
  CONSTRAINT acme_account_directory_uq UNIQUE (directory_url),
  CONSTRAINT acme_accounts_contact_array CHECK (JSON_TYPE(contact) = 'ARRAY'),
  CONSTRAINT acme_accounts_account_key_ref_check CHECK ((account_key_ref REGEXP '^key://[A-Za-z0-9._-]+@[a-f0-9]{16,64}$' AND RIGHT(account_key_ref, 1) REGEXP '[a-f0-9]'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

-- `live_certificate_id` 는 PG 의 부분 유일 색인 `acme_order_live_uq … WHERE state IN (살아 있는 상태)` 의 자리다.
-- 끝난 주문은 NULL 이라 유일 검사에서 빠진다. 바탕 열(`certificate_id`)에 연쇄 FK 를 못 걸어 인증서 쪽 트리거가 연쇄를 한다.
CREATE TABLE IF NOT EXISTS acme_orders (
  id               char(36)     NOT NULL,
  account_id       char(36)     NOT NULL,
  certificate_id   varchar(36)  NOT NULL COMMENT 'bary:uuid',
  domains          json         NOT NULL COMMENT 'bary:array',
  state            ENUM('pending', 'validating', 'ready', 'issued', 'failed', 'abandoned') NOT NULL DEFAULT 'pending',
  order_url        longtext,
  finalize_url     longtext,
  certificate_url  longtext,
  issued_ref       longtext,
  cert_key_ref     longtext,
  attempts         int          NOT NULL DEFAULT 0,
  next_attempt_at  datetime(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  last_error       longtext,
  expires_at       datetime(6),
  claimed_by       longtext,
  claimed_until    datetime(6),
  created_at       datetime(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at       datetime(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  live_certificate_id varchar(36) GENERATED ALWAYS AS (
    CASE WHEN state IN ('pending', 'validating', 'ready', 'failed') THEN certificate_id END) STORED,
  CONSTRAINT acme_orders_pkey PRIMARY KEY (id),
  CONSTRAINT acme_order_live_uq UNIQUE (live_certificate_id),
  KEY acme_order_due_idx (next_attempt_at),
  KEY acme_orders_certificate_idx (certificate_id),
  CONSTRAINT acme_orders_account_id_fkey FOREIGN KEY (account_id) REFERENCES acme_accounts (id) ON DELETE RESTRICT,
  CONSTRAINT acme_orders_certificate_id_fkey FOREIGN KEY (certificate_id) REFERENCES certificates (id),
  CONSTRAINT acme_order_claim_shape CHECK ((claimed_by IS NULL) = (claimed_until IS NULL)),
  CONSTRAINT acme_order_issued_has_ref CHECK (
    state <> 'issued' OR (issued_ref IS NOT NULL AND cert_key_ref IS NOT NULL)),
  CONSTRAINT acme_order_terminal_unclaimed CHECK (state NOT IN ('issued', 'abandoned') OR claimed_by IS NULL),
  CONSTRAINT acme_orders_cert_key_ref_check CHECK (
    cert_key_ref IS NULL OR (cert_key_ref REGEXP '^key://[A-Za-z0-9._-]+@[a-f0-9]{16,64}$' AND RIGHT(cert_key_ref, 1) REGEXP '[a-f0-9]')),
  CONSTRAINT acme_orders_domains_check CHECK (JSON_TYPE(domains) = 'ARRAY' AND JSON_LENGTH(domains) > 0),
  CONSTRAINT acme_orders_issued_ref_check CHECK (
    issued_ref IS NULL OR (issued_ref REGEXP '^store://[A-Za-z0-9._-]+@[a-f0-9]{16,64}$' AND RIGHT(issued_ref, 1) REGEXP '[a-f0-9]'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TRIGGER IF NOT EXISTS certificate_acme_orders_cascade
  BEFORE DELETE ON certificates
  FOR EACH ROW
BEGIN
  DELETE FROM acme_orders WHERE certificate_id = OLD.id;
END;

CREATE TABLE IF NOT EXISTS acme_challenges (
  id             char(36)     NOT NULL,
  order_id       char(36)     NOT NULL,
  domain         varchar(255) NOT NULL,
  type           ENUM('http-01', 'dns-01') NOT NULL,
  token          longtext     NOT NULL,
  value          longtext     NOT NULL,
  authz_url      longtext     NOT NULL,
  challenge_url  longtext     NOT NULL,
  placed_at      datetime(6),
  cleaned_at     datetime(6),
  created_at     datetime(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  CONSTRAINT acme_challenges_pkey PRIMARY KEY (id),
  CONSTRAINT acme_challenge_uq UNIQUE (order_id, domain, type),
  KEY acme_challenge_orphan_idx (placed_at),
  CONSTRAINT acme_challenges_order_id_fkey FOREIGN KEY (order_id) REFERENCES acme_orders (id) ON DELETE CASCADE,
  CONSTRAINT acme_challenge_clean_after_place CHECK (cleaned_at IS NULL OR placed_at IS NOT NULL)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

-- ── 주소 집합 ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS address_sets (
  id              char(36)     NOT NULL,
  `key`           varchar(255) NOT NULL,
  cidrs           json         NOT NULL COMMENT 'bary:array',
  source          longtext,
  version         int          NOT NULL DEFAULT 1,
  created_at      datetime(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at      datetime(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  created_by      longtext     NOT NULL,
  updated_by      longtext     NOT NULL,
  revision        bigint       NOT NULL,
  source_options  json         COMMENT 'bary:json',
  CONSTRAINT address_sets_pkey PRIMARY KEY (id),
  CONSTRAINT address_sets_key_key UNIQUE (`key`),
  CONSTRAINT address_set_nonempty CHECK (JSON_TYPE(cidrs) = 'ARRAY' AND JSON_LENGTH(cidrs) > 0),
  CONSTRAINT address_set_source CHECK (source IS NULL OR (source REGEXP '^[a-z][a-z0-9-]{0,31}$' AND RIGHT(source, 1) REGEXP '[a-z0-9-]')),
  CONSTRAINT address_set_source_options CHECK (
    source_options IS NULL OR (source IS NOT NULL AND JSON_TYPE(source_options) = 'OBJECT')),
  CONSTRAINT address_sets_key_syntax CHECK ((`key` REGEXP '^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$' AND RIGHT(`key`, 1) REGEXP '[A-Za-z0-9._-]'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS address_set_refresh (
  `key`         varchar(255) NOT NULL,
  checked_at    datetime(6)  NOT NULL,
  ok            boolean      NOT NULL,
  reason        longtext,
  detail        longtext,
  refreshed_at  datetime(6),
  revision      bigint,
  by_actor      longtext     NOT NULL,
  CONSTRAINT address_set_refresh_pkey PRIMARY KEY (`key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

-- ── 최초 리비전 — 빈 모델 ────────────────────────────────────────────────
--
-- head 가 가리킬 곳이 처음부터 있어야 changeset 의 `base_revision` FK 가 성립한다(PG 001 과 같다).
INSERT INTO config_revisions (revision, model, created_by, note)
VALUES (1, '{"listeners":[],"httpRoutes":[],"passthroughRoutes":[],"pools":[],"backends":[]}',
        'system', '최초 리비전 — 빈 모델')
  ON DUPLICATE KEY UPDATE revision = revision;
INSERT INTO config_head (revision) VALUES (1) ON DUPLICATE KEY UPDATE only_one = only_one;
