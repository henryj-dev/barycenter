/**
 * `GET /api/v1/sockets` — 배포가 열어야 할 것 (§4.5 · §11.3)
 *
 * §11.3 은 배포를 **결정**했다: *"v1 권장 배포는 전용 VM + hostNetwork. k8s 네이티브
 * 배포는 별도 과제."* 이 뷰는 그 결정을 뒤집지 않는다 — 어느 배포를 고르든 운영자에게
 * 필요한 **같은 것 하나**를 낼 뿐이다: 이 설정이 어느 (전송, 주소, 포트) 를 잡는가.
 *
 * 없으면 `/api/v1/listeners` 를 받아 프로토콜→전송 변환을 밖에서 다시 구현해야 하고,
 * 그러면 §4.5 의 규칙이 두 벌이 된다 — 이 저장소가 반복해서 피해 온 모양이다.
 */
import { describe, expect, it } from 'vitest';
import { socketRows } from '../../src/web/sockets-view.js';
import type { Model } from '../../src/model/provisional.js';

const model = (listeners: unknown[]): Model => ({
  listeners,
  httpRoutes: [], passthroughRoutes: [], pools: [], backends: [],
  certificates: [], tlsPolicies: [], sniBindings: [],
} as unknown as Model);

describe('소켓 뷰', () => {
  it('L7 은 tcp 한 줄, udp 는 udp 한 줄', () => {
    const rows = socketRows(model([
      { key: 'web', protocol: 'http', bind: '0.0.0.0', port: 80, enabled: true },
      { key: 'dns', protocol: 'udp', bind: '0.0.0.0', port: 53, enabled: true },
      { key: 'tls', protocol: 'tls_passthrough', bind: '0.0.0.0', port: 443, enabled: true },
    ]));
    expect(rows.map((r) => `${r.transport}:${r.port}`)).toEqual(['udp:53', 'tcp:80', 'tcp:443']);
  });

  /**
   * **꺼진 리스너도 낸다.** `enabled: false` 는 "지금 안 듣는다" 이지 "이 포트를 안
   * 쓴다" 가 아니다 — 방화벽·Service 정의에서 빼 두면 켜는 순간 트래픽이 안 들어온다.
   * 대신 `enabled` 를 행에 실어 운영자가 고를 수 있게 한다.
   */
  it('꺼진 리스너도 내되 그 사실을 함께 낸다', () => {
    const rows = socketRows(model([
      { key: 'off', protocol: 'http', bind: '0.0.0.0', port: 8080, enabled: false },
    ]));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.enabled).toBe(false);
  });

  it('bind 를 그대로 낸다 — 루프백과 와일드카드는 배포에서 다른 것이다', () => {
    const rows = socketRows(model([
      { key: 'a', protocol: 'http', bind: '127.0.0.1', port: 80, enabled: true },
      { key: 'b', protocol: 'http', bind: '::', port: 80, enabled: true },
    ]));
    expect(rows.map((r) => r.bind).sort()).toEqual(['127.0.0.1', '::']);
  });

  /** 결정적 순서 — 배포 산출물의 diff 가 흔들리면 안 된다. */
  it('순서가 입력과 무관하다', () => {
    const ls = [
      { key: 'z', protocol: 'http', bind: '0.0.0.0', port: 443, enabled: true },
      { key: 'a', protocol: 'udp', bind: '0.0.0.0', port: 53, enabled: true },
      { key: 'm', protocol: 'tcp', bind: '10.0.0.1', port: 443, enabled: true },
    ];
    const forward = socketRows(model(ls));
    const backward = socketRows(model([...ls].reverse()));
    expect(forward).toEqual(backward);
    // 포트 → 전송 → bind → 키 순이다. 443 둘 중에서는 `0.0.0.0`(z) 가 `10.0.0.1`(m)
    // 보다 앞이다 — 키 순이 아니라 **bind 순**이라는 것이 여기서 드러난다.
    expect(forward.map((r) => r.listener)).toEqual(['a', 'z', 'm']);
  });

  it('리스너가 없으면 빈 목록이다', () => {
    expect(socketRows(model([]))).toEqual([]);
  });

  /**
   * **h3 가 들어오는 날 이 뷰의 행이 저절로 는다.** `transportsOf` 가 집합을 내므로
   * 리스너 하나가 소켓 여럿으로 펴진다 — 여기를 다시 안 만진다. 지금은 어느
   * 프로토콜도 둘을 안 내므로 행 수가 리스너 수와 같고, 그 항등이 그 사실의 증거다.
   */
  it('지금은 리스너 하나가 소켓 하나다 — 둘이 되는 날 행이 저절로 는다', () => {
    const ls = [
      { key: 'a', protocol: 'http', bind: '0.0.0.0', port: 80, enabled: true },
      { key: 'b', protocol: 'https', bind: '0.0.0.0', port: 443, enabled: true },
      { key: 'c', protocol: 'tls_passthrough', bind: '0.0.0.0', port: 8443, enabled: true },
      { key: 'd', protocol: 'tcp', bind: '0.0.0.0', port: 9000, enabled: true },
      { key: 'e', protocol: 'udp', bind: '0.0.0.0', port: 53, enabled: true },
    ];
    expect(socketRows(model(ls))).toHaveLength(ls.length);
  });
});
