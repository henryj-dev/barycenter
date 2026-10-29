/**
 * 주소 집합 펼치기 (#114). **한 자리다** — 검증기·렌더러·영향 분석이 모두 이것을 쓴다.
 * 자리가 둘이면 언젠가 갈린다(이 저장소가 반복해서 적어 온 규칙).
 *
 * 참조하는 자리는 셋이다: 리스너 `sourceAllow` · `realIpFromHeader.trustedCidrs` ·
 * `acceptProxyProtocol.trustedCidrs`. 펼친 뒤에는 **중복을 접는다** — 집합과 직접 적은
 * 대역이 겹칠 수 있고, nginx 의 `geo` 는 같은 망을 두 번 받으면 경고를 낸다.
 */
import { addressSetRef } from '../validate/ip.js';
import type { Listener, Model, RawListener } from './provisional.js';

/** 리스너가 참조하는 집합 이름들 (정렬, 중복 없음). */
export function referencedSets(l: RawListener | Listener): string[] {
  const lists: (readonly string[] | undefined)[] = [
    l.sourceAllow,
    'realIpFromHeader' in l ? l.realIpFromHeader?.trustedCidrs : undefined,
    'acceptProxyProtocol' in l ? l.acceptProxyProtocol?.trustedCidrs : undefined,
  ];
  const out = new Set<string>();
  for (const list of lists) for (const s of list ?? []) {
    const ref = addressSetRef(s);
    if (ref !== undefined) out.add(ref);
  }
  return [...out].sort();
}

/** 목록 하나를 펼친다. 모르는 참조는 그대로 둔다 — 검증기가 먼저 막는다. */
function expandList(list: readonly string[], sets: ReadonlyMap<string, readonly string[]>): string[] {
  const out: string[] = [];
  for (const s of list) {
    const ref = addressSetRef(s);
    const items = ref === undefined ? [s] : (sets.get(ref) ?? [s]);
    for (const c of items) if (!out.includes(c)) out.push(c);
  }
  return out;
}

/**
 * 참조를 대역으로 바꾼 모델. 집합이 없거나 아무도 참조하지 않으면 **같은 객체**를 돌려준다 —
 * 렌더 바이트가 이 기능 전과 같다.
 */
export function expandAddressSets<M extends Model>(model: M): M {
  const sets = new Map((model.addressSets ?? []).map((s) => [s.key, s.cidrs]));
  if (!model.listeners.some((l) => referencedSets(l).length > 0)) return model;
  const listeners = model.listeners.map((l): Listener => {
    if (referencedSets(l).length === 0) return l;
    const next = { ...l } as Listener & Record<string, unknown>;
    if (l.sourceAllow !== undefined) next.sourceAllow = expandList(l.sourceAllow, sets);
    if ('realIpFromHeader' in l && l.realIpFromHeader !== undefined) {
      next['realIpFromHeader'] = { ...l.realIpFromHeader, trustedCidrs: expandList(l.realIpFromHeader.trustedCidrs, sets) };
    }
    if ('acceptProxyProtocol' in l && l.acceptProxyProtocol !== undefined) {
      next['acceptProxyProtocol'] = { ...l.acceptProxyProtocol, trustedCidrs: expandList(l.acceptProxyProtocol.trustedCidrs, sets) };
    }
    return next;
  });
  return { ...model, listeners };
}
