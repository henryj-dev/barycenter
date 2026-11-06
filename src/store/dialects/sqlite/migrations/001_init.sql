-- SQLite 계열 001 — 설정 DB 의 최종 스키마 (docs/adr-multi-db.md 「SQLite」)
--
-- **PG 계열 001~033 을 모두 적용한 뒤의 모양을 한 파일에 둔다.** 배포된 SQLite DB 가 없던 때에
-- 시작했으므로 PG 의 역사를 되풀이하지 않는다. 002~033 은 이름만 맞추는 빈 파일이다(실행기가 이름을
-- 맞춘다). 034 부터는 PG 와 같이 한 파일이 한 단계다.
--
-- ── 선언 형 ─────────────────────────────────────────────────────────────
--
-- 드라이버(`src/store/sqlite.ts` 의 `decode`)는 **열의 선언 형**으로 값을 PG 와 같은 JS 값으로 맞추고,
-- 모양 읽기(`src/store/schema-shape.ts`)는 같은 표로 논리 형을 읽는다. 그래서 선언 형은 아래 표에서만 고른다.
--
--   PG                         SQLite 선언 형     담는 값
--   text · varchar             text
--   integer · smallint         int
--   bigint                     bigint
--   bigserial                  INTEGER PRIMARY KEY AUTOINCREMENT   (rowid 별칭. PG 시퀀스처럼 재사용하지 않는다)
--   boolean                    boolean            0 · 1
--   timestamptz                timestamptz        ISO-8601 텍스트 `YYYY-MM-DDTHH:MM:SS.sssZ` (UTC) — 한 형식이라 문자열 비교가 시각 비교다
--   jsonb · json               json_text          JSON 텍스트 + `CHECK (json_valid(…))`
--   text[]                     text_array         JSON 배열 텍스트 + `CHECK (json_type(…) = 'array')`
--   enum                       enum_text          텍스트 + 최종 라벨의 `CHECK (… IN (…))`
--   uuid                       uuid               텍스트
--   cidr · inet                cidr · inet        텍스트
--   bytea                      blob
--   numeric                    numeric
--   double precision · real    real
--
-- `integer` 라는 낱말은 `INTEGER PRIMARY KEY` 에만 쓴다. 기본 키 열에는 `NOT NULL` 을 적는다 — SQLite 는
-- `INTEGER` 가 아닌 기본 키에 NULL 을 받는다.
--
-- ── PG 와 다른 표기 ──────────────────────────────────────────────────────
--
-- - `DEFAULT now()` → `DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))`. 드라이버가 거는 `now()` 와 같은 형식이고,
--   내장 함수라 다른 도구로 열어도 삽입이 된다. DDL 에는 사용자 정의 함수를 쓰지 않는다.
-- - 정규식 CHECK(`~`) → `length` · `GLOB` · `instr` · `substr`. 받는 집합은 PG 와 같다.
-- - `cardinality(a)` → `json_array_length(a)`, `jsonb_typeof` → `json_type`, `interval` → `julianday` 의 날 수.
-- - 시퀀스 → `bary_sequences` 표. `last_value` 는 마지막으로 낸 값이다.
-- - PG 가 `ALTER TABLE … ADD CONSTRAINT` 로 더한 CHECK 는 `CREATE TABLE` 안에 접었다(SQLite 는 나중에 못 더한다).

-- ── 시퀀스 대신 ──────────────────────────────────────────────────────────
--
-- nextval = `UPDATE bary_sequences SET last_value = last_value + 1 WHERE name = ? RETURNING last_value`.
-- config_revision_seq 가 1 인 것은 아래 최초 리비전이 1 을 썼기 때문이다.
CREATE TABLE bary_sequences (
  name        text   NOT NULL PRIMARY KEY,
  last_value  bigint NOT NULL
);
INSERT INTO bary_sequences (name, last_value) VALUES
  ('config_revision_seq', 1),
  ('activation_epoch_seq', 0),
  ('leader_token_seq', 0);

-- ── 전역 좌표 ────────────────────────────────────────────────────────────

-- 한 행짜리 표. PG 는 이 행을 `FOR UPDATE` 로 잡지만, SQLite 는 `BEGIN IMMEDIATE` 가 쓰기를 줄 세운다.
CREATE TABLE config_head (
  only_one  boolean NOT NULL DEFAULT 1 CONSTRAINT config_head_only_one_check CHECK (only_one),
  revision  bigint  NOT NULL,
  CONSTRAINT config_head_pkey PRIMARY KEY (only_one)
);

CREATE TABLE config_revisions (
  revision     bigint      NOT NULL,
  parent       bigint      CONSTRAINT config_revisions_parent_fkey REFERENCES config_revisions (revision),
  rollback_of  bigint      CONSTRAINT config_revisions_rollback_of_fkey REFERENCES config_revisions (revision),
  model        json_text   NOT NULL CHECK (json_valid(model)),
  created_at   timestamptz NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_by   text        NOT NULL,
  note         text,
  CONSTRAINT config_revisions_pkey PRIMARY KEY (revision),
  CONSTRAINT config_revisions_check CHECK (rollback_of IS NULL OR rollback_of < revision),
  CONSTRAINT revision_not_self_rollback CHECK (rollback_of IS NULL OR rollback_of <> revision)
);

CREATE TABLE changesets (
  id                  uuid        NOT NULL,
  base_revision       bigint      NOT NULL CONSTRAINT changesets_base_revision_fkey REFERENCES config_revisions (revision),
  state               enum_text   NOT NULL DEFAULT 'open'
                        CHECK (state IN ('open', 'sealed', 'committed', 'discarded')),
  patch               json_text   NOT NULL DEFAULT '[]' CHECK (json_valid(patch)),
  created_at          timestamptz NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_by          text        NOT NULL,
  sealed_at           timestamptz,
  committed_revision  bigint      CONSTRAINT changesets_committed_revision_fkey REFERENCES config_revisions (revision),
  CONSTRAINT changesets_pkey PRIMARY KEY (id),
  CONSTRAINT changeset_committed CHECK ((state = 'committed') = (committed_revision IS NOT NULL)),
  CONSTRAINT changeset_sealed_at CHECK (
    (state = 'open') = (sealed_at IS NULL) OR state IN ('committed', 'discarded'))
);

