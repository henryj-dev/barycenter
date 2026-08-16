-- barycenter v0.1 정본 스키마 (DESIGN.md §4.0, §5.3, §11.2)
--
-- **제약을 어디서 강제하는가** — §4.0 이 층을 셋으로 나눴고, 여기서는 아래 둘을 진다.
--
--   단일 행 안의 필드 조합            → `CHECK`            (이 파일)
--   리스너 protocol ↔ 풀 protocol_class → **복합 FK**        (이 파일)
--   소켓 겹침·라우트 그림자·그래프     → 트랜잭션 검증기     (커밋 트랜잭션 안)
--
-- 복합 FK 가 핵심 수법이다. `(pool_id, pool_protocol_class)` 로 풀의 `(id, protocol_class)`
-- 를 참조하면, 비정규화한 클래스 컬럼이 **풀의 실제 클래스와 다를 수 없다.** 거기에
-- CHECK 를 하나 더 걸면 "http 라우트는 http 풀만" 이 **DB 의 보장**이 된다. 애플리케이션이
-- 잊어도 안 뚫린다. `CHECK` 만으로는 다른 행을 볼 수 없어서 이렇게 우회한다.

CREATE TYPE protocol_class     AS ENUM ('http', 'tcp', 'udp');
CREATE TYPE listener_protocol  AS ENUM ('http', 'tls_passthrough', 'tcp', 'udp');
CREATE TYPE algorithm          AS ENUM ('round_robin', 'source_ip_hash', 'hash');
CREATE TYPE udp_preset         AS ENUM ('dns', 'wireguard', 'game_generic', 'custom');
CREATE TYPE changeset_state    AS ENUM ('open', 'sealed', 'committed', 'discarded');
CREATE TYPE plan_state         AS ENUM ('planned', 'committed', 'operation_bound',
                                        'applied', 'expired', 'superseded', 'failed');

-- ── 전역 좌표 ────────────────────────────────────────────────────────────
--
-- `config_head` 는 **한 행짜리 테이블**이다. 커밋 트랜잭션이 이 행을 `FOR UPDATE` 로 잡고
-- `base_revision == head` 를 검사하므로, 동시 커밋 둘 중 하나는 반드시 진다 (§5.3).
-- `MAX(revision)` 으로 대신하면 잠글 행이 없어 두 커밋이 같은 base 위에 겹쳐 앉는다.
CREATE TABLE config_head (
  only_one  boolean PRIMARY KEY DEFAULT true CHECK (only_one),
  revision  bigint  NOT NULL
);

CREATE SEQUENCE config_revision_seq AS bigint START 1;

-- **`activation_epoch` 는 절대 재사용하지 않는다** (§3.3-1, S11·S19).
-- 리비전과 **별개의** 시퀀스여야 한다. 롤백은 옛 리비전의 내용으로 새 리비전을 만들지만,
-- epoch 는 그와 무관하게 앞으로만 간다. 한 시퀀스를 공유하면 롤백에서 둘이 얽힌다.
CREATE SEQUENCE activation_epoch_seq AS bigint START 1;

CREATE TABLE config_revisions (
  revision     bigint      PRIMARY KEY,
  parent       bigint      REFERENCES config_revisions(revision),
  -- §5.3 — 롤백은 head 를 뒤로 옮기지 않는다. 옛 내용으로 **새 리비전**을 만들고 여기 적는다.
  rollback_of  bigint      REFERENCES config_revisions(revision),
  -- 검증을 통과한 `Model` 스냅샷. **불변이다.**
  --
  -- 정규화 테이블은 head 상태를 들고, 리비전은 그 시점의 완성된 모델을 통째로 든다.
  -- 둘 다 필요하다 — 정규화 쪽은 제약과 ETag 를, 스냅샷 쪽은 **롤백 자료**를 진다.
  -- 스냅샷 없이 정규화 테이블만 두면 과거 모델을 재구성해야 하고, 그건 §7.2 가 세대를
  -- 자기완결적으로 만든 이유와 정확히 반대다.
  model        jsonb       NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  created_by   text        NOT NULL,
  note         text,
  CHECK (rollback_of IS NULL OR rollback_of < revision)
);

