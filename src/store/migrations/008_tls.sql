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
