-- 001_init.sql
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

-- 002_leader.sql
-- 리더 선출 (DESIGN.md §3.5)
--
-- **토큰은 리비전·epoch 와 또 다른 시퀀스다.** 셋을 섞으면 안 된다 —
-- 리비전은 설정이 몇 번 바뀌었나, epoch 는 활성화가 몇 번 일어났나, 토큰은 리더가 몇 번
-- 바뀌었나다. 한 시퀀스를 나눠 쓰면 한쪽이 다른 쪽을 밀어 올려 "리더가 안 바뀌었는데
-- 토큰이 뛰었다" 같은 상태가 생기고, 그러면 토큰이 무슨 뜻인지 아무도 말할 수 없다.
CREATE SEQUENCE leader_token_seq AS bigint START 1;

-- 누가 언제 리더였나. **선출의 정본이 아니다** — 정본은 advisory lock 이고 이 표는
-- 관측용이다. 표를 정본으로 삼으면 "표는 A 인데 락은 B" 인 순간이 반드시 생긴다.
CREATE TABLE leadership (
  token       bigint      PRIMARY KEY,
  holder      text        NOT NULL,
  acquired_at timestamptz NOT NULL DEFAULT now(),
  -- 자발적으로 놓았을 때만 채워진다. 죽어서 풀린 락은 여기가 NULL 로 남는다 —
  -- **그게 정보다.** 깨끗하게 물러난 것과 죽은 것을 구분할 수 있어야 한다.
  released_at timestamptz
);
CREATE INDEX leadership_acquired_idx ON leadership(acquired_at DESC);

-- 003_rollback.sql
-- 롤백 (DESIGN.md §5.3)
--
-- **롤백 plan 에는 changeset 이 없다.** changeset 은 *사람이 편집을 누적하는 그릇*이고,
-- 롤백은 편집이 아니라 "그 시점의 모델을 그대로 되살린다" 이다. 억지로 빈 changeset 을
-- 하나 만들어 붙이면 감사 로그에 아무도 안 만든 changeset 이 쌓이고, "이 changeset 은
-- 누가 만들었나" 에 답할 수 없게 된다.
ALTER TABLE plans ALTER COLUMN changeset_id DROP NOT NULL;

-- 롤백 대상은 **과거여야 한다.** `rollback_of < revision` 은 001 에서 이미 걸었고,
-- 여기서는 한 리비전이 자기 자신을 롤백 대상으로 삼는 것까지 막는다.
ALTER TABLE config_revisions
  ADD CONSTRAINT revision_not_self_rollback CHECK (rollback_of IS NULL OR rollback_of <> revision);

-- 004_proxy_trust.sql
-- 인바운드 PROXY 수신에 **신뢰 경계**를 붙인다 (DESIGN.md §4.7)
--
-- 지금까지 `accept_proxy_protocol boolean` 이었다. 즉 **"켠다" 를 신뢰 경계 없이 표현할
-- 수 있었다.** 엔진으로 실측한 결과(E63) 그게 왜 위험한지가 분명하다:
--
--   realip 없음   $remote_addr = 실제 peer,  $proxy_protocol_addr = **헤더가 말하는 값**
--   peer 신뢰     $remote_addr = 헤더 값
--   peer 불신     $remote_addr = **실제 peer** (헤더가 뭐라 하든)
--
-- **`$proxy_protocol_addr` 는 어떤 경우에도 게이팅되지 않는다.** 그런데 렌더러는 그
-- 변수로 소스IP 해시를 계산했다 — 클라이언트가 자기를 원하는 백엔드로 몰 수 있었다.
--
-- **켜져 있던 것은 꺼진다.** 신뢰 경계를 지어낼 수 없기 때문이다. 임의의 기본값
-- (`0.0.0.0/0` 같은)을 넣으면 "아무나 믿는다" 를 조용히 굳히는 셈이고, 그건 지금 고치려는
-- 바로 그 상태다. 쓰던 배포는 **다시 선언해야 한다** — 그게 이 마이그레이션의 요점이다.

