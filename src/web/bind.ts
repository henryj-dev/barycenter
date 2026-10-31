/**
 * GUI 의 바인드 선택 규칙. **노드 내장을 끌지 않는다** — GUI 번들이 이 파일을 싣는다(`web/edit.ts` 와 같다).
 */
/**
 * 바인드 선택지 (2026-10-31). 바인드는 수신할 소켓의 주소라 **이 서버에 할당된 것**과 와일드카드만 연다.
 * 서버가 다시 본다(plan 의 `bind_not_local`). 여기는 고르기 쉽게 하고 잘못을 일찍 보여 줄 뿐이다.
 */
export type BindFacts = {
  addresses: readonly { address: string; family: 'v4' | 'v6'; interface: string; internal: boolean }[];
  nonlocalBind: { v4: boolean; v6: boolean };
};
export const CUSTOM_BIND = '__custom__';
const familyOf = (bind: string): 'v4' | 'v6' => (bind.includes(':') ? 'v6' : 'v4');
const WILDCARDS = ['0.0.0.0', '::'];
const known = (bind: string, facts: BindFacts): boolean =>
  WILDCARDS.includes(bind) || facts.addresses.some((a) => a.address === bind);

export const bindOptions = (facts: BindFacts, current: string): { value: string; label?: string; hint?: string }[] => {
  const cur = current.trim().toLowerCase();
  const out: { value: string; label?: string; hint?: string }[] = [
    { value: '0.0.0.0', hint: '모든 IPv4' },
    { value: '::', hint: '모든 IPv6' },
    ...facts.addresses.map((a) => ({ value: a.address, hint: a.internal ? `${a.interface} · 이 서버 안에서만` : a.interface })),
  ];
  if (cur !== '' && !known(cur, facts) && !facts.nonlocalBind[familyOf(cur)]) {
    out.push({ value: cur, hint: '이 서버에 없음' });
  }
  if (facts.nonlocalBind.v4 || facts.nonlocalBind.v6) out.push({ value: CUSTOM_BIND, label: '직접 입력…', hint: 'VIP (ip_nonlocal_bind)' });
  return out;
};

/** 이 서버가 못 여는 바인드면 이유. 모르면(주소를 못 읽었으면) 판단하지 않는다. */
export const bindError = (bind: string, facts: BindFacts | undefined): string | undefined => {
  const b = bind.trim().toLowerCase();
  if (facts === undefined || b === '' || known(b, facts) || facts.nonlocalBind[familyOf(b)]) return undefined;
  return '이 서버에 할당된 주소가 아니에요. nginx 가 이 소켓을 못 열어요. 목록에서 골라요.';
};

