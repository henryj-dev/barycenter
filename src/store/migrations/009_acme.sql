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