ALTER TABLE listeners ADD COLUMN accept_proxy_cidrs text[];

-- 옛 값은 옮기지 않는다. 위 주석의 이유로 **의도적으로** 버린다.
ALTER TABLE listeners DROP CONSTRAINT listener_udp_shape;
ALTER TABLE listeners DROP COLUMN accept_proxy_protocol;

ALTER TABLE listeners ADD CONSTRAINT listener_udp_shape CHECK (protocol <> 'udp' OR (
  udp_preset IS NOT NULL AND default_pool_id IS NOT NULL
  AND accept_proxy_cidrs IS NULL
  AND http_default_pool_id IS NULL AND http_default_reject IS NULL
  AND on_unmatched_sni_pool IS NULL AND on_unmatched_sni_reject IS NULL
  AND preread_timeout_s IS NULL));

-- **빈 배열은 켠 것도 끈 것도 아니다.** 아무도 안 믿을 거면 켜지 않는다.
ALTER TABLE listeners ADD CONSTRAINT listener_proxy_cidrs_nonempty CHECK (
  accept_proxy_cidrs IS NULL OR cardinality(accept_proxy_cidrs) > 0);

-- 005_operation_envelope.sql
-- 오퍼레이션 봉투를 보관한다 (DESIGN.md §5.2 `/operations/{id}/cancel`, §9.2)
--
-- `abortConfig` 는 **`ApplyOperation` 을 통째로** 받는다. 봉투와 epoch 만으로 튜플을
-- 재구성하면 정본 튜플이 달라져 슬롯의 주인으로 인정받지 못하고, 그러면 abort 가
-- 아무것도 못 지운다 — 드라이버 계약이 그 이유를 명시해 뒀다.
--
-- 그래서 취소하려면 **낼 때 쓴 그 봉투**가 있어야 한다. 재구성하지 않고 보관한다.
ALTER TABLE operations ADD COLUMN envelope jsonb;

-- 006_health.sql
-- 헬스 이벤트 로그 (DESIGN.md §6.5 · §6.6)
--
-- **이벤트 로그가 단일 정본이다.** 슬롯은 커서만 갖는다 (§6.5 abort 항). 그래야 abort 가
-- 이벤트를 옮기지 않고 staged 슬롯과 커서만 버리면 된다 — 옮기면 중복·역순 적용이 된다.

CREATE TYPE health_state AS ENUM ('healthy', 'unhealthy', 'unknown');

-- **커서는 `nextval` 이 아니다.**
--
-- §6.6 이 반례를 적어 뒀다: `nextval` 은 커밋 순서와 다르다.
--
--   T1: nextval → 100, 아직 커밋 안 함
--   T2: nextval → 101, 커밋 → cut = 101
--   T1: 뒤늦게 커밋 → replay 는 > 101 만 보므로 **100 이 영구 누락**
--
-- 잠금 행으로 발급하면 번호 순서 = 커밋 순서다. 직렬화 비용을 내고 정확성을 산다 —
-- 헬스 이벤트는 초당 수천 건이 아니라 백엔드 수 × 프로브 주기다.
CREATE TABLE health_cursor (
  only_one boolean PRIMARY KEY DEFAULT true CHECK (only_one),
  next_seq bigint NOT NULL DEFAULT 1
);
INSERT INTO health_cursor DEFAULT VALUES;

CREATE TABLE health_events (
  seq          bigint       PRIMARY KEY,
  backend_key  text         NOT NULL,
  state        health_state NOT NULL,
  at           timestamptz  NOT NULL DEFAULT now(),
  detail       text
);
CREATE INDEX health_events_backend_idx ON health_events(backend_key, seq DESC);

