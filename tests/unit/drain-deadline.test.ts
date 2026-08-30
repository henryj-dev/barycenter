/**
 * 드레인 기한 — **관측이지 자동 해제가 아니다** (§4.4 · ADR-MEMBERSHIP-ATTRS §6)
 *
 * ── 무엇이 어긋나 있었나
 *
 * `drainKeys()` 가 `deadline_at IS NULL OR deadline_at > now()` 로 걸렀다. 그래서 기한이
 * 지나면 그 백엔드가 **멤버십에 도로 들어오고 트래픽이 자동으로 재개**됐다.
 *
 * §4.4 는 다르게 적었다 — *"관측 목적의 기한. 강제 종료는 별도 capability"*. 그리고 그
 * 표의 `drain_condition` 에 `deadline_exceeded` 가 있는데 코드의 `DrainCondition` 에는
 * 없었다. **구현이 그 상태를 만들 수 없었기 때문이다** — 기한이 지나면 드레인 자체가
 * 사라지니까.
 *
 * ── 왜 이 쪽으로 정했나 (2026-08-30, 사람)
 *
 * 운영자가 백엔드를 빼고 정비하려고 기한을 준다. 자동 해제면 **정비 중인 백엔드로
 * 트래픽이 조용히 돌아온다** — 드레인 계약표의 첫 줄(*"새 연결/세션이 이 백엔드로 가지
 * 않음 ✅"*)에 아무도 안 적은 시한이 붙어 있는 셈이었다.
 *
 * 잃는 것도 적어 둔다: **잊힌 드레인이 용량을 영구히 깎는다.** 그 대신 기한이 지난 것이
 * `deadline_exceeded` 로 드러나므로, 보이는 상태가 됐다.
 */
import { describe, expect, it } from 'vitest';

import { drainStatusOf } from '../../src/control/drain.js';

describe('기한이 지나도 드레인은 유지된다', () => {
  it('**기한이 지나면 `deadline_exceeded` 다** — 상태가 사라지지 않는다', () => {
    const s = drainStatusOf({ backend: 'a', draining: true, deadlineExceeded: true });
    expect(s?.drain_condition).toBe('deadline_exceeded');
  });

  it('기한이 안 지났으면 그대로 `no_new_traffic`', () => {
    const s = drainStatusOf({ backend: 'a', draining: true, deadlineExceeded: false });
    expect(s?.drain_condition).toBe('no_new_traffic');
  });

  /**
   * **`quiesced` 가 `deadline_exceeded` 를 이긴다.**
   *
   * 기한을 넘겼어도 실제로 다 빠졌으면 그것이 더 강한 사실이다 — 운영자가 알고 싶은
   * 것은 "지금 빼도 되는가" 이고, 그 답은 `quiesced` 다. 반대로 두면 다 빠진 백엔드를
   * 기한 때문에 못 빼는 것으로 읽는다.
   */
  it('다 빠졌으면 기한을 넘겼어도 `quiesced`', () => {
    const s = drainStatusOf({
      backend: 'a', draining: true, inflight: 0, sessions: 0, deadlineExceeded: true,
    });
    expect(s?.drain_condition).toBe('quiesced');
  });

  it('관측이 없으면 숫자를 안 짓는다 — 기한과 무관하다', () => {
    const s = drainStatusOf({ backend: 'a', draining: true, deadlineExceeded: true }) as
      Record<string, unknown>;
    expect(s['inflight']).toBeUndefined();
    expect(s['active_sessions']).toBeUndefined();
  });

  it('드레인 중이 아니면 아무것도 안 낸다', () => {
    expect(drainStatusOf({ backend: 'a', draining: false, deadlineExceeded: true }))
      .toBeUndefined();
  });
});
