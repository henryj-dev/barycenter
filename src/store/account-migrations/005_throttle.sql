-- 회원 공통 수치 1차 (2026-10-18 사용자 결정, orc 경유) — 시도 제한을 **공용 저장소**에서 센다.
-- 인스턴스 메모리에서 따로 세면 DNS 다중 A 로 묶인 인스턴스 수만큼 시도가 늘어난다.
-- 키는 '<용도>:<IP>' 다(예: login:10.0.0.1, reset:10.0.0.1). 계정 단위는 users.failed_logins·locked_until 이다.
CREATE TABLE auth_throttle (
  key              text PRIMARY KEY,
  failures         integer NOT NULL,
  blocked_until    timestamptz,
  last_failure_at  timestamptz NOT NULL
);
CREATE INDEX auth_throttle_last_idx ON auth_throttle(last_failure_at);

-- 계정 단위 계수도 마지막 실패 뒤 15분이 지나면 처음부터 센다(공통 수치 1차 추가) — 그 시각을 둔다.
ALTER TABLE users ADD COLUMN last_failed_at timestamptz;