CREATE TABLE plans (
  id                uuid        NOT NULL,
  changeset_id      uuid        CONSTRAINT plans_changeset_id_fkey REFERENCES changesets (id) ON DELETE CASCADE,
  state             enum_text   NOT NULL DEFAULT 'planned'
                      CHECK (state IN ('planned', 'committed', 'operation_bound', 'applied', 'expired', 'superseded', 'failed')),
  base_revision     bigint      NOT NULL,
  model             json_text   NOT NULL CHECK (json_valid(model)),
  impact            json_text   NOT NULL CHECK (json_valid(impact)),
  render_digest     text        NOT NULL,
  renderer_version  text        NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at        timestamptz NOT NULL,
  target_revision   bigint      CONSTRAINT plans_target_revision_fkey REFERENCES config_revisions (revision),
  activation_epoch  bigint,
  CONSTRAINT plans_pkey PRIMARY KEY (id),
  CONSTRAINT plan_reserved_together CHECK ((target_revision IS NULL) = (activation_epoch IS NULL)),
  CONSTRAINT plan_reserved_when_committed CHECK (
    state = 'planned' OR state = 'expired' OR target_revision IS NOT NULL)
);
CREATE INDEX plans_changeset_idx ON plans (changeset_id);

CREATE TABLE operations (
  id                uuid        NOT NULL,
  plan_id           uuid        NOT NULL CONSTRAINT operations_plan_id_fkey REFERENCES plans (id),
  revision          bigint      NOT NULL CONSTRAINT operations_revision_fkey REFERENCES config_revisions (revision),
  activation_epoch  bigint      NOT NULL,
  generation        text        NOT NULL,
  phase             text        NOT NULL,
  detail            json_text   CHECK (detail IS NULL OR json_valid(detail)),
  created_at        timestamptz NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at        timestamptz NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_by        text        NOT NULL,
  envelope          json_text   CHECK (envelope IS NULL OR json_valid(envelope)),
  CONSTRAINT operations_pkey PRIMARY KEY (id),
  CONSTRAINT operations_plan_id_key UNIQUE (plan_id)
);

CREATE TABLE audit (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  at         timestamptz NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  principal  text        NOT NULL,
  action     text        NOT NULL,
  subject    text        NOT NULL,
  before     json_text   CHECK (before IS NULL OR json_valid(before)),
  after      json_text   CHECK (after IS NULL OR json_valid(after)),
  revision   bigint
);
CREATE INDEX audit_at_idx ON audit (at DESC);

-- ── 리더 선출 ────────────────────────────────────────────────────────────

CREATE TABLE leadership (
  token        bigint      NOT NULL,
  holder       text        NOT NULL,
  acquired_at  timestamptz NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  released_at  timestamptz,
  CONSTRAINT leadership_pkey PRIMARY KEY (token)
);
CREATE INDEX leadership_acquired_idx ON leadership (acquired_at DESC);

CREATE TABLE cluster_nodes (
  name               text        NOT NULL,
  url                text,
  role               text        NOT NULL,
  active_epoch       bigint,
  active_generation  text,
  state              text        NOT NULL,
  last_error         text,
  last_seen          timestamptz NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at         timestamptz NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CONSTRAINT cluster_nodes_pkey PRIMARY KEY (name),
  CONSTRAINT cluster_node_role CHECK (role IN ('leader', 'follower')),
  CONSTRAINT cluster_node_state CHECK (state IN ('in_sync', 'following', 'failed', 'standalone'))
);

-- ── 풀과 백엔드 ──────────────────────────────────────────────────────────
--
-- `(id, protocol_class)` UNIQUE 는 복합 FK 의 과녁이다 — 라우트·리스너의 비정규화한 클래스가 풀의
-- 실제 클래스와 다를 수 없게 한다(PG 001 머리말).
CREATE TABLE pools (
  id                   uuid        NOT NULL,
  key                  text        NOT NULL,
  name                 text        NOT NULL,
  protocol_class       enum_text   NOT NULL CHECK (protocol_class IN ('http', 'tcp', 'udp')),
  algorithm            enum_text   NOT NULL CHECK (algorithm IN ('round_robin', 'source_ip_hash', 'hash', 'least_conn')),
  hash_key             text,
  send_proxy_protocol  text,
  version              int         NOT NULL DEFAULT 1,
  created_at           timestamptz NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at           timestamptz NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_by           text        NOT NULL,
  updated_by           text        NOT NULL,
  revision             bigint      NOT NULL,
  health_check         json_text   CHECK (health_check IS NULL OR json_valid(health_check)),
  upstream_tls         json_text   CHECK (upstream_tls IS NULL OR json_valid(upstream_tls)),
  discovery            json_text   CHECK (discovery IS NULL OR json_valid(discovery)),
  CONSTRAINT pools_pkey PRIMARY KEY (id),
  CONSTRAINT pools_key_key UNIQUE (key),
  CONSTRAINT pool_id_class_uq UNIQUE (id, protocol_class),
  CONSTRAINT pool_discovery_shape CHECK (discovery IS NULL OR json_type(discovery) = 'object'),
  CONSTRAINT pool_hash_key_iff CHECK ((algorithm = 'hash') = (hash_key IS NOT NULL)),
  CONSTRAINT pool_healthcheck_http_only CHECK (health_check IS NULL OR protocol_class = 'http'),
  CONSTRAINT pool_healthcheck_shape CHECK (health_check IS NULL OR json_type(health_check) = 'object'),
  CONSTRAINT pool_send_pp_tcp_only CHECK (
    send_proxy_protocol IS NULL OR (send_proxy_protocol = 'v1' AND protocol_class = 'tcp')),
  CONSTRAINT pool_upstream_tls_not_udp CHECK (upstream_tls IS NULL OR protocol_class <> 'udp'),
  CONSTRAINT pool_upstream_tls_shape CHECK (upstream_tls IS NULL OR json_type(upstream_tls) = 'object'),
  CONSTRAINT pools_key_syntax CHECK (
    length(key) BETWEEN 1 AND 63 AND key GLOB '[A-Za-z0-9]*' AND key NOT GLOB '*[^A-Za-z0-9._-]*')
);