-- ── 리소스 (head 상태) ───────────────────────────────────────────────────

CREATE TABLE pools (
  id                   uuid           PRIMARY KEY,
  key                  text           NOT NULL UNIQUE,
  name                 text           NOT NULL,
  protocol_class       protocol_class NOT NULL,
  algorithm            algorithm      NOT NULL,
  hash_key             text,
  send_proxy_protocol  text,
  version              integer        NOT NULL DEFAULT 1,
  created_at           timestamptz    NOT NULL DEFAULT now(),
  updated_at           timestamptz    NOT NULL DEFAULT now(),
  created_by           text           NOT NULL,
  updated_by           text           NOT NULL,
  revision             bigint         NOT NULL,

  -- `algorithm=hash` 일 때만 `hash_key` 가 있다. 양방향으로 건다 — 한쪽만 걸면
  -- round_robin 인데 hash_key 가 남아 있는 행이 통과하고, 그건 나중에 알고리즘을
  -- 바꿀 때 **아무도 의도하지 않은 키로** 되살아난다.
  CONSTRAINT pool_hash_key_iff CHECK ((algorithm = 'hash') = (hash_key IS NOT NULL)),
  -- §4.7 — http 는 엔진에 송신 디렉티브가 없고 udp 는 미지원. tcp 만이다.
  CONSTRAINT pool_send_pp_tcp_only CHECK (
    send_proxy_protocol IS NULL
    OR (send_proxy_protocol = 'v1' AND protocol_class = 'tcp')
  ),
  -- **복합 FK 의 참조 대상.** 이게 있어야 다른 테이블이 `(id, protocol_class)` 를 건다.
  CONSTRAINT pool_id_class_uq UNIQUE (id, protocol_class)
);

CREATE TABLE backends (
  id          uuid        PRIMARY KEY,
  key         text        NOT NULL UNIQUE,
  -- §4.0 — Pool → Backend 는 CASCADE. 백엔드는 풀 없이 존재할 의미가 없다.
  pool_id     uuid        NOT NULL REFERENCES pools(id) ON DELETE CASCADE,
  host        text        NOT NULL CHECK (host <> ''),
  port        integer     NOT NULL CHECK (port BETWEEN 1 AND 65535),
  weight      integer     NOT NULL CHECK (weight >= 0),
  enabled     boolean     NOT NULL DEFAULT true,
  version     integer     NOT NULL DEFAULT 1,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  created_by  text        NOT NULL,
  updated_by  text        NOT NULL,
  revision    bigint      NOT NULL
);
CREATE INDEX backends_pool_idx ON backends(pool_id);

