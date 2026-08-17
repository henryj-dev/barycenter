/**
 * 인증서 자료 검증 (DESIGN.md §7.2 · §4.6)
 *
 * §7.2 는 자료를 받은 **직후** *"인증서-키 일치·SAN·not_after"* 를 검증하라고 한다.
 * v0.6 1단계까지 하나도 없었다 — 체인과 무관한 키를 올려도 저장되고, 만료된 인증서도
 * 그대로 들어갔다.
 *
 * **왜 그게 나쁜가.** 실패가 사라지는 게 아니라 **옮겨간다.** 잘못된 한 쌍은 apply 의
 * `nginx -t` 에서 터지고, 그때 운영자가 보는 것은 "설정이 이상하다" 다. 원인은 며칠 전
 * 업로드인데. 만료는 더 나쁘다 — 아무 데서도 안 터지고 **그냥 handshake 가 깨진다.**
 *
 * 여기서는 실제 openssl 로 구운 인증서를 쓴다. 손으로 만든 문자열로 재면 파서가 아니라
 * 내 상상을 재게 된다.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  CertMaterialError, certCoversHost, inspectMaterial, type CertFacts,
} from '../../src/dp/certinfo.js';

let dir = '';

type Pair = { chain: string; key: string };

/** openssl 로 한 벌 굽는다. `days` 가 음수면 이미 만료된 것이 나온다. */
function mint(name: string, san: string, days = 2, notBeforeOffsetDays = 0): Pair {
  const base = join(dir, name.replace(/[^a-z0-9]/gi, '_'));
  const args = [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-subj', `/CN=${name}`, '-addext', `subjectAltName=${san}`,
    '-keyout', `${base}.key`, '-out', `${base}.crt`,
  ];
  if (days >= 0) args.push('-days', String(days));
  // 과거·미래로 밀 때는 `-not_before`/`-not_after` 대신 `-days` 와 `-set_serial` 조합이
  // 아니라 openssl 3 의 `-not_before` 를 쓴다. 없으면 테스트가 스스로 건너뛴다.
  if (notBeforeOffsetDays !== 0 || days < 0) {
    const fmt = (d: Date): string =>
      d.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
    const nb = new Date(Date.now() + notBeforeOffsetDays * 86_400_000);
    const na = new Date(Date.now() + (days < 0 ? days : days + notBeforeOffsetDays) * 86_400_000);
    args.push('-not_before', fmt(nb), '-not_after', fmt(na));
  }
  execFileSync('openssl', args, { stdio: 'ignore' });
  return {
    chain: readFileSync(`${base}.crt`, 'utf8'),
    key: readFileSync(`${base}.key`, 'utf8'),
  };
}