CREATE TABLE backends (
  id          uuid        NOT NULL,
  key         text        NOT NULL,
  pool_id     uuid        NOT NULL CONSTRAINT backends_pool_id_fkey REFERENCES pools (id) ON DELETE CASCADE,
  host        text        NOT NULL,
  port        int         NOT NULL,
  weight      int         NOT NULL,
  enabled     boolean     NOT NULL DEFAULT 1,
  version     int         NOT NULL DEFAULT 1,
  created_at  timestamptz NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at  timestamptz NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_by  text        NOT NULL,
  updated_by  text        NOT NULL,
  revision    bigint      NOT NULL,
  CONSTRAINT backends_pkey PRIMARY KEY (id),
  CONSTRAINT backends_key_key UNIQUE (key),
  CONSTRAINT backends_host_check CHECK (host <> ''),
  CONSTRAINT backends_key_syntax CHECK (
    length(key) BETWEEN 1 AND 63 AND key GLOB '[A-Za-z0-9]*' AND key NOT GLOB '*[^A-Za-z0-9._-]*'),
  CONSTRAINT backends_port_check CHECK (port >= 1 AND port <= 65535),
  CONSTRAINT backends_weight_check CHECK (weight >= 0)
);
CREATE INDEX backends_pool_idx ON backends (pool_id);

-- ── 운영 상태 (백엔드 key 로 잇는다) ──────────────────────────────────────

CREATE TABLE backend_drain (
  backend_key  text        NOT NULL,
  started_at   timestamptz NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  deadline_at  timestamptz,
  started_by   text        NOT NULL,
  CONSTRAINT backend_drain_pkey PRIMARY KEY (backend_key)
);
CREATE INDEX backend_drain_deadline_idx ON backend_drain (deadline_at);

CREATE TABLE backend_health (
  backend_key      text        NOT NULL,
  state            enum_text   NOT NULL DEFAULT 'unknown' CHECK (state IN ('healthy', 'unhealthy', 'unknown')),
  probe_start_seq  bigint      NOT NULL DEFAULT 0,
  last_ok          boolean     NOT NULL DEFAULT 1,
  consecutive      int         NOT NULL DEFAULT 0,
  observed_at      timestamptz NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  detail           text,
  CONSTRAINT backend_health_pkey PRIMARY KEY (backend_key)
);

-- 한 행짜리 표 — 다음 health_events.seq.
CREATE TABLE health_cursor (
  only_one  boolean NOT NULL DEFAULT 1 CONSTRAINT health_cursor_only_one_check CHECK (only_one),
  next_seq  bigint  NOT NULL DEFAULT 1,
  CONSTRAINT health_cursor_pkey PRIMARY KEY (only_one)
);
INSERT INTO health_cursor DEFAULT VALUES;

CREATE TABLE health_events (
  seq          bigint      NOT NULL,
  backend_key  text        NOT NULL,
  state        enum_text   NOT NULL CHECK (state IN ('healthy', 'unhealthy', 'unknown')),
  at           timestamptz NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  detail       text,
  CONSTRAINT health_events_pkey PRIMARY KEY (seq)
);
CREATE INDEX health_events_at_idx ON health_events (at);
CREATE INDEX health_events_backend_idx ON health_events (backend_key, seq DESC);

-- 운영 상태가 백엔드보다 오래 살면 안 된다 — FK 가 아니라 지우는 쪽의 트리거다(PG 013 의 근거 그대로).
-- SQLite 도 ON DELETE CASCADE 로 지워지는 행에 이 트리거를 건다(풀 삭제 · 롤백).
CREATE TRIGGER backend_state_cleanup
  AFTER DELETE ON backends
  FOR EACH ROW
BEGIN
  DELETE FROM backend_drain  WHERE backend_key = OLD.key;
  DELETE FROM backend_health WHERE backend_key = OLD.key;
END;

CREATE TABLE engine_settings (
  only_one                   boolean     NOT NULL DEFAULT 1 CONSTRAINT engine_settings_only_one_check CHECK (only_one),
  worker_shutdown_timeout_s  int,
  updated_at                 timestamptz NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by                 text        NOT NULL,
  revision                   bigint      NOT NULL,
  membership_dict_kb         int,
  acme_dict_kb               int,
  CONSTRAINT engine_settings_pkey PRIMARY KEY (only_one),
  CONSTRAINT engine_settings_acme_dict_kb_check CHECK (
    acme_dict_kb IS NULL OR (acme_dict_kb >= 32 AND acme_dict_kb <= 1048576)),
  CONSTRAINT engine_settings_membership_dict_kb_check CHECK (
    membership_dict_kb IS NULL OR (membership_dict_kb >= 64 AND membership_dict_kb <= 1048576)),
  CONSTRAINT engine_settings_worker_shutdown_timeout_s_check CHECK (
    worker_shutdown_timeout_s IS NULL OR (worker_shutdown_timeout_s >= 1 AND worker_shutdown_timeout_s <= 86400))
);

-- ── TLS ──────────────────────────────────────────────────────────────────

