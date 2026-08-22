-- 검수 2026-08-22 · B-01 — **해독기가 받고 렌더러가 읽는데 저장소가 없던 필드들**
--
-- `tlsPolicy.hsts`·`cipherPolicy`·`sniHostMismatch`, 리스너 `http2`, 모델 `engine` 이
-- 전부 그랬다. PATCH 는 200 이고 plan 은 초록이고 commit 도 성공하는데, 렌더된 conf 에
-- 그 설정이 **없다.** 컬럼이 없어서 `applyOp` 가 버리고 `readModel` 이 못 읽었다.
--
-- 이 저장소가 반복해서 경계하는 *"저장은 됐는데 동작 안 함"* 의 가장 큰 판이다 —
-- HSTS 와 암호군은 **보안 설정**이라, 켰다고 믿는 것과 안 켠 것의 차이가 크다.
--
-- ⚠️ **옛 리비전 스냅샷은 안 고친다.** `config_revisions.model` 에 이미 저장된 것에는
-- 이 필드가 없고, 그게 그때의 사실이다. 즉 HSTS 를 켠 뒤 그 이전 리비전으로 롤백하면
-- HSTS 가 사라진다 — 거짓말이 아니라 **정확한 롤백**이다.

-- ── TLS 정책 ────────────────────────────────────────────────────────────
--
-- enum 대신 CHECK 을 쓴다. 값 목록이 해독기(`decode.ts`)에 이미 있고, PG enum 은
-- 값을 더할 때 마이그레이션이 필요해 두 자리가 갈리기 쉽다. 여기서는 **DB 가 마지막
-- 그물**이지 정본이 아니다.
ALTER TABLE tls_policies
  ADD COLUMN sni_host_mismatch text,
  ADD COLUMN cipher_policy     text,
  ADD COLUMN hsts              jsonb;

ALTER TABLE tls_policies ADD CONSTRAINT tls_policy_sni_mismatch_known CHECK (
  sni_host_mismatch IS NULL OR sni_host_mismatch IN ('allow', 'reject_421'));

ALTER TABLE tls_policies ADD CONSTRAINT tls_policy_cipher_known CHECK (
  cipher_policy IS NULL OR cipher_policy IN ('modern-2026', 'intermediate-2026'));

-- **모양만 본다.** preload 요구조건(max-age >= 1년 · includeSubdomains)은 검증기의
-- 몫이다 — 그건 다른 행을 안 봐도 되지만 *정책*이고, 정책이 DB 에 굳으면 바꿀 때
-- 마이그레이션이 필요해진다. 여기서는 "숫자인 max-age 가 있다" 까지만 강제한다.
ALTER TABLE tls_policies ADD CONSTRAINT tls_policy_hsts_shape CHECK (
  hsts IS NULL OR (
    jsonb_typeof(hsts) = 'object'
    AND jsonb_typeof(hsts -> 'maxAgeSeconds') = 'number'
  ));

-- ── 리스너 http2 ────────────────────────────────────────────────────────
--
-- **https 에만 있다.** 검증기의 `notHere('http2', …)` 와 같은 규칙을 DB 에도 건다 —
-- 프로토콜에 없는 필드를 NULL 로 못 박는 이 표의 기존 방식 그대로다. h2c 는 동작하지만
-- 열지 않기로 한 **의도된 배제**이고(§4.9), 그 결정이 여기서도 보여야 한다.
ALTER TABLE listeners ADD COLUMN http2 boolean;

ALTER TABLE listeners ADD CONSTRAINT listener_http2_only_https CHECK (
  http2 IS NULL OR protocol = 'https');

-- ── 엔진 설정 ───────────────────────────────────────────────────────────
--
-- `engine` 은 리소스가 아니라 **전역 설정**이다. key 가 없고 하나뿐이다 —
-- `config_head` 와 `health_cursor` 가 쓰는 단일 행 패턴을 그대로 쓴다.
--
-- 이 값이 없으면 §4.10 의 시간 보호가 **영원히 안 걸린다**: `plane.ts` 의 세대 청소가
-- `model.engine?.workerShutdownTimeoutS` 를 읽는데 언제나 undefined 였다. 즉 세대 GC 가
-- 개수 상한에만 기대고 있었고, 오래 사는 연결을 든 옛 워커가 전환 10 회를 넘겨 살아남으면
-- 그 세대가 지워진다(S8·S13 이 실측한 실패다).
CREATE TABLE engine_settings (
  only_one                  boolean     PRIMARY KEY DEFAULT true CHECK (only_one),
  -- 해독기와 같은 범위. 하루를 넘기는 값은 "무한" 과 구분이 안 된다.
  worker_shutdown_timeout_s integer     CHECK (
    worker_shutdown_timeout_s IS NULL
    OR worker_shutdown_timeout_s BETWEEN 1 AND 86400),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  updated_by                text        NOT NULL,
  revision                  bigint      NOT NULL
);