function opensslAvailable(): boolean {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const has = opensslAvailable();

beforeAll(() => {
  if (has) dir = mkdtempSync(join(tmpdir(), 'bary-certinfo-'));
});
afterAll(() => {
  if (dir !== '') rmSync(dir, { recursive: true, force: true });
});

describe.runIf(has)('사실을 바이트에서 뽑는다', () => {
  it('SAN·유효기간·subject 를 읽는다 — **CN 이 아니라 SAN 이다**', () => {
    const p = mint('a.test', 'DNS:a.test,DNS:*.a.test');
    const f = inspectMaterial(p.chain, p.key);
    // 현대 클라이언트는 CN 을 안 본다. 그래서 `domains` 는 SAN 에서만 나온다.
    expect(f.domains).toEqual(['a.test', '*.a.test']);
    expect(f.subject).toContain('CN=a.test');
    expect(new Date(f.notAfter).getTime()).toBeGreaterThan(Date.now());
    expect(f.chainLength).toBe(1);
  });

  it('체인이 여러 장이면 **leaf 를 첫 블록으로** 읽고 길이를 센다', () => {
    const leaf = mint('leaf.test', 'DNS:leaf.test');
    const other = mint('ca.test', 'DNS:ca.test');
    const f = inspectMaterial(`${leaf.chain}${other.chain}`, leaf.key);
    expect(f.domains).toEqual(['leaf.test']);
    expect(f.chainLength).toBe(2);
  });
});

describe.runIf(has)('틀린 것을 거절한다 — §7.2', () => {
  it('**개인키가 그 인증서 것이 아니면 거절한다**', () => {
    const a = mint('a2.test', 'DNS:a2.test');
    const b = mint('b2.test', 'DNS:b2.test');
    // 이걸 통과시키면 저장은 되고, 실패는 며칠 뒤 apply 의 `nginx -t` 에서 나타난다.
    try {
      inspectMaterial(a.chain, b.key);
      expect.unreachable('무관한 키가 통과했다');
    } catch (e) {
      expect((e as CertMaterialError).kind).toBe('key_mismatch');
    }
  });

  it('**만료된 인증서를 거절한다** — 아무 데서도 안 터지고 handshake 만 깨진다', () => {
    const p = mint('old.test', 'DNS:old.test');
    // 시각을 인자로 받는 이유가 이것이다. 안에서 `new Date()` 를 읽으면 이 검사가
    // 실제로 도는지 잴 방법이 없다.
    const future = new Date(new Date(inspectMaterial(p.chain, p.key).notAfter).getTime() + 1000);
    try {
      inspectMaterial(p.chain, p.key, future);
      expect.unreachable('만료된 인증서가 통과했다');
    } catch (e) {
      expect((e as CertMaterialError).kind).toBe('expired');
    }
  });

  it('아직 유효하지 않은 인증서도 거절한다 — 올리는 시점에 말해 준다', () => {
    const p = mint('soon.test', 'DNS:soon.test');
    const past = new Date(new Date(inspectMaterial(p.chain, p.key).notBefore).getTime() - 86_400_000);
    try {
      inspectMaterial(p.chain, p.key, past);
      expect.unreachable('미래 인증서가 통과했다');
    } catch (e) {
      expect((e as CertMaterialError).kind).toBe('not_yet_valid');
    }
  });

  it('PEM 이 아니면 거절한다', () => {
    expect(() => inspectMaterial('그냥 글자', 'x')).toThrow(CertMaterialError);
  });

  it('개인키 자리에 인증서를 넣어도 거절한다 — 헷갈려 바꿔 넣기 쉬운 자리다', () => {
    const p = mint('swap.test', 'DNS:swap.test');
    try {
      inspectMaterial(p.chain, p.chain);
      expect.unreachable('인증서를 키로 받아들였다');
    } catch (e) {
      expect((e as CertMaterialError).kind).toBe('not_pem');
    }
  });
});

describe('SAN 커버리지 — 와일드카드는 한 라벨만', () => {
  const facts = (domains: string[]): CertFacts => ({
    subject: '', issuer: '', domains,
    notBefore: '2020-01-01T00:00:00.000Z', notAfter: '2030-01-01T00:00:00.000Z',
    chainLength: 1,
  });

  it('exact 와 1라벨 와일드카드를 덮는다', () => {
    expect(certCoversHost(facts(['a.test']), 'a.test')).toBe(true);
    expect(certCoversHost(facts(['*.a.test']), 'x.a.test')).toBe(true);
  });

  it('**다중 라벨은 안 덮는다** — S17 이 실측한 X.509 규칙이다', () => {
    expect(certCoversHost(facts(['*.a.test']), 'deep.x.a.test')).toBe(false);
    // 와일드카드는 자기 자신도 안 덮는다.
    expect(certCoversHost(facts(['*.a.test']), 'a.test')).toBe(false);
  });

  it('대소문자를 안 가린다 — SNI 는 대소문자 무시다 (E21)', () => {
    expect(certCoversHost(facts(['A.Test']), 'a.test')).toBe(true);
    expect(certCoversHost(facts(['*.a.test']), 'X.A.TEST')).toBe(true);
  });
});