-- tls_version 은 '1.2' < '1.3' 이라 텍스트 비교가 PG enum 의 순서와 같다.
CREATE TABLE tls_policies (
  id                 uuid        NOT NULL,
  key                text        NOT NULL,
  name               text        NOT NULL,
  min_version        enum_text   NOT NULL CHECK (min_version IN ('1.2', '1.3')),
  max_version        enum_text   CHECK (max_version IS NULL OR max_version IN ('1.2', '1.3')),
  version            int         NOT NULL DEFAULT 1,
  created_at         timestamptz NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at         timestamptz NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_by         text        NOT NULL,
  updated_by         text        NOT NULL,
  revision           bigint      NOT NULL,
  sni_host_mismatch  text,
  cipher_policy      text,
  hsts               json_text   CHECK (hsts IS NULL OR json_valid(hsts)),
  CONSTRAINT tls_policies_pkey PRIMARY KEY (id),
  CONSTRAINT tls_policies_key_key UNIQUE (key),
  CONSTRAINT tls_policies_key_syntax CHECK (
    length(key) BETWEEN 1 AND 63 AND key GLOB '[A-Za-z0-9]*' AND key NOT GLOB '*[^A-Za-z0-9._-]*'),
  CONSTRAINT tls_policy_cipher_known CHECK (
    cipher_policy IS NULL OR cipher_policy IN ('modern-2026', 'intermediate-2026')),
  -- jsonb 의 'number' 는 SQLite json_type 의 'integer' · 'real' 둘이다.
  CONSTRAINT tls_policy_hsts_shape CHECK (
    hsts IS NULL OR (json_type(hsts) = 'object' AND json_type(hsts, '$.maxAgeSeconds') IN ('integer', 'real'))),
  CONSTRAINT tls_policy_range CHECK (max_version IS NULL OR max_version >= min_version),
  CONSTRAINT tls_policy_sni_mismatch_known CHECK (
    sni_host_mismatch IS NULL OR sni_host_mismatch IN ('allow', 'reject_421'))
);

CREATE TABLE certificates (
  id            uuid        NOT NULL,
  key           text        NOT NULL,
  name          text        NOT NULL,
  material_ref  text,
  chain_digest  text,
  key_digest    text,
  version       int         NOT NULL DEFAULT 1,
  created_at    timestamptz NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    timestamptz NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_by    text        NOT NULL,
  updated_by    text        NOT NULL,
  revision      bigint      NOT NULL,
  acme_account  text,
  acme_domains  text_array  CHECK (acme_domains IS NULL OR json_type(acme_domains) = 'array'),
  CONSTRAINT certificates_pkey PRIMARY KEY (id),
  CONSTRAINT certificates_key_key UNIQUE (key),
  CONSTRAINT certificate_acme_together CHECK (
    (acme_account IS NULL AND acme_domains IS NULL)
    OR (acme_account IS NOT NULL AND acme_domains IS NOT NULL AND json_array_length(acme_domains) > 0)),
  CONSTRAINT certificate_material_together CHECK (
    (material_ref IS NULL AND chain_digest IS NULL AND key_digest IS NULL)
    OR (material_ref IS NOT NULL AND chain_digest IS NOT NULL AND key_digest IS NOT NULL)),
  CONSTRAINT certificate_useful CHECK (material_ref IS NOT NULL OR acme_account IS NOT NULL),
  -- '^sha256:[a-f0-9]{64}$'
  CONSTRAINT certificates_chain_digest_check CHECK (
    chain_digest IS NULL
    OR (length(chain_digest) = 71 AND chain_digest GLOB 'sha256:*' AND substr(chain_digest, 8) NOT GLOB '*[^a-f0-9]*')),
  CONSTRAINT certificates_key_digest_check CHECK (
    key_digest IS NULL
    OR (length(key_digest) = 71 AND key_digest GLOB 'sha256:*' AND substr(key_digest, 8) NOT GLOB '*[^a-f0-9]*')),
  CONSTRAINT certificates_key_syntax CHECK (
    length(key) BETWEEN 1 AND 63 AND key GLOB '[A-Za-z0-9]*' AND key NOT GLOB '*[^A-Za-z0-9._-]*'),
  -- '^store://[A-Za-z0-9._-]+@[a-f0-9]{16,64}$' — 이름에는 '@' 가 없으므로 첫 '@' 가 경계다.
  CONSTRAINT certificates_material_ref_check CHECK (
    material_ref IS NULL
    OR (material_ref GLOB 'store://*'
        AND instr(substr(material_ref, 9), '@') > 1
        AND substr(material_ref, 9, instr(substr(material_ref, 9), '@') - 1) NOT GLOB '*[^A-Za-z0-9._-]*'
        AND length(substr(material_ref, 9 + instr(substr(material_ref, 9), '@'))) BETWEEN 16 AND 64
        AND substr(material_ref, 9 + instr(substr(material_ref, 9), '@')) NOT GLOB '*[^a-f0-9]*'))
);

-- ── 리스너 ───────────────────────────────────────────────────────────────