-- 백엔드별 **현재 판정**과 관측 좌표 (§6.6 "헬스 관측에도 ABA 가 있다").
--
-- 같은 백엔드·같은 host:port·같은 프로브 설정이어도, **먼저 시작한 프로브가 나중에 시작한
-- 것보다 늦게 끝나면** 낡은 결과가 최신 상태를 덮는다. 그래서 관측 좌표를 싣고 CAS 한다 —
-- `probe_start_seq` 가 마지막 반영값보다 클 때만 적용한다.
CREATE TABLE backend_health (
  backend_key     text         PRIMARY KEY,
  state           health_state NOT NULL DEFAULT 'unknown',
  -- 이 판정을 만든 프로브 실행의 시작 순번. **백엔드별 단조**.
  probe_start_seq bigint       NOT NULL DEFAULT 0,
  -- **직전 관측의 결과**와 그 결과가 몇 번 연속됐는가.
  --
  -- 처음엔 `consecutive` 만 두고 "상태가 같은가" 로 셌는데 **그건 다른 것을 센다** —
  -- 상태가 `healthy` 인 동안 실패가 몇 번 이어져도 매번 1 로 리셋돼 임계값에 영원히
  -- 도달하지 못했다. 프로버가 `ECONNREFUSED` 를 보고 있는데 판정은 `healthy` 로 굳었다.
  -- 세는 것은 **결과의 연속**이지 상태의 연속이 아니다.
  last_ok         boolean      NOT NULL DEFAULT true,
  consecutive     integer      NOT NULL DEFAULT 0,
  observed_at     timestamptz  NOT NULL DEFAULT now(),
  detail          text
);

-- 007_https_enum.sql
-- v0.6 — TLS 종단 (DESIGN.md §4.6, §4.8, §8.1, §12.0 S16·S17)
--
-- `https` 리스너 프로토콜이 돌아온다. 한동안 일부러 빼 뒀던 것인데, 되살리는 조건으로
-- 걸어 둔 S16(SNI 별 TLS policy)·S17(인증서 선택)이 통과했다.
--
-- ── 개인키는 여기 없다 ──────────────────────────────────────────────────
--
-- §4.8 이 못 박았다: *"개인키는 메인 DB 에 평문으로 두지 않는다. SecretStore 드라이버
-- 경유, **불변 버전 참조.**"* 그래서 `certificates` 는 **메타데이터 테이블**이다 —
-- `material_ref` 가 `store://<name>@<version>` 이고 자료는 그 뒤에 있다.
--
-- 왜 버전이 참조에 붙어야 하는가는 S8 이 실측했다. 이름만으로 가리키면 갱신이 덮어써서,
-- conf 를 롤백해도 **갱신된 인증서가 그대로 제시된다.** 롤백이 거짓말이 된다. CHECK 로
-- 모양을 강제해서, 버전 없는 참조가 **DB 에 들어올 수 없게** 한다.

-- **이 마이그레이션은 이것 하나만 한다.**
--
-- PostgreSQL 은 `ALTER TYPE ... ADD VALUE` 로 추가한 enum 값을 **같은 트랜잭션 안에서
-- 쓰지 못한다** (`unsafe use of new value of enum type`). 그런데 이 저장소는 마이그레이션
-- 하나를 한 트랜잭션으로 돌린다 — 스키마가 반쯤 적용된 상태를 남기지 않으려고 그렇게
-- 정했다. 그래서 `'https'` 를 **참조하는** DDL 은 008 로 넘긴다.
--
-- 한 파일에 몰아 놓으면 로컬에서는 조용히 통과하는 것처럼 보이다가 실제 배포에서 깨진다.
ALTER TYPE listener_protocol ADD VALUE IF NOT EXISTS 'https';

-- 008_tls.sql
-- v0.6 — TLS 종단, 리소스와 제약 (DESIGN.md §4.6, §4.8, §8.1, §12.0 S16·S17)
--
-- 007 이 `listener_protocol` 에 `'https'` 를 추가했다. 그 값을 쓰는 DDL 은 **다른
-- 트랜잭션**이어야 해서 여기로 갈렸다 — 007 의 주석 참조.


CREATE TYPE tls_version AS ENUM ('1.2', '1.3');

