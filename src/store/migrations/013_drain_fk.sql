-- 검수 2026-08-22 · B-04 · B-10 — **운영 상태가 백엔드보다 오래 살면 안 된다**
--
-- `backend_drain` 과 `backend_health` 는 백엔드 key 로만 이어져 있었다. 백엔드를 지워도
-- 행이 남고, **같은 key 로 다시 만들면 드레인과 옛 `unhealthy` 판정이 조용히 되살아난다.**
-- 새 백엔드가 처음부터 멤버십에서 빠지고, 프로버가 다음으로 판정을 뒤집을 때까지 트래픽을
-- 못 받는다. `probe_start_seq` 도 이어져서 새 백엔드의 첫 관측이 낡은 것으로 버려질 수 있다.
--
-- ── 왜 FK 가 아니라 트리거인가 ──────────────────────────────────────────
--
-- 처음엔 `ON DELETE CASCADE` FK 를 걸었다. **그게 프로버를 깨뜨린다.**
--
-- `HealthProber.sweep` 은 **모델**(= `config_revisions` 스냅샷)의 백엔드를 찔러 판정을
-- 쓴다. 그런데 FK 는 **live `backends` 표**를 본다. 백엔드를 지우는 커밋과 프로버 틱이
-- 겹치면 — 프로버는 방금 전 스냅샷을 들고 있다 — INSERT 가 FK 위반으로 죽고,
-- §6.7 대로 **판정이 통째로 동결된다.** 지금까지 무해했던 경합이 장애가 된다.
--
-- 트리거는 **지우는 쪽에만** 걸린다. 쓰는 경로를 건드리지 않으므로 그 창이 안 생기고,
-- CASCADE 로 사라지는 백엔드(풀 삭제 · 롤백의 `DELETE FROM pools`)까지 함께 덮는다 —
-- FK 를 백엔드에만 걸었을 때와 같은 범위다.
--
-- 남는 대가: 없는 백엔드에 대한 드레인 행을 DB 가 막지는 못한다. 그건 API 가 이미
-- 모델을 보고 404 를 낸다.

-- 지금 떠 있는 고아부터 치운다.
DELETE FROM backend_drain  WHERE backend_key NOT IN (SELECT key FROM backends);
DELETE FROM backend_health WHERE backend_key NOT IN (SELECT key FROM backends);

CREATE FUNCTION backend_state_cleanup() RETURNS trigger AS $$
BEGIN
  DELETE FROM backend_drain  WHERE backend_key = OLD.key;
  DELETE FROM backend_health WHERE backend_key = OLD.key;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER backend_state_cleanup
  AFTER DELETE ON backends
  FOR EACH ROW EXECUTE FUNCTION backend_state_cleanup();

-- 만료된 드레인을 거르는 조회가 자주 돈다 — `drainKeys` 는 멤버십 투영마다 불린다.
CREATE INDEX backend_drain_deadline_idx ON backend_drain (deadline_at);