CREATE TABLE listeners (
  id                       uuid        NOT NULL,
  key                      text        NOT NULL,
  name                     text        NOT NULL,
  protocol                 enum_text   NOT NULL CHECK (protocol IN ('http', 'tls_passthrough', 'tcp', 'udp', 'https')),
  bind                     text        NOT NULL,
  port                     int         NOT NULL,
  enabled                  boolean     NOT NULL DEFAULT 1,
  udp_preset               enum_text   CHECK (udp_preset IS NULL OR udp_preset IN ('dns', 'wireguard', 'game_generic', 'custom')),
  http_default_pool_id     uuid,
  http_default_pool_cls    enum_text   CHECK (http_default_pool_cls IS NULL OR http_default_pool_cls IN ('http', 'tcp', 'udp')),
  http_default_reject      boolean,
  on_unmatched_sni_pool    uuid,
  on_unmatched_sni_cls     enum_text   CHECK (on_unmatched_sni_cls IS NULL OR on_unmatched_sni_cls IN ('http', 'tcp', 'udp')),
  on_unmatched_sni_reject  boolean,
  preread_timeout_s        int,
  default_pool_id          uuid,
  default_pool_cls         enum_text   CHECK (default_pool_cls IS NULL OR default_pool_cls IN ('http', 'tcp', 'udp')),
  version                  int         NOT NULL DEFAULT 1,
  created_at               timestamptz NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at               timestamptz NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_by               text        NOT NULL,
  updated_by               text        NOT NULL,
  revision                 bigint      NOT NULL,
  accept_proxy_cidrs       text_array  CHECK (accept_proxy_cidrs IS NULL OR json_type(accept_proxy_cidrs) = 'array'),
  tls_policy_id            uuid        CONSTRAINT listeners_tls_policy_id_fkey REFERENCES tls_policies (id) ON DELETE RESTRICT,
  tls_default_cert_id      uuid        CONSTRAINT listeners_tls_default_cert_id_fkey REFERENCES certificates (id) ON DELETE RESTRICT,
  http2                    boolean,
  proxy_limits             json_text   CHECK (proxy_limits IS NULL OR json_valid(proxy_limits)),
  header_rules             json_text   CHECK (header_rules IS NULL OR json_valid(header_rules)),
  rate_limit               json_text   CHECK (rate_limit IS NULL OR json_valid(rate_limit)),
  on_no_sni_pool           uuid,
  on_no_sni_cls            enum_text   CHECK (on_no_sni_cls IS NULL OR on_no_sni_cls IN ('http', 'tcp', 'udp')),
  on_no_sni_reject         boolean,
  http_strict_priority     boolean,
  real_ip_header           text,
  real_ip_header_cidrs     text_array  CHECK (real_ip_header_cidrs IS NULL OR json_type(real_ip_header_cidrs) = 'array'),
  source_allow             text_array  CHECK (source_allow IS NULL OR json_type(source_allow) = 'array'),
  hosts                    text_array  CHECK (hosts IS NULL OR json_type(hosts) = 'array'),
  http_redirect_port       int,
  CONSTRAINT listeners_pkey PRIMARY KEY (id),
  CONSTRAINT listeners_key_key UNIQUE (key),
  CONSTRAINT listener_id_protocol_uq UNIQUE (id, protocol),
  CONSTRAINT listener_default_pool_fk FOREIGN KEY (default_pool_id, default_pool_cls)
    REFERENCES pools (id, protocol_class) ON DELETE RESTRICT,
  CONSTRAINT listener_http_pool_fk FOREIGN KEY (http_default_pool_id, http_default_pool_cls)
    REFERENCES pools (id, protocol_class) ON DELETE RESTRICT,
  CONSTRAINT listener_no_sni_pool_fk FOREIGN KEY (on_no_sni_pool, on_no_sni_cls)
    REFERENCES pools (id, protocol_class),
  CONSTRAINT listener_sni_pool_fk FOREIGN KEY (on_unmatched_sni_pool, on_unmatched_sni_cls)
    REFERENCES pools (id, protocol_class) ON DELETE RESTRICT,
  CONSTRAINT listener_default_pool_class CHECK (
    default_pool_cls IS NULL
    OR (protocol = 'udp' AND default_pool_cls = 'udp')
    OR (protocol = 'tcp' AND default_pool_cls = 'tcp')),
  CONSTRAINT listener_header_rules_http_only CHECK (header_rules IS NULL OR protocol IN ('http', 'https')),
  CONSTRAINT listener_header_rules_shape CHECK (header_rules IS NULL OR json_type(header_rules) = 'object'),
  CONSTRAINT listener_hosts_http_only CHECK (hosts IS NULL OR protocol IN ('http', 'https')),
  CONSTRAINT listener_hosts_nonempty CHECK (hosts IS NULL OR json_array_length(hosts) > 0),
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
  CONSTRAINT listener_proxy_cidrs_nonempty CHECK (accept_proxy_cidrs IS NULL OR json_array_length(accept_proxy_cidrs) > 0),
  CONSTRAINT listener_proxy_limits_http_only CHECK (proxy_limits IS NULL OR protocol IN ('http', 'https')),
  CONSTRAINT listener_proxy_limits_shape CHECK (proxy_limits IS NULL OR json_type(proxy_limits) = 'object'),
  CONSTRAINT listener_rate_limit_http_only CHECK (rate_limit IS NULL OR protocol IN ('http', 'https')),
  CONSTRAINT listener_rate_limit_shape CHECK (rate_limit IS NULL OR json_type(rate_limit) = 'object'),
  CONSTRAINT listener_real_ip_header_http_only CHECK (real_ip_header IS NULL OR protocol IN ('http', 'https')),
  CONSTRAINT listener_real_ip_header_name CHECK (
    real_ip_header IS NULL OR real_ip_header IN ('CF-Connecting-IP', 'X-Forwarded-For', 'X-Real-IP')),
  CONSTRAINT listener_real_ip_header_pair CHECK (
    (real_ip_header IS NULL AND real_ip_header_cidrs IS NULL)
    OR (real_ip_header IS NOT NULL AND real_ip_header_cidrs IS NOT NULL AND json_array_length(real_ip_header_cidrs) > 0)),
  CONSTRAINT listener_real_ip_single_source CHECK (real_ip_header IS NULL OR accept_proxy_cidrs IS NULL),
  CONSTRAINT listener_reject_flags CHECK (http_default_reject IS NOT FALSE AND on_unmatched_sni_reject IS NOT FALSE),
  CONSTRAINT listener_sni_action_xor CHECK (
    (on_unmatched_sni_reject IS TRUE) + (on_unmatched_sni_pool IS NOT NULL) <= 1),
  CONSTRAINT listener_sni_pool_class CHECK (on_unmatched_sni_cls IS NULL OR on_unmatched_sni_cls = 'tcp'),
  CONSTRAINT listener_source_allow_nonempty CHECK (source_allow IS NULL OR json_array_length(source_allow) > 0),
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
  CONSTRAINT listeners_key_syntax CHECK (
    length(key) BETWEEN 1 AND 63 AND key GLOB '[A-Za-z0-9]*' AND key NOT GLOB '*[^A-Za-z0-9._-]*'),
  CONSTRAINT listeners_port_check CHECK (port >= 1 AND port <= 65535),
  CONSTRAINT listeners_preread_timeout_s_check CHECK (preread_timeout_s IS NULL OR preread_timeout_s > 0)
);

