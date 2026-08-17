-- 오퍼레이션 봉투를 보관한다 (DESIGN.md §5.2 `/operations/{id}/cancel`, §9.2)
--
-- `abortConfig` 는 **`ApplyOperation` 을 통째로** 받는다. 봉투와 epoch 만으로 튜플을
-- 재구성하면 정본 튜플이 달라져 슬롯의 주인으로 인정받지 못하고, 그러면 abort 가
-- 아무것도 못 지운다 — 드라이버 계약이 그 이유를 명시해 뒀다.
--
-- 그래서 취소하려면 **낼 때 쓴 그 봉투**가 있어야 한다. 재구성하지 않고 보관한다.
ALTER TABLE operations ADD COLUMN envelope jsonb;
