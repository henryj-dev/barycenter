/**
 * 출발지 규칙의 **행 오류** — 입력하는 동안 행 아래에 보인다 (#126 3단계, 시안 `ruleErrs`).
 *
 * **가려진 규칙**은 서버 검증기 `source_rule_shadowed`(`src/validate/model.ts`)와 같은 판정이다. 판정 함수를
 * 두 벌로 두지 않는다 — `cidrCovers` · `cidrVersion` · `addressSetRef` 를 `src/validate/ip.ts` 에서 그대로 가져온다
 * (노드 내장이 없는 모듈이라 브라우저에서도 돈다). 서버와 같게 하는 것:
 *   · `@집합` 은 집합의 대역으로 펼쳐 비교한다(`expandList` 처럼 한 규칙 안의 같은 대역은 한 번만). 없는 집합은
 *     펼치지 않는다 — 그 글자 그대로라 아무것도 덮지 않는다.
 *   · 보는 주소(방문자 · 연결)가 같은 규칙끼리만 본다.
 *   · 뒤 규칙의 대역마다, 앞 규칙들의 대역 중 **처음** 덮는 것을 찾는다. IPv4 와 IPv6 은 서로 덮지 않는다.
 *   · 한 규칙 안의 대역끼리는 보지 않는다.
 *
 * 경로별 묶음은 같은 라우트가 될 줄(정렬한 경로 목록이 같은 줄)끼리만 본다 — `src/web/route-group.ts` 가 그 줄들을
 * 한 라우트의 규칙으로 펼친다. 출발지가 빈 줄은 그 경로의 기본 동작이라 규칙이 아니다.
 *
 * 최종 판정은 서버다. 여기는 저장 전에 같은 말을 먼저 하는 자리다.
 */
import { addressSetRef, cidrCovers, cidrVersion } from '../../../../src/validate/ip.js';

/** 행 하나 — 대역 글(쉼표 · 공백으로 나눔)과 보는 주소. 묶음이면 경로 글도 있다. */
export type RuleText = { from: string; address: 'visitor' | 'connection'; paths?: string };

/** 집합 이름 → 대역. GUI 가 읽은 주소 집합(`desk.model.addressSets`)으로 만든다. */
export type SetCidrs = ReadonlyMap<string, readonly string[]>;

/** 출발지 칸 → 낱말. */
export const fromTokens = (text: string): string[] => text.split(/[\s,]+/).map((x) => x.trim()).filter((x) => x !== '');

/** 경로 칸 → 묶음 열쇠. `routeGroupPatch` 와 같다 — 빈 칸은 `/`, 같은 경로는 한 번, 정렬. */
export const groupKeyOf = (paths: string): string => {
  const ps = [...new Set(fromTokens(paths))];
  return [...(ps.length === 0 ? ['/'] : ps)].sort().join('\n');
};

/** 주소 집합 목록(모델의 `addressSets`) → `SetCidrs`. 모양이 다른 항목은 건너뛴다. */
export const setCidrsOf = (items: readonly Record<string, unknown>[]): SetCidrs => new Map(items
  .filter((s) => typeof s['key'] === 'string' && Array.isArray(s['cidrs']))
  .map((s) => [s['key'] as string, (s['cidrs'] as unknown[]).map(String)]));

type Cidr = { cidr: string; set?: string };

/** 낱말들을 대역으로 편다(`expandList` 와 같다). 대역마다 어느 집합에서 왔는지 단다. */
const expand = (tokens: readonly string[], sets: SetCidrs): Cidr[] => {
  const out: Cidr[] = [];
  for (const t of tokens) {
    const ref = addressSetRef(t);
    const cidrs = ref === undefined ? undefined : sets.get(ref);
    const items: Cidr[] = ref === undefined || cidrs === undefined ? [{ cidr: t }] : cidrs.map((c) => ({ cidr: c, set: ref }));
    for (const c of items) if (!out.some((x) => x.cidr === c.cidr)) out.push(c);
  }
  return out;
};

const nameOf = (c: Cidr): string => (c.set === undefined ? c.cidr : `@${c.set}(${c.cidr})`);

/** 숫자 뒤의 「로 / 으로」. 끝자리가 0 · 3 · 6 이면 받침이 있다(영 · 삼 · 육 · 십). */
const ro = (n: number): string => ([0, 3, 6].includes(n % 10) ? '으로' : '로');

/**
 * 행마다 오류 문구(없으면 `undefined`). 빈 행은 오류가 아니다 — 저장할 때 버린다.
 * `lines: true` 면 경로별 묶음이다 — 「n번째 줄」 로 말하고, 같은 라우트가 될 줄끼리만 비교한다.
 */
export function sourceRuleErrors(rows: readonly RuleText[], sets: SetCidrs, opts: { lines?: boolean } = {}): (string | undefined)[] {
  const lines = opts.lines === true;
  const seen: { cidr: Cidr; row: number; address: string; group: string }[] = [];
  return rows.map((r, i) => {
    const tokens = fromTokens(r.from);
    const group = lines ? groupKeyOf(r.paths ?? '') : '';
    for (const t of tokens) {
      const ref = addressSetRef(t);
      // 집합을 하나도 못 읽었으면(전역 중계) 있고 없음을 묻지 않는다 — 서버가 `unknown_address_set` 으로 본다.
      if (ref !== undefined) { if (sets.size > 0 && !sets.has(ref)) return `주소 집합 ${t}이 없어요.`; continue; }
      if (cidrVersion(t) === 0) return `${t}는 대역이 아니에요. CIDR · IP · @주소집합을 넣어요.`;
    }
    const from = expand(tokens, sets);
    let err: string | undefined;
    for (const a of from) {
      const by = seen.find((x) => x.group === group && x.address === r.address && cidrCovers(x.cidr.cidr, a.cidr));
      if (by === undefined) continue;
      err = lines
        ? `${i + 1}번째 줄의 ${nameOf(a)} 대역은 ${by.row + 1}번째 줄의 ${nameOf(by.cidr)} 안에 들어요. 이 대역은 이 줄로 오지 않아요. 좁은 대역을 위로 올려요.`
        : `규칙 ${i + 1}의 ${nameOf(a)} 대역은 규칙 ${by.row + 1}의 ${nameOf(by.cidr)} 안에 들어요. 이 대역은 규칙 ${i + 1}${ro(i + 1)} 오지 않아요. 좁은 대역을 위로 올려요.`;
      break;
    }
    for (const c of from) seen.push({ cidr: c, row: i, address: r.address, group });
    return err;
  });
}