-- ── 라우트 ───────────────────────────────────────────────────────────────

CREATE TABLE http_routes (
  id                 uuid        NOT NULL,
  key                text        NOT NULL,
  listener_id        uuid        NOT NULL,
  listener_protocol  enum_text   NOT NULL CHECK (listener_protocol IN ('http', 'tls_passthrough', 'tcp', 'udp', 'https')),
  hosts              text_array  NOT NULL CHECK (json_type(hosts) = 'array'),
  priority           int         NOT NULL,
  path_prefix        text,
  action_kind        text        NOT NULL,
  pool_id            uuid,
  pool_cls           enum_text   CHECK (pool_cls IS NULL OR pool_cls IN ('http', 'tcp', 'udp')),
  websocket          boolean,
  redirect_to        text,
  status             int,
  version            int         NOT NULL DEFAULT 1,
  created_at         timestamptz NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at         timestamptz NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_by         text        NOT NULL,
  updated_by         text        NOT NULL,
  revision           bigint      NOT NULL,
  request_headers    json_text   CHECK (request_headers IS NULL OR json_valid(request_headers)),
  rewrite_prefix     text,
  path_prefixes      text_array  CHECK (path_prefixes IS NULL OR json_type(path_prefixes) = 'array'),
  source_rules       json_text   CHECK (source_rules IS NULL OR json_valid(source_rules)),
  CONSTRAINT http_routes_pkey PRIMARY KEY (id),
  CONSTRAINT http_routes_key_key UNIQUE (key),
  CONSTRAINT http_route_listener_fk FOREIGN KEY (listener_id, listener_protocol)
    REFERENCES listeners (id, protocol) ON DELETE RESTRICT,
  CONSTRAINT http_route_pool_fk FOREIGN KEY (pool_id, pool_cls)
    REFERENCES pools (id, protocol_class) ON DELETE RESTRICT,
  CONSTRAINT http_route_listener_is_http CHECK (listener_protocol IN ('http', 'https')),
  CONSTRAINT http_route_path_one_or_many CHECK (path_prefixes IS NULL OR path_prefix IS NULL),
  CONSTRAINT http_route_path_prefixes_nonempty CHECK (path_prefixes IS NULL OR json_array_length(path_prefixes) > 0),
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
  CONSTRAINT http_route_request_headers_shape CHECK (request_headers IS NULL OR json_type(request_headers) = 'array'),
  -- '^/[A-Za-z0-9._~/%-]*$'
  CONSTRAINT http_route_rewrite_prefix_shape CHECK (
    rewrite_prefix IS NULL OR (rewrite_prefix GLOB '/*' AND rewrite_prefix NOT GLOB '*[^A-Za-z0-9._~/%-]*')),
  CONSTRAINT http_route_source_rules_array CHECK (
    source_rules IS NULL
    OR (json_type(source_rules) = 'array' AND json_array_length(source_rules) >= 1 AND json_array_length(source_rules) <= 20)),
  CONSTRAINT http_routes_action_kind_check CHECK (action_kind IN ('proxy', 'redirect', 'reject')),
  CONSTRAINT http_routes_key_syntax CHECK (
    length(key) BETWEEN 1 AND 63 AND key GLOB '[A-Za-z0-9]*' AND key NOT GLOB '*[^A-Za-z0-9._-]*')
);
CREATE INDEX http_routes_listener_idx ON http_routes (listener_id);

CREATE TABLE passthrough_routes (
  id                 uuid        NOT NULL,
  key                text        NOT NULL,
  listener_id        uuid        NOT NULL,
  listener_protocol  enum_text   NOT NULL CHECK (listener_protocol IN ('http', 'tls_passthrough', 'tcp', 'udp', 'https')),
  snis               text_array  NOT NULL CHECK (json_type(snis) = 'array'),
  priority           int         NOT NULL,
  action_kind        text        NOT NULL,
  pool_id            uuid,
  pool_cls           enum_text   CHECK (pool_cls IS NULL OR pool_cls IN ('http', 'tcp', 'udp')),
  version            int         NOT NULL DEFAULT 1,
  created_at         timestamptz NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at         timestamptz NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_by         text        NOT NULL,
  updated_by         text        NOT NULL,
  revision           bigint      NOT NULL,
  CONSTRAINT passthrough_routes_pkey PRIMARY KEY (id),
  CONSTRAINT passthrough_routes_key_key UNIQUE (key),
  CONSTRAINT pt_route_listener_fk FOREIGN KEY (listener_id, listener_protocol)
    REFERENCES listeners (id, protocol) ON DELETE RESTRICT,
  CONSTRAINT pt_route_pool_fk FOREIGN KEY (pool_id, pool_cls)
    REFERENCES pools (id, protocol_class) ON DELETE RESTRICT,
  CONSTRAINT passthrough_routes_action_kind_check CHECK (action_kind IN ('proxy', 'reject')),
  CONSTRAINT passthrough_routes_key_syntax CHECK (
    length(key) BETWEEN 1 AND 63 AND key GLOB '[A-Za-z0-9]*' AND key NOT GLOB '*[^A-Za-z0-9._-]*'),
  CONSTRAINT pt_route_listener_is_pt CHECK (listener_protocol = 'tls_passthrough'),
  CONSTRAINT pt_route_pool_is_tcp CHECK (pool_cls IS NULL OR pool_cls = 'tcp'),
  CONSTRAINT pt_route_proxy_shape CHECK ((action_kind = 'proxy') = (pool_id IS NOT NULL))
);
CREATE INDEX passthrough_routes_listener_idx ON passthrough_routes (listener_id);

