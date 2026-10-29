-- 클러스터 노드 상태 (ADR-CLUSTER, #118)
--
-- 클러스터는 설정 PG 하나를 함께 쓰는 barycenterd N 대다. 리더가 커밋·적용하고, 팔로워는
-- 리더가 활성화한 세대를 자기 nginx 에 옮긴다. 이 표는 **노드마다 지금 무엇을 서빙하는가**를
-- 적는다 — `operations` 는 리더의 결정 기록이고, 노드별 수렴은 여기다.
--
-- 노드가 스스로 쓴다(주기마다 upsert). 다른 노드의 행을 쓰지 않는다.
CREATE TABLE cluster_nodes (
  name             text        PRIMARY KEY,
  url              text,
  role             text        NOT NULL,
  -- 노드의 DP 에이전트가 보고한 활성 epoch 과 세대. 모르면 NULL.
  active_epoch     bigint,
  active_generation text,
  -- in_sync · following · failed · standalone
  state            text        NOT NULL,
  last_error       text,
  last_seen        timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cluster_node_role CHECK (role IN ('leader', 'follower')),
  CONSTRAINT cluster_node_state CHECK (state IN ('in_sync', 'following', 'failed', 'standalone'))
);
