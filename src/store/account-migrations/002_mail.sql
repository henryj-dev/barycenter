-- 002_mail.sql
-- 메일로 오가는 일회용 링크 (공통 회원정책 1차 · 계획 B1)
--
-- 비밀번호 재설정과 이메일 변경. 토큰은 해시로만 둔다. 재설정은 **MFA 를 풀지 않는다** — 메일함을
-- 가진 사람이 곧 계정 주인이 되지 않게(인증 앱은 그대로 요구된다).

CREATE TABLE password_resets (
  token_hash     text PRIMARY KEY,
  user_id        uuid NOT NULL REFERENCES users(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz NOT NULL,
  used_at        timestamptz,
  ip             text
);
CREATE INDEX password_resets_user_idx ON password_resets(user_id, created_at DESC);

-- 새 주소로 보낸 확인 링크. 확인하기 전까지 주소는 바뀌지 않는다.
CREATE TABLE email_changes (
  token_hash     text PRIMARY KEY,
  user_id        uuid NOT NULL REFERENCES users(id),
  new_email      text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz NOT NULL,
  used_at        timestamptz
);
ALTER TABLE email_changes ADD CONSTRAINT email_changes_lower CHECK (new_email = lower(new_email));
