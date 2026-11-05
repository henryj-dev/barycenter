/**
 * 공급자(`Dns01Provider`) → 러너의 `ChallengePlacer`.
 *
 *   place   TXT 를 더한다. 실패면 던진다 — 러너가 그 주문을 실패로 적고 백오프한다(사유는 공급자의 말 그대로).
 *           그 뒤 전파 대기(설정했으면). 시간이 다 돼도 **수락은 진행한다**: 여기서 던지면 이미 낸 주문이
 *           수락되지 않은 채 만료까지 남는다. 대신 경고를 남긴다(CA 가 못 보면 그 사유가 주문에 남는다).
 *   remove  그 값만 지운다. 실패하면 경고를 남기고 던진다 — `cleanupPlacedChallenges` 가 잡아서 **발급은 그대로**
 *           두고, 원장에 「안 치웠다」 가 남아 고아 스캔이 다시 시도한다.
 */
import type { ChallengePlacer } from '../acme-runner.js';
import { dns01TxtName } from '../dns01.js';
import { log } from '../../obs/log.js';
import { count } from '../../obs/metrics.js';
import { waitForTxt, type PropagationOptions } from './propagation.js';
import { validTxtName, validTxtValue, type Dns01Provider } from './provider.js';

export class Dns01Placer implements ChallengePlacer {
  readonly type = 'dns-01' as const;

  constructor(
    readonly provider: Dns01Provider,
    /** 없으면 기다리지 않는다. */
    private readonly propagation?: PropagationOptions,
  ) {}

  async place(domain: string, _token: string, value: string): Promise<void> {
    const name = dns01TxtName(domain);
    if (!validTxtName(name) || !validTxtValue(value)) throw new Error(`dns-01 TXT 이름 · 값 형식이 아니다: ${JSON.stringify(name)}`);
    const r = await this.provider.addTxt(name, value);
    if (!r.ok) {
      count(`bary_acme_dns01_total{op="place",outcome="${r.reason}"}`);
      throw new Error(`dns-01 TXT 를 놓지 못했다 (${this.provider.kind} · ${r.reason}): ${r.detail}`);
    }
    count('bary_acme_dns01_total{op="place",outcome="ok"}');
    if (this.propagation === undefined || this.propagation.timeoutMs <= 0) return;
    const w = await waitForTxt(name, value, this.propagation);
    if (!w.ok) {
      count('bary_acme_dns01_total{op="propagation",outcome="timeout"}');
      log.warn('acme.dns01.propagation_timeout', { name, provider: this.provider.kind, detail: w.detail });
    }
  }

  async remove(domain: string, _token: string, value?: string): Promise<void> {
    const name = dns01TxtName(domain);
    if (value === undefined) throw new Error(`dns-01 TXT ${name} 를 지우려면 값이 필요하다`);
    const r = await this.provider.removeTxt(name, value);
    if (r.ok) {
      count('bary_acme_dns01_total{op="remove",outcome="ok"}');
      return;
    }
    count(`bary_acme_dns01_total{op="remove",outcome="${r.reason}"}`);
    log.warn('acme.dns01.remove_failed', { name, provider: this.provider.kind, reason: r.reason, detail: r.detail, note: 'TXT 가 남았다 — 고아 스캔이 다시 지운다' });
    throw new Error(`dns-01 TXT 를 지우지 못했다 (${this.provider.kind} · ${r.reason}): ${r.detail}`);
  }
}