CREATE TABLE listeners (
  id                     uuid              PRIMARY KEY,
  key                    text              NOT NULL UNIQUE,
  name                   text              NOT NULL,
  protocol               listener_protocol NOT NULL,
  bind                   text              NOT NULL CHECK (bind <> ''),
  port                   integer           NOT NULL CHECK (port BETWEEN 1 AND 65535),
  enabled                boolean           NOT NULL DEFAULT true,
  accept_proxy_protocol  boolean,
  udp_preset             udp_preset,
  -- 'reject' | {"pool": "..."} — 풀 참조는 아래 default_pool_id 로 **따로** 건다.
  http_default_pool_id   uuid,
  http_default_pool_cls  protocol_class,
  http_default_reject    boolean,
  on_unmatched_sni_pool  uuid,
  on_unmatched_sni_cls   protocol_class,
  on_unmatched_sni_reject boolean,
  preread_timeout_s      integer CHECK (preread_timeout_s IS NULL OR preread_timeout_s > 0),
  default_pool_id        uuid,
  default_pool_cls       protocol_class,
  version                integer     NOT NULL DEFAULT 1,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  created_by             text        NOT NULL,
  updated_by             text        NOT NULL,
  revision               bigint      NOT NULL,

  -- **복합 FK.** 풀의 실제 클래스와 여기 적힌 클래스가 다를 수 없다.
  CONSTRAINT listener_default_pool_fk FOREIGN KEY (default_pool_id, default_pool_cls)
    REFERENCES pools(id, protocol_class) ON DELETE RESTRICT,
  CONSTRAINT listener_http_pool_fk FOREIGN KEY (http_default_pool_id, http_default_pool_cls)
    REFERENCES pools(id, protocol_class) ON DELETE RESTRICT,
  CONSTRAINT listener_sni_pool_fk FOREIGN KEY (on_unmatched_sni_pool, on_unmatched_sni_cls)
    REFERENCES pools(id, protocol_class) ON DELETE RESTRICT,
  -- **복합 FK 의 참조 대상** — 라우트가 `(listener_id, protocol)` 을 건다.
  CONSTRAINT listener_id_protocol_uq UNIQUE (id, protocol),

  -- 프로토콜별로 **표현 가능한 필드가 다르다** (§4.1 판별 유니온). TypeScript 는 이걸
  -- 컴파일 타임에 막지만 DB 로 직접 들어오는 경로에서는 못 막는다. 같은 규칙을 여기서
  -- 다시 건다 — 5차 검수가 "UDP 리스너에 acceptProxyProtocol" 로 재현한 조합이다.
  CONSTRAINT listener_http_shape CHECK (protocol <> 'http' OR (
    udp_preset IS NULL AND default_pool_id IS NULL
    AND on_unmatched_sni_pool IS NULL AND on_unmatched_sni_reject IS NULL
    AND preread_timeout_s IS NULL)),
  CONSTRAINT listener_passthrough_shape CHECK (protocol <> 'tls_passthrough' OR (
    udp_preset IS NULL AND default_pool_id IS NULL
    AND http_default_pool_id IS NULL AND http_default_reject IS NULL)),
  CONSTRAINT listener_tcp_shape CHECK (protocol <> 'tcp' OR (
    udp_preset IS NULL AND default_pool_id IS NOT NULL
    AND http_default_pool_id IS NULL AND http_default_reject IS NULL
    AND on_unmatched_sni_pool IS NULL AND on_unmatched_sni_reject IS NULL
    AND preread_timeout_s IS NULL)),
  CONSTRAINT listener_udp_shape CHECK (protocol <> 'udp' OR (
    udp_preset IS NOT NULL AND default_pool_id IS NOT NULL
    AND accept_proxy_protocol IS NULL
    AND http_default_pool_id IS NULL AND http_default_reject IS NULL
    AND on_unmatched_sni_pool IS NULL AND on_unmatched_sni_reject IS NULL
    AND preread_timeout_s IS NULL)),

  -- 리스너 protocol ↔ 풀 클래스. `tls_passthrough` 는 TLS 를 종단하지 않으므로 **tcp** 다.
  CONSTRAINT listener_default_pool_class CHECK (
    default_pool_cls IS NULL
    OR (protocol = 'udp' AND default_pool_cls = 'udp')
    OR (protocol = 'tcp' AND default_pool_cls = 'tcp')),
  CONSTRAINT listener_http_pool_class CHECK (
    http_default_pool_cls IS NULL OR http_default_pool_cls = 'http'),
  CONSTRAINT listener_sni_pool_class CHECK (
    on_unmatched_sni_cls IS NULL OR on_unmatched_sni_cls = 'tcp'),

  -- 'reject' 와 {pool} 은 **둘 중 하나**다. 둘 다이거나 둘 다 아니면 어느 쪽으로 렌더할지
  -- 알 수 없다 — 판별 유니온을 컬럼으로 편 대가라 여기서 되찾는다.
  CONSTRAINT listener_http_action_xor CHECK (
    (http_default_reject IS TRUE)::int + (http_default_pool_id IS NOT NULL)::int <= 1),
  CONSTRAINT listener_sni_action_xor CHECK (
    (on_unmatched_sni_reject IS TRUE)::int + (on_unmatched_sni_pool IS NOT NULL)::int <= 1),
  -- 켜져 있지도 않은 플래그를 false 로 적어 두면 "설정 안 함" 과 구분이 안 된다.
  CONSTRAINT listener_reject_flags CHECK (
    (http_default_reject IS NOT FALSE) AND (on_unmatched_sni_reject IS NOT FALSE))
);

