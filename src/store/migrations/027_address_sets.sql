-- 주소 집합 (#114)
--
-- 여러 리스너가 같은 대역 목록을 쓴다(예: Cloudflare 22개). 리스너마다 복사하면 목록이 바뀔
-- 때 모두를 고쳐야 한다. 이름 붙인 집합을 두고 리스너가 `@이름` 으로 참조한다.
--
-- **참조는 FK 가 아니다.** 리스너의 대역 컬럼(`source_allow` · `real_ip_header_cidrs` ·
-- `accept_proxy_cidrs`)은 `text[]` 이고 `@이름` 은 그 안의 문자열이다. 있는지는 커밋 트랜잭션의
-- 검증기(`unknown_address_set`)가 본다 — 다른 교차 참조(라우트 그림자·소켓 겹침)와 같은 층이다.
--
-- `cidrs` 는 `text[]` 다(025 의 `source_allow` 와 같은 판단 — `cidr` 은 값을 정규화한다).
CREATE TABLE address_sets (
  id          uuid        PRIMARY KEY,
  key         text        NOT NULL UNIQUE,
  cidrs       text[]      NOT NULL,
  source      text,
  version     integer     NOT NULL DEFAULT 1,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  created_by  text        NOT NULL,
  updated_by  text        NOT NULL,
  revision    bigint      NOT NULL,
  CONSTRAINT address_set_nonempty CHECK (cardinality(cidrs) > 0),
  -- 해독기의 `source` 와 같은 목록이다.
  CONSTRAINT address_set_source CHECK (source IS NULL OR source IN ('cloudflare')),
  -- 012 와 같은 key 문법. key 는 `@이름` 참조의 이름이 된다.
  CONSTRAINT address_sets_key_syntax CHECK (key ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$')
);