CREATE TABLE certificates (
  id           uuid        PRIMARY KEY,
  key          text        NOT NULL UNIQUE,
  name         text        NOT NULL,
  -- **자료가 아니라 참조다.** `store://<name>@<version>` 이외의 모양은 못 들어온다.
  material_ref text        NOT NULL CHECK (material_ref ~ '^store://[A-Za-z0-9._-]+@[a-f0-9]{16,64}$'),
  -- 자료를 안 읽고도 세대 결박을 검증할 수 있게 함께 든다 (§7.2).
  chain_digest text        NOT NULL CHECK (chain_digest ~ '^sha256:[a-f0-9]{64}$'),
  key_digest   text        NOT NULL CHECK (key_digest   ~ '^sha256:[a-f0-9]{64}$'),
  version      integer     NOT NULL DEFAULT 1,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  created_by   text        NOT NULL,
  updated_by   text        NOT NULL,
  revision     bigint      NOT NULL
);

CREATE TABLE tls_policies (
  id          uuid        PRIMARY KEY,
  key         text        NOT NULL UNIQUE,
  name        text        NOT NULL,
  min_version tls_version NOT NULL,
  max_version tls_version,
  version     integer     NOT NULL DEFAULT 1,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  created_by  text        NOT NULL,
  updated_by  text        NOT NULL,
  revision    bigint      NOT NULL,
  -- 거꾸로 된 범위는 "아무 버전도 안 된다" 인데, `nginx -t` 는 그걸 통과시킨다.
  CONSTRAINT tls_policy_range CHECK (max_version IS NULL OR max_version >= min_version)
);

-- ── https 리스너의 TLS 결박 ─────────────────────────────────────────────
--
-- `default_certificate_id` 가 **NOT NULL 이어야 하는 이유**는 S17 이 실측했다:
-- `default_server` 가 없으면 모르는 SNI 가 **첫 번째 server 블록의 인증서**를 받는다
-- (E32 의 TLS 판). 멀티테넌트에서 그건 테넌트 간 누수다. "모르는 이름에 무엇을 제시할
-- 것인가" 는 비워 둘 수 있는 자리가 아니라 **반드시 정해야 하는 값**이다.
ALTER TABLE listeners ADD COLUMN tls_policy_id       uuid REFERENCES tls_policies(id) ON DELETE RESTRICT;
ALTER TABLE listeners ADD COLUMN tls_default_cert_id uuid REFERENCES certificates(id) ON DELETE RESTRICT;

-- https 는 http 와 같은 모양에 TLS 가 더 붙는다.
ALTER TABLE listeners ADD CONSTRAINT listener_https_shape CHECK (protocol <> 'https' OR (
  udp_preset IS NULL AND default_pool_id IS NULL
  AND on_unmatched_sni_pool IS NULL AND on_unmatched_sni_reject IS NULL
  AND preread_timeout_s IS NULL
  AND tls_policy_id IS NOT NULL AND tls_default_cert_id IS NOT NULL));

-- **https 가 아니면 TLS 결박을 가질 수 없다.** 붙여 두면 GUI 가 "이 리스너는 TLS 설정이
-- 있다" 고 보여주는데 렌더러는 무시하는, 표시와 실물이 어긋난 상태가 된다.
ALTER TABLE listeners ADD CONSTRAINT listener_tls_only_https CHECK (
  protocol = 'https' OR (tls_policy_id IS NULL AND tls_default_cert_id IS NULL));

