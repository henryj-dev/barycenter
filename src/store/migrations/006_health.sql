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