CREATE TABLE sni_certificate_bindings (
  id               uuid        NOT NULL,
  key              text        NOT NULL,
  listener_id      uuid        NOT NULL,
  listener_proto   enum_text   NOT NULL CHECK (listener_proto IN ('http', 'tls_passthrough', 'tcp', 'udp', 'https')),
  certificate_id   uuid        NOT NULL
    CONSTRAINT sni_certificate_bindings_certificate_id_fkey REFERENCES certificates (id) ON DELETE RESTRICT,
  hosts            text_array  NOT NULL CHECK (json_type(hosts) = 'array'),
  ovr_min_version  enum_text   CHECK (ovr_min_version IS NULL OR ovr_min_version IN ('1.2', '1.3')),
  ovr_max_version  enum_text   CHECK (ovr_max_version IS NULL OR ovr_max_version IN ('1.2', '1.3')),
  version          int         NOT NULL DEFAULT 1,
  created_at       timestamptz NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at       timestamptz NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_by       text        NOT NULL,
  updated_by       text        NOT NULL,
  revision         bigint      NOT NULL,
  CONSTRAINT sni_certificate_bindings_pkey PRIMARY KEY (id),
  CONSTRAINT sni_certificate_bindings_key_key UNIQUE (key),
  CONSTRAINT sni_binding_listener_fk FOREIGN KEY (listener_id, listener_proto)
    REFERENCES listeners (id, protocol) ON DELETE CASCADE,
  CONSTRAINT sni_binding_is_https CHECK (listener_proto = 'https'),
  CONSTRAINT sni_binding_range CHECK (
    ovr_max_version IS NULL OR ovr_min_version IS NULL OR ovr_max_version >= ovr_min_version),
  CONSTRAINT sni_certificate_bindings_hosts_check CHECK (json_array_length(hosts) > 0),
  CONSTRAINT sni_certificate_bindings_key_syntax CHECK (
    length(key) BETWEEN 1 AND 63 AND key GLOB '[A-Za-z0-9]*' AND key NOT GLOB '*[^A-Za-z0-9._-]*')
);

-- ── 비밀 재료 ────────────────────────────────────────────────────────────

CREATE TABLE secret_materials (
  scheme        text        NOT NULL,
  name          text        NOT NULL,
  version       text        NOT NULL,
  kek_id        text        NOT NULL,
  wrapped_dek   blob        NOT NULL,
  nonce         blob        NOT NULL,
  ciphertext    blob        NOT NULL,
  sha256        text,
  chain_digest  text,
  key_digest    text        NOT NULL,
  facts         json_text   CHECK (facts IS NULL OR json_valid(facts)),
  created_at    timestamptz NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CONSTRAINT secret_materials_pkey PRIMARY KEY (scheme, name, version),
  CONSTRAINT secret_materials_key_has_no_chain CHECK (
    scheme <> 'key' OR (chain_digest IS NULL AND sha256 IS NULL AND facts IS NULL)),
  CONSTRAINT secret_materials_name_shape CHECK (length(name) >= 1 AND name NOT GLOB '*[^A-Za-z0-9._-]*'),
  CONSTRAINT secret_materials_scheme CHECK (scheme IN ('store', 'key')),
  CONSTRAINT secret_materials_store_has_chain CHECK (
    scheme <> 'store' OR (chain_digest IS NOT NULL AND sha256 IS NOT NULL)),
  CONSTRAINT secret_materials_version_shape CHECK (length(version) = 32 AND version NOT GLOB '*[^a-f0-9]*')
);
CREATE INDEX secret_materials_scheme_idx ON secret_materials (scheme);

-- ── ACME ─────────────────────────────────────────────────────────────────

CREATE TABLE acme_accounts (
  id               uuid        NOT NULL,
  key              text        NOT NULL,
  directory_url    text        NOT NULL,
  contact          text_array  NOT NULL DEFAULT '[]' CHECK (json_type(contact) = 'array'),
  account_key_ref  text        NOT NULL,
  account_url      text,
  tos_agreed_at    timestamptz,
  created_at       timestamptz NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at       timestamptz NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_by       text        NOT NULL,
  CONSTRAINT acme_accounts_pkey PRIMARY KEY (id),
  CONSTRAINT acme_accounts_key_key UNIQUE (key),
  CONSTRAINT acme_account_directory_uq UNIQUE (directory_url),
  -- '^key://[A-Za-z0-9._-]+@[a-f0-9]{16,64}$'
  CONSTRAINT acme_accounts_account_key_ref_check CHECK (
    account_key_ref GLOB 'key://*'
    AND instr(substr(account_key_ref, 7), '@') > 1
    AND substr(account_key_ref, 7, instr(substr(account_key_ref, 7), '@') - 1) NOT GLOB '*[^A-Za-z0-9._-]*'
    AND length(substr(account_key_ref, 7 + instr(substr(account_key_ref, 7), '@'))) BETWEEN 16 AND 64
    AND substr(account_key_ref, 7 + instr(substr(account_key_ref, 7), '@')) NOT GLOB '*[^a-f0-9]*')
);