-- §4.2 — 라우트는 **프로토콜별로 분리한다.** 한 테이블에 합치면 hosts 와 snis 가
-- 서로의 NULL 을 견디는 모양이 되고, 그러면 "http 라우트에 sni" 를 막을 수가 없다.
CREATE TABLE http_routes (
  id           uuid              PRIMARY KEY,
  key          text              NOT NULL UNIQUE,
  listener_id  uuid              NOT NULL,
  listener_protocol listener_protocol NOT NULL,
  hosts        text[]            NOT NULL,
  priority     integer           NOT NULL,
  path_prefix  text,
  -- 'proxy' | 'redirect' | 'reject'
  action_kind  text              NOT NULL CHECK (action_kind IN ('proxy','redirect','reject')),
  pool_id      uuid,
  pool_cls     protocol_class,
  websocket    boolean,
  redirect_to  text,
  status       integer,
  version      integer     NOT NULL DEFAULT 1,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  created_by   text        NOT NULL,
  updated_by   text        NOT NULL,
  revision     bigint      NOT NULL,

  -- §4.0 — Listener → Route 는 RESTRICT. 라우트를 남기고 리스너를 지우면 조용히
  -- 아무 데도 안 걸리는 라우트가 된다.
  CONSTRAINT http_route_listener_fk FOREIGN KEY (listener_id, listener_protocol)
    REFERENCES listeners(id, protocol) ON DELETE RESTRICT,
  CONSTRAINT http_route_pool_fk FOREIGN KEY (pool_id, pool_cls)
    REFERENCES pools(id, protocol_class) ON DELETE RESTRICT,
  -- **복합 FK + CHECK 로 "http 라우트는 http 리스너에만" 이 DB 보장이 된다.**
  CONSTRAINT http_route_listener_is_http CHECK (listener_protocol = 'http'),
  CONSTRAINT http_route_pool_is_http     CHECK (pool_cls IS NULL OR pool_cls = 'http'),

  CONSTRAINT http_route_proxy_shape CHECK (action_kind <> 'proxy' OR (
    pool_id IS NOT NULL AND websocket IS NOT NULL
    AND redirect_to IS NULL AND status IS NULL)),
  CONSTRAINT http_route_redirect_shape CHECK (action_kind <> 'redirect' OR (
    redirect_to IS NOT NULL AND status IN (301,302,307,308)
    AND pool_id IS NULL AND websocket IS NULL)),
  CONSTRAINT http_route_reject_shape CHECK (action_kind <> 'reject' OR (
    status IN (403,404,444) AND pool_id IS NULL
    AND websocket IS NULL AND redirect_to IS NULL))
);
CREATE INDEX http_routes_listener_idx ON http_routes(listener_id);

CREATE TABLE passthrough_routes (
  id           uuid              PRIMARY KEY,
  key          text              NOT NULL UNIQUE,
  listener_id  uuid              NOT NULL,
  listener_protocol listener_protocol NOT NULL,
  snis         text[]            NOT NULL,
  priority     integer           NOT NULL,
  action_kind  text              NOT NULL CHECK (action_kind IN ('proxy','reject')),
  pool_id      uuid,
  pool_cls     protocol_class,
  version      integer     NOT NULL DEFAULT 1,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  created_by   text        NOT NULL,
  updated_by   text        NOT NULL,
  revision     bigint      NOT NULL,

  CONSTRAINT pt_route_listener_fk FOREIGN KEY (listener_id, listener_protocol)
    REFERENCES listeners(id, protocol) ON DELETE RESTRICT,
  CONSTRAINT pt_route_pool_fk FOREIGN KEY (pool_id, pool_cls)
    REFERENCES pools(id, protocol_class) ON DELETE RESTRICT,
  CONSTRAINT pt_route_listener_is_pt CHECK (listener_protocol = 'tls_passthrough'),
  -- 패스스루는 TLS 를 종단하지 않고 흘리므로 목적지는 **tcp** 풀이다.
  CONSTRAINT pt_route_pool_is_tcp    CHECK (pool_cls IS NULL OR pool_cls = 'tcp'),
  CONSTRAINT pt_route_proxy_shape    CHECK ((action_kind = 'proxy') = (pool_id IS NOT NULL))
);
CREATE INDEX passthrough_routes_listener_idx ON passthrough_routes(listener_id);

-- ── changeset → plan → commit → apply (§5.3) ─────────────────────────────