-- ── SNI → 인증서 바인딩 ────────────────────────────────────────────────
--
-- **라우트에 붙이지 않는다.** v1 의 설계 오류가 그것이었다 — 인증서와 TLS 버전은 HTTP
-- Host/path 를 보기 전에 SNI 로 선택된다 (§4.6).
CREATE TABLE sni_certificate_bindings (
  id             uuid        PRIMARY KEY,
  key            text        NOT NULL UNIQUE,
  listener_id    uuid        NOT NULL,
  listener_proto listener_protocol NOT NULL,
  certificate_id uuid        NOT NULL REFERENCES certificates(id) ON DELETE RESTRICT,
  hosts          text[]      NOT NULL CHECK (cardinality(hosts) > 0),
  ovr_min_version tls_version,
  ovr_max_version tls_version,
  version        integer     NOT NULL DEFAULT 1,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  created_by     text        NOT NULL,
  updated_by     text        NOT NULL,
  revision       bigint      NOT NULL,

  -- **복합 FK.** 001 이 라우트에 쓴 것과 같은 수법이다: 비정규화한 protocol 컬럼이
  -- 리스너의 실제 protocol 과 다를 수 없고, 거기에 CHECK 를 걸면 "SNI 바인딩은 https
  -- 리스너에만" 이 **DB 의 보장**이 된다. 애플리케이션이 잊어도 안 뚫린다.
  CONSTRAINT sni_binding_listener_fk FOREIGN KEY (listener_id, listener_proto)
    REFERENCES listeners(id, protocol) ON DELETE CASCADE,
  CONSTRAINT sni_binding_is_https CHECK (listener_proto = 'https'),
  CONSTRAINT sni_binding_range CHECK (
    ovr_max_version IS NULL OR ovr_min_version IS NULL OR ovr_max_version >= ovr_min_version)
);

-- ── 호스트 겹침은 여기서 못 막는다 ─────────────────────────────────────
--
-- 같은 리스너에서 한 호스트가 두 인증서에 묶이면 어느 쪽이 제시되는지 **설정이 답을 못
-- 한다.** nginx 는 경고만 내고 첫 블록에 준다 (E36 의 TLS 판). 그런데 `hosts` 가 배열이라
-- 유일 인덱스로는 원소 겹침을 잡을 수 없다 — 001 이 소켓 겹침에 대해 적어 둔 것과 같은
-- 상황이다: *"유일 인덱스는 정확일치 중복만 잡는 보조 수단"*.
--
-- 그래서 호스트 겹침은 **검증기**가 진다 (`validateModel`). 여기 적어 두는 이유는 다음
-- 사람이 "왜 인덱스가 없지" 하고 잡지도 못할 인덱스를 추가하지 않게 하기 위해서다.

-- ── http 라우트는 https 리스너에도 붙는다 ──────────────────────────────
--
-- 001 은 `http_route_listener_is_http CHECK (listener_protocol = 'http')` 로 "http
-- 라우트는 http 리스너에만" 을 DB 보장으로 만들었다. 그때는 `https` 가 없었으니 맞는
-- 규칙이었다.
--
-- **TLS 를 종단하고 나면 평범한 HTTP 다.** https 리스너의 라우팅은 http 와 같은 것이고,
-- 실제로 렌더러도 둘을 같은 `http` 블록에서 낸다. 이 CHECK 를 안 넓히면 https 리스너에
-- 라우트를 붙이는 순간 FK 위반이 나고, 사용자에게는 "왜 안 되는지" 가 안 보인다
-- (e2e 가 실제로 여기서 걸렸다).
--
-- 넓히되 **버리지는 않는다** — tcp/udp/passthrough 리스너에 http 라우트를 붙이는 것은
-- 여전히 DB 가 막는다. 렌더 결과에서 그 라우트는 조용히 사라지기 때문이다.
ALTER TABLE http_routes DROP CONSTRAINT http_route_listener_is_http;
ALTER TABLE http_routes ADD CONSTRAINT http_route_listener_is_http
  CHECK (listener_protocol IN ('http', 'https'));

