/**
 * GUI 출발지 규칙 편집기의 **가려진 규칙** 행 오류 (#126 3단계, `gui/src/lib/forms/source-rules.ts`).
 *
 * 서버 검증기 `source_rule_shadowed` 와 같은 판정이어야 한다 — 화면이 「괜찮아요」 하고 저장에서 거절되거나, 그 반대면
 * 사람이 화면을 믿지 않는다. 그래서 문구를 재는 것과 함께 **같은 입력을 검증기에도 넣어** 가린다 · 안 가린다가 같은지 본다.
 */
import { describe, expect, it } from 'vitest';

import { sourceRuleErrors, groupKeyOf, setCidrsOf, type RuleText } from '../../gui/src/lib/forms/source-rules.js';
import { exampleRequest, matchPrefix, rewriteError, rewritePath, slashMismatch } from '../../gui/src/lib/forms/rewrite.js';
import { decodeModel } from '../../src/model/decode.js';
import { validateModel } from '../../src/validate/model.js';

const sets = setCidrsOf([
  { key: 'private', cidrs: ['10.0.0.0/8', '192.168.0.0/16', 'fd00::/8'] },
  { key: 'office', cidrs: ['10.1.2.0/24'] },
]);
const v = (from: string, address: RuleText['address'] = 'visitor'): RuleText => ({ from, address });

/** 같은 규칙을 서버 검증기에 넣었을 때 가려진 규칙 번호들(1부터). */
const serverShadowed = (rows: RuleText[]): number[] => {
  const d = decodeModel({
    listeners: [{ key: 'web', protocol: 'http', bind: '127.0.0.1', port: 18080, enabled: true, http: { defaultAction: 'reject' } }],
    httpRoutes: [{
      key: 'app', listener: 'web', hosts: ['app.test'], priority: 0, action: { kind: 'reject', status: 403 },
      sourceRules: rows.map((r) => ({
        from: r.from.split(/[\s,]+/).filter(Boolean), action: { kind: 'reject', status: 403 },
        ...(r.address === 'connection' ? { address: 'connection' } : {}),
      })),
    }],
    passthroughRoutes: [], pools: [], backends: [], certificates: [], tlsPolicies: [], sniBindings: [],
    addressSets: [...sets].map(([key, cidrs]) => ({ key, cidrs: [...cidrs] })),
  });
  if (!d.ok) throw new Error(JSON.stringify(d.issues));
  const hit = new Set<number>();
  for (const i of validateModel(d.model)) {
    if (i.code !== 'source_rule_shadowed') continue;
    const m = /출발지 규칙 (\d+) 의/.exec(i.message);
    if (m !== null) hit.add(Number(m[1]));
  }
  return [...hit].sort();
};
const guiShadowed = (rows: RuleText[]): number[] =>
  sourceRuleErrors(rows, sets).flatMap((e, i) => (e !== undefined && e.includes('안에 들어요') ? [i + 1] : []));

describe('가려진 규칙', () => {
  it('**시안 문구** — 집합은 이름과 대역을 함께 말한다', () => {
    expect(sourceRuleErrors([v('@private'), v('10.1.0.0/16')], sets)[1])
      .toBe('규칙 2의 10.1.0.0/16 대역은 규칙 1의 @private(10.0.0.0/8) 안에 들어요. 이 대역은 규칙 2로 오지 않아요. 좁은 대역을 위로 올려요.');
  });

  it('좁은 대역이 위면 괜찮다 · 같은 규칙 안끼리는 안 본다', () => {
    expect(sourceRuleErrors([v('10.1.0.0/16'), v('@private')], sets)).toEqual([undefined, undefined]);
    expect(sourceRuleErrors([v('10.0.0.0/8, 10.1.0.0/16')], sets)).toEqual([undefined]);
  });

  it('뒤 규칙의 집합이 펼쳐져서 가려진다', () => {
    expect(sourceRuleErrors([v('10.0.0.0/8'), v('@office')], sets)[1]).toContain('규칙 2의 @office(10.1.2.0/24) 대역은 규칙 1의 10.0.0.0/8 안에');
  });

  it('보는 주소가 다르면 비교하지 않는다', () => {
    expect(sourceRuleErrors([v('10.0.0.0/8', 'connection'), v('10.1.0.0/16')], sets)).toEqual([undefined, undefined]);
  });

  it('IPv6 끼리 본다 · IPv4 와 IPv6 은 서로 안 본다', () => {
    expect(sourceRuleErrors([v('@private'), v('fd12::/16')], sets)[1]).toContain('@private(fd00::/8)');
    expect(sourceRuleErrors([v('0.0.0.0/0'), v('2001:db8::/32')], sets)).toEqual([undefined, undefined]);
  });

  it('받침 있는 숫자는 「으로」', () => {
    expect(sourceRuleErrors([v('10.0.0.0/8'), v('10.0.0.1'), v('10.0.0.2')], sets)[2]).toContain('규칙 3으로 오지');
  });

  it('**서버 검증기와 같다**', () => {
    const cases: RuleText[][] = [
      [v('@private'), v('10.1.0.0/16')],
      [v('10.1.0.0/16'), v('@private')],
      [v('10.0.0.0/8', 'connection'), v('10.1.0.0/16')],
      [v('192.168.1.0/24'), v('@private'), v('192.168.1.7')],
      [v('fd00::/8'), v('fd00::1'), v('10.0.0.0/8')],
      [v('0.0.0.0/0'), v('::/0'), v('1.2.3.4'), v('2001:db8::1')],
      [v('10.0.0.1/8'), v('10.9.9.9')],
    ];
    for (const rows of cases) expect(guiShadowed(rows), JSON.stringify(rows)).toEqual(serverShadowed(rows));
  });
});

