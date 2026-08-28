-- 023_secret_materials.sql
-- §4.8.1 — **두 번째 SecretStore 드라이버** (2026-08-28)
--
-- `FsSecretStore` 는 DP 호스트에 평문으로 쓴다. 로드맵 R-1 이 그 자리를 비워 뒀고,
-- 남는 위험은 호스트 침해 시 즉시 노출과 백업·스냅샷 잔존이다.
--
-- ── §4.8 의 "평문 금지" 는 지켜진다
--
-- 여기 들어가는 것은 **봉투 암호화의 암호문**이다. 자료마다 DEK 를 새로 뽑아
-- AES-256-GCM 으로 감싸고, 그 DEK 를 다시 KEK 로 감싼다. **KEK 는 이 DB 에 없다** —
-- `BARY_SECRET_KEK` 또는 KMS 다. 덤프를 가져간 상대는 암호문만 든다.
--
-- ── 왜 `facts` 만 평문인가
--
-- 만료·SAN·발급자는 **비밀이 아니다.** 그리고 이것을 읽는 자리 둘(커밋 앞 SAN 커버
-- 검증기 · plan 의 임팩트 계산)이 **동기**라 저장소에 물을 수 없다 — 드라이버가 캐시로
-- 든다(§4.8.1). 평문으로 두면 그 캐시를 기동에서 한 번에 적재하면서 **자료를 하나도
-- 복호화하지 않는다.** 만료를 보려고 개인키를 만지는 것이 이 저장소의 규칙에 어긋난다.
--
-- ── 버전은 내용 주소다
--
-- `FsSecretStore` 와 같은 규칙 — sha256(chain|key) 앞 32 자. 그래서 같은 자료를 다시
-- 올려도 버전이 안 늘고, 두 드라이버가 **같은 참조 문자열**을 낸다. 참조가 드라이버를
-- 가리지 않는 것이 이전 경로의 전제다.
CREATE TABLE secret_materials (
  -- `store` = 인증서 한 벌, `key` = 인증서 없는 개인키 (ACME 주문 진행 중).
  -- **스킴을 섞지 않는다** — `parseRef` 가 `store://` 만 받는 이유와 같다 (§4.8).
  scheme       text NOT NULL,
  name         text NOT NULL,
  version      text NOT NULL,
  -- KEK 회전의 자리. 자료마다 DEK 가 따로라 회전은 **DEK 재감싸기**이고 자료
  -- 바이트를 다시 읽지 않는다. 회전 절차 자체는 아직 없다.
  kek_id       text NOT NULL,
  -- KEK 로 감싼 DEK. `nonce(12) || tag(16) || ciphertext`.
  wrapped_dek  bytea NOT NULL,
  -- 자료를 감싼 DEK 의 nonce.
  nonce        bytea NOT NULL,
  -- DEK 로 감싼 자료. `tag(16) || ciphertext`.
  -- AAD 는 `<scheme>://<name>@<version>` 이다 — 행을 다른 이름·버전 자리로 옮기면
  -- 복호화가 **실패한다.** 덤프를 만질 수 있는 상대가 자료를 바꿔치기하는 길을 막는다.
  ciphertext   bytea NOT NULL,
  -- 세대 결박용 digest (§4.8). 평문이다 — 자료가 아니라 자료에 대한 주장이고,
  -- `certificateFiles` 가 세대를 구울 때 이것과 대조한다.
  sha256       text,
  chain_digest text,
  key_digest   text NOT NULL,
  -- 비밀이 아니다. 위 머리말 참조.
  facts        jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scheme, name, version)
);

ALTER TABLE secret_materials ADD CONSTRAINT secret_materials_scheme
  CHECK (scheme IN ('store', 'key'));

-- `FsSecretStore` 의 `VERSION_DIR` 과 같은 모양이어야 한다. 갈리면 두 드라이버가 낸
-- 참조가 서로 안 읽힌다.
ALTER TABLE secret_materials ADD CONSTRAINT secret_materials_version_shape
  CHECK (version ~ '^[a-f0-9]{32}$');

ALTER TABLE secret_materials ADD CONSTRAINT secret_materials_name_shape
  CHECK (name ~ '^[A-Za-z0-9._-]+$');

-- **인증서 한 벌은 체인 digest 를 든다.** 없으면 세대 결박이 반쪽이다 —
-- `certificateFiles` 가 대조할 것이 사라진다.
ALTER TABLE secret_materials ADD CONSTRAINT secret_materials_store_has_chain
  CHECK (scheme <> 'store' OR (chain_digest IS NOT NULL AND sha256 IS NOT NULL));

-- 키 단독 참조에는 체인이 **없어야** 한다. 있으면 둘 중 하나가 거짓말이다.
ALTER TABLE secret_materials ADD CONSTRAINT secret_materials_key_has_no_chain
  CHECK (scheme <> 'key' OR (chain_digest IS NULL AND sha256 IS NULL AND facts IS NULL));

-- GC 의 root 넓히기가 전부를 훑는다 (`listRefs`). 이름 없이 스킴으로만 가른다.
CREATE INDEX secret_materials_scheme_idx ON secret_materials(scheme);