CREATE TABLE changesets (
  id                 uuid            PRIMARY KEY,
  base_revision      bigint          NOT NULL REFERENCES config_revisions(revision),
  state              changeset_state NOT NULL DEFAULT 'open',
  -- 누적된 변경. `[{op:'put'|'delete', kind, key, body?}]`
  patch              jsonb           NOT NULL DEFAULT '[]'::jsonb,
  created_at         timestamptz     NOT NULL DEFAULT now(),
  created_by         text            NOT NULL,
  sealed_at          timestamptz,
  committed_revision bigint          REFERENCES config_revisions(revision),

  CONSTRAINT changeset_sealed_at CHECK ((state = 'open') = (sealed_at IS NULL)
                                        OR state IN ('committed','discarded')),
  CONSTRAINT changeset_committed CHECK ((state = 'committed') = (committed_revision IS NOT NULL))
);

CREATE TABLE plans (
  id               uuid        PRIMARY KEY,
  changeset_id     uuid        NOT NULL REFERENCES changesets(id) ON DELETE CASCADE,
  state            plan_state  NOT NULL DEFAULT 'planned',
  base_revision    bigint      NOT NULL,
  model            jsonb       NOT NULL,
  impact           jsonb       NOT NULL,
  render_digest    text        NOT NULL,
  renderer_version text        NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  -- **TTL 은 `planned` 에만 걸린다** (§5.3). 커밋된 artifact 는 롤백 수단이므로
  -- 보존 기간이 끝날 때까지 안 지운다 — 24시간 뒤 되돌릴 방법이 사라지는 상황을 안 만든다.
  expires_at       timestamptz NOT NULL,
  -- **커밋 순간에 예약된다.** 그 전에는 NULL 이다 (§5.3 — plan 시점에는 할당 규칙이 없다).
  target_revision  bigint      REFERENCES config_revisions(revision),
  activation_epoch bigint,

  CONSTRAINT plan_reserved_together CHECK (
    (target_revision IS NULL) = (activation_epoch IS NULL)),
  -- `planned` 는 아직 예약 전, 그 뒤 상태는 전부 예약 후다.
  CONSTRAINT plan_reserved_when_committed CHECK (
    state = 'planned' OR state = 'expired' OR target_revision IS NOT NULL)
);
CREATE INDEX plans_changeset_idx ON plans(changeset_id);

-- **`(plan_id → operation_id)` 는 unique** (§5.3). 같은 plan 으로 다시 apply 하면
-- 새 오퍼레이션이 아니라 **같은 것을 돌려준다.** 멱등성이 DB 제약이다.
CREATE TABLE operations (
  id               uuid        PRIMARY KEY,
  plan_id          uuid        NOT NULL UNIQUE REFERENCES plans(id),
  revision         bigint      NOT NULL REFERENCES config_revisions(revision),
  activation_epoch bigint      NOT NULL,
  generation       text        NOT NULL,
  phase            text        NOT NULL,
  detail           jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  created_by       text        NOT NULL
);

-- ── 감사 (§5.1 — 모든 변경은 who/what/before/after/revision) ──────────────
CREATE TABLE audit (
  id         bigserial   PRIMARY KEY,
  at         timestamptz NOT NULL DEFAULT now(),
  principal  text        NOT NULL,
  action     text        NOT NULL,
  subject    text        NOT NULL,
  before     jsonb,
  after      jsonb,
  revision   bigint
);
CREATE INDEX audit_at_idx ON audit(at DESC);

-- ── 최초 리비전 — 빈 모델 ────────────────────────────────────────────────
--
-- head 가 가리킬 곳이 처음부터 있어야 changeset 의 `base_revision` FK 가 성립한다.
-- "아직 아무것도 없음" 을 NULL 로 표현하면 모든 경로에 NULL 분기가 생긴다.
INSERT INTO config_revisions (revision, model, created_by, note)
VALUES (nextval('config_revision_seq'),
        '{"listeners":[],"httpRoutes":[],"passthroughRoutes":[],"pools":[],"backends":[]}'::jsonb,
        'system', '최초 리비전 — 빈 모델');
INSERT INTO config_head (revision) VALUES (currval('config_revision_seq'));
