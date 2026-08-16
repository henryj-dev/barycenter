-- 롤백 (DESIGN.md §5.3)
--
-- **롤백 plan 에는 changeset 이 없다.** changeset 은 *사람이 편집을 누적하는 그릇*이고,
-- 롤백은 편집이 아니라 "그 시점의 모델을 그대로 되살린다" 이다. 억지로 빈 changeset 을
-- 하나 만들어 붙이면 감사 로그에 아무도 안 만든 changeset 이 쌓이고, "이 changeset 은
-- 누가 만들었나" 에 답할 수 없게 된다.
ALTER TABLE plans ALTER COLUMN changeset_id DROP NOT NULL;

-- 롤백 대상은 **과거여야 한다.** `rollback_of < revision` 은 001 에서 이미 걸었고,
-- 여기서는 한 리비전이 자기 자신을 롤백 대상으로 삼는 것까지 막는다.
ALTER TABLE config_revisions
  ADD CONSTRAINT revision_not_self_rollback CHECK (rollback_of IS NULL OR rollback_of <> revision);