-- 009_acme.sql
-- ACME 주문 상태기계 (DESIGN.md §8.2 · ADR-ACME · S18)
--
-- ── 이건 설정이 아니다 ──────────────────────────────────────────────────
--
-- 주문·챌린지는 `config_revisions` 에 안 들어간다. **운영 상태**다 — `backend_health` 와
-- 같은 부류이고, 같은 이유로 리비전 밖에 산다:
--
--   · 리비전은 **불변**인데 주문은 상태가 계속 바뀐다
--   · 주문이 리비전에 들어가면 갱신 한 번마다 새 리비전이 생기고, 롤백이 "그때 진행 중이던
--     주문" 을 되살리게 된다 — 그건 되돌릴 대상이 아니다
--   · 설정 diff 에 "주문이 processing 이 됐다" 가 섞이면 plan 의 impact 가 거짓말이 된다
--
-- 설정에 남는 것은 §4.6 의 `certificates.material_ref` 뿐이고, 주문이 성공하면 **그 참조를
-- 바꾸는 changeset 을 만든다.** 발급과 게시는 다른 사건이다.
--
-- ── 개인키는 여기도 안 들어온다 (§4.8) ──────────────────────────────────
--
-- ACME **계정 키**도 개인키다. `account_key_ref` 는 SecretStore 참조이고 자료는 그 뒤에
-- 있다. 인증서 개인키와 같은 규칙을 적용한다 — 예외를 하나 두면 그게 규칙이 된다.

CREATE TYPE acme_order_state AS ENUM (
  -- 우리 쪽 상태. **CA 의 상태와 1:1 이 아니다.**
  --
  -- CA 는 pending/ready/processing/valid/invalid 를 말하는데, 그것만으로는 "언제 다시
  -- 시도할 것인가" 를 표현할 수 없다. S18 이 실측했다: **버려진 주문을 CA 는 안 치운다** —
  -- pending 으로 영원히 남는다. 재시도·포기·백오프는 우리가 든다.
  'pending',     -- 주문을 냈고 챌린지를 준비 중
  'validating',  -- 챌린지를 수락했고 CA 의 판정을 기다린다
  'ready',       -- 전 authz 통과. finalize 만 남았다
  'issued',      -- 인증서를 받아 SecretStore 에 넣었다. **게시는 아직이다**
  'failed',      -- 이번 시도 실패. next_attempt_at 뒤에 다시 온다
  'abandoned'    -- 재시도 상한 초과. 사람이 봐야 한다
);

CREATE TYPE acme_challenge_type AS ENUM ('http-01', 'dns-01');

CREATE TABLE acme_accounts (
  id              uuid        PRIMARY KEY,
  key             text        NOT NULL UNIQUE,
  directory_url   text        NOT NULL,
  contact         text[]      NOT NULL DEFAULT '{}',
  -- **SecretStore 참조다.** 계정 개인키가 여기 없다 (§4.8).
  --
  -- 스킴이 `key://` 인 것이 중요하다 — 계정 키는 **인증서가 없는 키**이고, 인증서 자료
  -- 참조(`store://`)와 섞이면 안 된다. 스킴을 가르면 섞이는 것이 표현 불가능하다.
  account_key_ref text        NOT NULL CHECK (account_key_ref ~ '^key://[A-Za-z0-9._-]+@[a-f0-9]{16,64}$'),
  -- CA 가 준 계정 URL(kid). 없으면 아직 등록 전이다.
  account_url     text,
  tos_agreed_at   timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  created_by      text        NOT NULL,
  -- 같은 디렉토리에 계정을 여럿 두는 것은 지금 쓸 일이 없고, 두면 "어느 계정으로
  -- 주문했는가" 가 매번 질문이 된다. 하나로 못 박는다.
  CONSTRAINT acme_account_directory_uq UNIQUE (directory_url)
);