CREATE TABLE acme_orders (
  id               uuid        NOT NULL,
  account_id       uuid        NOT NULL CONSTRAINT acme_orders_account_id_fkey REFERENCES acme_accounts (id) ON DELETE RESTRICT,
  certificate_id   uuid        NOT NULL CONSTRAINT acme_orders_certificate_id_fkey REFERENCES certificates (id) ON DELETE CASCADE,
  domains          text_array  NOT NULL CHECK (json_type(domains) = 'array'),
  state            enum_text   NOT NULL DEFAULT 'pending'
                     CHECK (state IN ('pending', 'validating', 'ready', 'issued', 'failed', 'abandoned')),
  order_url        text,
  finalize_url     text,
  certificate_url  text,
  issued_ref       text,
  cert_key_ref     text,
  attempts         int         NOT NULL DEFAULT 0,
  next_attempt_at  timestamptz NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_error       text,
  expires_at       timestamptz,
  claimed_by       text,
  claimed_until    timestamptz,
  created_at       timestamptz NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at       timestamptz NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CONSTRAINT acme_orders_pkey PRIMARY KEY (id),
  CONSTRAINT acme_order_claim_shape CHECK ((claimed_by IS NULL) = (claimed_until IS NULL)),
  CONSTRAINT acme_order_issued_has_ref CHECK (
    state <> 'issued' OR (issued_ref IS NOT NULL AND cert_key_ref IS NOT NULL)),
  CONSTRAINT acme_order_terminal_unclaimed CHECK (state NOT IN ('issued', 'abandoned') OR claimed_by IS NULL),
  CONSTRAINT acme_orders_cert_key_ref_check CHECK (
    cert_key_ref IS NULL
    OR (cert_key_ref GLOB 'key://*'
        AND instr(substr(cert_key_ref, 7), '@') > 1
        AND substr(cert_key_ref, 7, instr(substr(cert_key_ref, 7), '@') - 1) NOT GLOB '*[^A-Za-z0-9._-]*'
        AND length(substr(cert_key_ref, 7 + instr(substr(cert_key_ref, 7), '@'))) BETWEEN 16 AND 64
        AND substr(cert_key_ref, 7 + instr(substr(cert_key_ref, 7), '@')) NOT GLOB '*[^a-f0-9]*')),
  CONSTRAINT acme_orders_domains_check CHECK (json_array_length(domains) > 0),
  CONSTRAINT acme_orders_issued_ref_check CHECK (
    issued_ref IS NULL
    OR (issued_ref GLOB 'store://*'
        AND instr(substr(issued_ref, 9), '@') > 1
        AND substr(issued_ref, 9, instr(substr(issued_ref, 9), '@') - 1) NOT GLOB '*[^A-Za-z0-9._-]*'
        AND length(substr(issued_ref, 9 + instr(substr(issued_ref, 9), '@'))) BETWEEN 16 AND 64
        AND substr(issued_ref, 9 + instr(substr(issued_ref, 9), '@')) NOT GLOB '*[^a-f0-9]*'))
);
CREATE INDEX acme_order_due_idx ON acme_orders (next_attempt_at)
  WHERE state IN ('pending', 'validating', 'ready', 'failed');
CREATE UNIQUE INDEX acme_order_live_uq ON acme_orders (certificate_id)
  WHERE state IN ('pending', 'validating', 'ready', 'failed');

CREATE TABLE acme_challenges (
  id             uuid        NOT NULL,
  order_id       uuid        NOT NULL CONSTRAINT acme_challenges_order_id_fkey REFERENCES acme_orders (id) ON DELETE CASCADE,
  domain         text        NOT NULL,
  type           enum_text   NOT NULL CHECK (type IN ('http-01', 'dns-01')),
  token          text        NOT NULL,
  value          text        NOT NULL,
  authz_url      text        NOT NULL,
  challenge_url  text        NOT NULL,
  placed_at      timestamptz,
  cleaned_at     timestamptz,
  created_at     timestamptz NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CONSTRAINT acme_challenges_pkey PRIMARY KEY (id),
  CONSTRAINT acme_challenge_uq UNIQUE (order_id, domain, type),
  CONSTRAINT acme_challenge_clean_after_place CHECK (cleaned_at IS NULL OR placed_at IS NOT NULL)
);
CREATE INDEX acme_challenge_orphan_idx ON acme_challenges (placed_at)
  WHERE placed_at IS NOT NULL AND cleaned_at IS NULL;

-- ── 주소 집합 ────────────────────────────────────────────────────────────

CREATE TABLE address_sets (
  id              uuid        NOT NULL,
  key             text        NOT NULL,
  cidrs           text_array  NOT NULL CHECK (json_type(cidrs) = 'array'),
  source          text,
  version         int         NOT NULL DEFAULT 1,
  created_at      timestamptz NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at      timestamptz NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_by      text        NOT NULL,
  updated_by      text        NOT NULL,
  revision        bigint      NOT NULL,
  source_options  json_text   CHECK (source_options IS NULL OR json_valid(source_options)),
  CONSTRAINT address_sets_pkey PRIMARY KEY (id),
  CONSTRAINT address_sets_key_key UNIQUE (key),
  CONSTRAINT address_set_nonempty CHECK (json_array_length(cidrs) > 0),
  -- '^[a-z][a-z0-9-]{0,31}$'
  CONSTRAINT address_set_source CHECK (
    source IS NULL OR (length(source) BETWEEN 1 AND 32 AND source GLOB '[a-z]*' AND source NOT GLOB '*[^a-z0-9-]*')),
  CONSTRAINT address_set_source_options CHECK (
    source_options IS NULL OR (source IS NOT NULL AND json_type(source_options) = 'object')),
  CONSTRAINT address_sets_key_syntax CHECK (
    length(key) BETWEEN 1 AND 63 AND key GLOB '[A-Za-z0-9]*' AND key NOT GLOB '*[^A-Za-z0-9._-]*')
);

CREATE TABLE address_set_refresh (
  key           text        NOT NULL,
  checked_at    timestamptz NOT NULL,
  ok            boolean     NOT NULL,
  reason        text,
  detail        text,
  refreshed_at  timestamptz,
  revision      bigint,
  by_actor      text        NOT NULL,
  CONSTRAINT address_set_refresh_pkey PRIMARY KEY (key)
);

-- ── 최초 리비전 — 빈 모델 ────────────────────────────────────────────────
--
-- head 가 가리킬 곳이 처음부터 있어야 changeset 의 `base_revision` FK 가 성립한다(PG 001 과 같다).
INSERT INTO config_revisions (revision, model, created_by, note)
VALUES (1, '{"listeners":[],"httpRoutes":[],"passthroughRoutes":[],"pools":[],"backends":[]}',
        'system', '최초 리비전 — 빈 모델');
INSERT INTO config_head (revision) VALUES (1);
