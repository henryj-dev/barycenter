-- 드레인은 운영 상태다. 리비전에 넣으면 롤백이 "그때 빼던 백엔드" 를 되살린다.
-- 헬스와 같은 부류: 멤버십 리듀서가 읽고, 프로버는 덮지 않는다.

CREATE TABLE backend_drain (
  backend_key text        PRIMARY KEY,
  started_at  timestamptz NOT NULL DEFAULT now(),
  deadline_at timestamptz,
  started_by  text        NOT NULL
);