CREATE TABLE acme_orders (
  id              uuid             PRIMARY KEY,
  account_id      uuid             NOT NULL REFERENCES acme_accounts(id) ON DELETE RESTRICT,
  -- 어느 인증서를 위한 주문인가. **인증서를 지우면 주문도 간다** — 목적이 사라진 주문을
  -- 남겨 두면 갱신 루프가 없는 것을 갱신하려 든다.
  certificate_id  uuid             NOT NULL REFERENCES certificates(id) ON DELETE CASCADE,
  domains         text[]           NOT NULL CHECK (cardinality(domains) > 0),
  state           acme_order_state NOT NULL DEFAULT 'pending',
  -- CA 쪽 좌표. 재시작 뒤에 이어서 몰려면 URL 을 들고 있어야 한다.
  order_url       text,
  finalize_url    text,
  certificate_url text,
  -- 발급 성공 시 SecretStore 참조. 게시(changeset)는 별도 사건이다.
  issued_ref      text CHECK (issued_ref IS NULL OR issued_ref ~ '^store://[A-Za-z0-9._-]+@[a-f0-9]{16,64}$'),
  -- 이 주문이 쓰는 인증서 개인키. **finalize 전에 만들어 SecretStore 에 넣는다** —
  -- CSR 에 서명한 키와 발급된 인증서가 짝이어야 하고, 그 사이에 죽으면 발급된 인증서가
  -- 짝을 잃어 **새 주문을 내야 한다.** CA 의 레이트리밋이 그걸 센다.
  --
  -- 아직 인증서가 없으므로 `key://` 다.
  cert_key_ref    text CHECK (cert_key_ref IS NULL OR cert_key_ref ~ '^key://[A-Za-z0-9._-]+@[a-f0-9]{16,64}$'),

  attempts        integer          NOT NULL DEFAULT 0,
  -- **다음에 볼 시각.** 이게 없으면 실패한 주문을 매 틱마다 다시 던지고 CA 의
  -- 레이트리밋에 걸린다 — 그러면 성공할 수 있었던 다른 주문까지 막힌다.
  next_attempt_at timestamptz      NOT NULL DEFAULT now(),
  last_error      text,
  -- CA 가 준 주문 만료. 지나면 새 주문을 내야 한다.
  expires_at      timestamptz,

  -- **실행권.** 리더가 둘일 수 있는 순간(§3.5 승계)에 같은 주문을 둘이 몰면 nonce 가
  -- 서로를 깨뜨리고, 더 나쁘게는 챌린지를 두 번 수락한다. operations 가 apply 에 대해
  -- 하는 일을 여기서 한다.
  claimed_by      text,
  claimed_until   timestamptz,

  created_at      timestamptz      NOT NULL DEFAULT now(),
  updated_at      timestamptz      NOT NULL DEFAULT now(),

  -- 종단 상태에서는 실행권을 들 수 없다. 들고 있으면 아무도 못 집는다.
  CONSTRAINT acme_order_claim_shape CHECK (
    (claimed_by IS NULL) = (claimed_until IS NULL)),
  CONSTRAINT acme_order_terminal_unclaimed CHECK (
    state NOT IN ('issued', 'abandoned') OR claimed_by IS NULL),
  -- 발급됐다면 자료가 있어야 한다. 없으면 "성공했는데 결과가 없다" 다.
  CONSTRAINT acme_order_issued_has_ref CHECK (
    state <> 'issued' OR (issued_ref IS NOT NULL AND cert_key_ref IS NOT NULL))
);

-- **인증서 하나에 살아 있는 주문은 하나다.**
--
-- 부분 인덱스로 건다 — 끝난 주문은 기록으로 남아야 하고(무엇이 언제 실패했나), 그것까지
-- 유일하게 만들면 재시도가 불가능해진다.
CREATE UNIQUE INDEX acme_order_live_uq ON acme_orders (certificate_id)
  WHERE state IN ('pending', 'validating', 'ready', 'failed');

CREATE INDEX acme_order_due_idx ON acme_orders (next_attempt_at)
  WHERE state IN ('pending', 'validating', 'ready', 'failed');

