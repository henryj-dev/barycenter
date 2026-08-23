/**
 * 이 설정이 **점유하는 소켓 전부** (DESIGN.md §4.5 · §11.3)
 *
 * ── 왜 리스너 목록으로 부족한가
 *
 * §11.3 이 배포를 이렇게 정했다:
 *
 * > `:999`, `:888` 같은 임의 포트를 Kubernetes 에서 노출하려면 hostNetwork / hostPort /
 * > LoadBalancer 중 하나를 골라야 하고 셋 다 제약이 있다. → **v1 권장 배포는 전용 VM +
 * > hostNetwork.** k8s 네이티브 배포는 별도 과제.
 *
 * 그 결정은 그대로다 — 여기서 k8s 를 푸는 것이 아니다. 그런데 어느 배포를 고르든
 * 운영자에게 **같은 것 하나**가 필요하다: *"이 설정이 어느 (전송, 주소, 포트) 를
 * 잡는가."* 지금은 `/api/v1/listeners` 를 받아 프로토콜→전송 변환을 밖에서 다시
 * 구현해야 하고, 그러면 §4.5 의 규칙이 두 벌이 된다.
 *
 * ── 전송이 **여럿일 수 있다**
 *
 * S20 이 실측했다: `listen 443 quic` 은 같은 포트를 **UDP 로도** 점유한다. 그래서
 * `transportsOf` 가 집합을 내고, 이 뷰는 리스너 하나를 소켓 **여럿**으로 편다.
 * h3 를 여는 날 이 뷰의 행이 저절로 는다 — 여기를 다시 안 만진다.
 *
 * ⚠️ **꺼진 리스너도 낸다.** `enabled: false` 는 "지금 안 듣는다" 이지 "이 포트를 안
 * 쓴다" 가 아니다 — 방화벽·Service 정의는 켤 때를 대비해 열어 둬야 하고, 뺐다가
 * 켜는 순간 트래픽이 안 들어오는 것이 §11.3 이 겪게 되는 실패다. 대신 `enabled` 를
 * 행에 실어 운영자가 고를 수 있게 한다.
 */
import type { Model } from '../model/provisional.js';
import { transportsOf, type Transport } from '../validate/sockets.js';

export type SocketRow = {
  listener: string;
  protocol: string;
  transport: Transport;
  bind: string;
  port: number;
  enabled: boolean;
};

/** 결정적 순서 — 배포 산출물의 diff 가 흔들리면 안 된다. */
export function socketRows(model: Model): SocketRow[] {
  const rows: SocketRow[] = [];
  for (const l of model.listeners) {
    for (const transport of transportsOf(l.protocol)) {
      rows.push({
        listener: l.key,
        protocol: l.protocol,
        transport,
        bind: l.bind,
        port: l.port,
        enabled: l.enabled,
      });
    }
  }
  return rows.sort((a, b) =>
    a.port - b.port
    || (a.transport < b.transport ? -1 : a.transport > b.transport ? 1 : 0)
    || (a.bind < b.bind ? -1 : a.bind > b.bind ? 1 : 0)
    || (a.listener < b.listener ? -1 : a.listener > b.listener ? 1 : 0));
}