describe('대역 낱말', () => {
  it('대역이 아니거나 없는 집합이면 말한다 · 집합을 못 읽었으면 묻지 않는다', () => {
    expect(sourceRuleErrors([v('office')], sets)[0]).toContain('office는 대역이 아니에요');
    expect(sourceRuleErrors([v('@nope')], sets)[0]).toBe('주소 집합 @nope이 없어요.');
    expect(sourceRuleErrors([v('@nope')], new Map())[0]).toBeUndefined();
  });

  it('빈 행은 오류가 아니다', () => {
    expect(sourceRuleErrors([v('')], sets)).toEqual([undefined]);
  });
});

describe('경로별 묶음', () => {
  const line = (paths: string, from: string): RuleText => ({ paths, from, address: 'visitor' });

  it('줄 번호로 말하고 같은 라우트(정렬한 경로가 같은 줄)끼리만 본다', () => {
    const errs = sourceRuleErrors([line('/a, /b', '@private'), line('/c', '10.1.0.0/16'), line('/b /a', '10.1.0.0/16')], sets, { lines: true });
    expect(errs[1]).toBeUndefined();
    expect(errs[2]).toBe('3번째 줄의 10.1.0.0/16 대역은 1번째 줄의 @private(10.0.0.0/8) 안에 들어요. 이 대역은 이 줄로 오지 않아요. 좁은 대역을 위로 올려요.');
  });

  it('묶음 열쇠는 route-group 과 같다 — 빈 칸은 /', () => {
    expect(groupKeyOf('')).toBe(groupKeyOf('/'));
    expect(groupKeyOf('/b, /a /a')).toBe(groupKeyOf('/a /b'));
  });
});

describe('경로 바꾸기 미리보기 (gui/src/lib/forms/rewrite.ts)', () => {
  it('맞은 접두사를 갈고 질의 문자열은 그대로 붙인다 · 가장 긴 접두사를 고른다', () => {
    expect(rewritePath('/api/', '/v1/', '/api/users?id=1')).toBe('/v1/users?id=1');
    expect(rewritePath('/api/', '', '/api/users')).toBe('/api/users');
    expect(rewritePath('/api/', '/v1/', '/web/')).toBeUndefined();
    expect(matchPrefix(['/', '/api/'], '/api/x')).toBe('/api/');
    expect(exampleRequest(['/api'])).toBe('/api/users?id=1');
  });

  it('끝 / 가 경로마다 같아야 한다 — 해독기와 같은 판정', () => {
    expect(slashMismatch('/api/', '/v1')).toBe(true);
    expect(rewriteError('/v1', ['/api/'])).toBe('끝의 /가 접두사와 같아야 해요. 다르면 경로가 붙거나 겹쳐요.');
    expect(rewriteError('/v1/', ['/api/', '/v2/'])).toBeUndefined();
    expect(rewriteError('/$x/', ['/api/'])).toContain('만 써요');
    expect(rewriteError('v1/', ['/api/'])).toBe('경로는 /로 시작해야 해요.');
  });
});
