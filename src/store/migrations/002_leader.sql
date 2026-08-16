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