CREATE TABLE acme_challenges (
  id             uuid                PRIMARY KEY,
  order_id       uuid                NOT NULL REFERENCES acme_orders(id) ON DELETE CASCADE,
  domain         text                NOT NULL,
  type           acme_challenge_type NOT NULL,
  token          text                NOT NULL,
  -- http-01 은 key authorization 을 그대로, dns-01 은 그 SHA-256 을 쓴다 (RFC 8555 §8.4).
  -- **둘을 섞으면 챌린지가 항상 실패한다** — 그래서 계산된 값을 저장한다.
  value          text                NOT NULL,
  authz_url      text                NOT NULL,
  challenge_url  text                NOT NULL,
  -- **자료를 실제로 놓았는가.** "놓을 예정" 과 "놓았다" 를 구분해야 치울 대상을 안다.
  placed_at      timestamptz,
  -- §8.2: "dns-01 TXT 는 성공/실패와 무관하게 cleanup 보장 + 주기적 고아 스캔."
  -- S18 이 실측했다 — **버려진 주문을 CA 는 안 치운다.** 우리가 치운다.
  cleaned_at     timestamptz,
  created_at     timestamptz         NOT NULL DEFAULT now(),

  CONSTRAINT acme_challenge_uq UNIQUE (order_id, domain, type),
  -- 놓지도 않은 것을 치웠다고 적을 수 없다.
  CONSTRAINT acme_challenge_clean_after_place CHECK (
    cleaned_at IS NULL OR placed_at IS NOT NULL)
);

-- 고아 스캔이 볼 것: 놓았는데 안 치운 것.
CREATE INDEX acme_challenge_orphan_idx ON acme_challenges (placed_at)
  WHERE placed_at IS NOT NULL AND cleaned_at IS NULL;

-- ── 인증서의 ACME 의도 (§4.6 · ADR-ACME) ────────────────────────────────
--
-- **의도는 설정이고 주문은 운영 상태다.** "이 인증서를 이 도메인들로 자동 갱신한다" 는
-- 사람이 정하는 것이라 리비전에 남는다. 그 결과 생기는 주문·챌린지는 위 표들에 산다.
--
-- 그리고 **자료가 없을 수 있게 된다.** ACME 로 관리되는 인증서는 첫 발급 전에 자료가
-- 없고, 그걸 표현 못 하면 "인증서를 받으려면 인증서가 있어야 한다" 가 된다.
ALTER TABLE certificates ADD COLUMN acme_account text;
ALTER TABLE certificates ADD COLUMN acme_domains text[];
ALTER TABLE certificates ALTER COLUMN material_ref DROP NOT NULL;
ALTER TABLE certificates ALTER COLUMN chain_digest DROP NOT NULL;
ALTER TABLE certificates ALTER COLUMN key_digest   DROP NOT NULL;

-- **자료는 셋이 함께 온다.** 참조만 있고 digest 가 없으면 세대 결박을 검증할 수 없고,
-- digest 만 있고 참조가 없으면 무엇의 digest 인지 알 수 없다.
ALTER TABLE certificates ADD CONSTRAINT certificate_material_together CHECK (
  (material_ref IS NULL AND chain_digest IS NULL AND key_digest IS NULL)
  OR (material_ref IS NOT NULL AND chain_digest IS NOT NULL AND key_digest IS NOT NULL));

-- ACME 의도도 짝이다. 계정만 있고 도메인이 없으면 무엇을 주문할지 모른다.
ALTER TABLE certificates ADD CONSTRAINT certificate_acme_together CHECK (
  (acme_account IS NULL AND acme_domains IS NULL)
  OR (acme_account IS NOT NULL AND acme_domains IS NOT NULL AND cardinality(acme_domains) > 0));

-- **자료도 의도도 없는 인증서는 아무것도 아니다.**
ALTER TABLE certificates ADD CONSTRAINT certificate_useful CHECK (
  material_ref IS NOT NULL OR acme_account IS NOT NULL);

-- 010_drain.sql
-- 드레인은 운영 상태다. 리비전에 넣으면 롤백이 "그때 빼던 백엔드" 를 되살린다.
-- 헬스와 같은 부류: 멤버십 리듀서가 읽고, 프로버는 덮지 않는다.

CREATE TABLE backend_drain (
  backend_key text        PRIMARY KEY,
  started_at  timestamptz NOT NULL DEFAULT now(),
  deadline_at timestamptz,
  started_by  text        NOT NULL
);
