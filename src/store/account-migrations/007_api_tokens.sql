-- 개인 API 토큰 (#126 후속, 2026-11-04 사용자 승인 설계).
--
-- **토큰은 한 사람의 것이다.** 역할은 발급할 때 고르고, 그때 주인의 역할을 넘지 못한다. 인증할 때마다
-- 실효 역할 = min(토큰 역할, 주인의 **지금** 역할)이다 — 주인이 정지·삭제되거나 역할이 내려가면 다음 요청부터
-- 반영된다(세션과 같은 규칙). 만료는 반드시 있다(기본 90일, 최대 365일).
--
-- **평문은 저장하지 않는다.** 토큰은 `bary_<lookup>_<secret>` 모양이고, `lookup` 은 행을 찾는 비밀이 아닌 짧은
-- 값이다. `token_hash` 는 토큰 전체의 SHA-256 이다(엔트로피가 높은 값이라 느린 해시가 필요 없다). 비교는
-- 상수 시간이다(`AccountService.authenticateToken`).
--
-- 파일 토큰(`BARY_TOKENS*`)은 그대로다 — 계정 PG 가 내려갔을 때의 비상 출입구다. 이 표로 옮기지 않는다.
CREATE TABLE api_tokens (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES users(id),
  name           text NOT NULL,
  role           text NOT NULL,
  lookup         text NOT NULL UNIQUE,
  token_hash     text NOT NULL,
  created_at     timestamptz NOT NULL,
  created_by     text NOT NULL,
  expires_at     timestamptz NOT NULL,
  -- 성공한 사용의 시각. 인증마다 쓰지 않는다 — 1분에 한 번까지(인증이 쓰기 병목이 되지 않게).
  last_used_at   timestamptz,
  revoked_at     timestamptz,
  revoked_by     text
);
ALTER TABLE api_tokens ADD CONSTRAINT api_tokens_role CHECK (role IN ('auditor', 'operator', 'admin'));
ALTER TABLE api_tokens ADD CONSTRAINT api_tokens_name_shape CHECK (name ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$');
ALTER TABLE api_tokens ADD CONSTRAINT api_tokens_lookup_shape CHECK (lookup ~ '^[0-9a-f]{16}$');
ALTER TABLE api_tokens ADD CONSTRAINT api_tokens_hash_shape CHECK (token_hash ~ '^[0-9a-f]{64}$');
-- 만료 없는 토큰은 없다. 최대 365일 — 앱이 먼저 거르고, 여기는 마지막 울타리다.
ALTER TABLE api_tokens ADD CONSTRAINT api_tokens_expiry CHECK (
  expires_at > created_at AND expires_at <= created_at + interval '365 days');
CREATE INDEX api_tokens_user_idx ON api_tokens(user_id) WHERE revoked_at IS NULL;
