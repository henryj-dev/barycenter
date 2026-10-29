/**
 * 리스너 출발지 제한의 **저작 표면** — GUI 폼과 CLI `--allow` 가 같은 자리를 쓴다 (2026-10-29).
 *
 * `parseSourceAllow` 가 끊기·검사의 유일한 자리다. 다섯 리스너 빌더가 모두 받고, **안 적으면
 * 키를 안 만든다** — 빈 배열을 실으면 해독기가 거절하고, 키만 있어도 렌더가 바뀐다.
 */
import { describe, expect, it } from 'vitest';

import {
  parseSourceAllow,
  putHttpListenerPatch, putHttpsListenerPatch, putPassthroughListenerPatch,
  putTcpListenerPatch, putUdpListenerPatch,
} from '../../src/web/edit.js';
import { listenerCreatePatch } from '../../src/cli/listener.js';
import { decodeModel } from '../../src/model/decode.js';

const CF = ['173.245.48.0/20', '2400:cb00::/32'];

describe('parseSourceAllow', () => {
  it('줄바꿈·쉼표·공백으로 끊는다 — Cloudflare 목록을 그대로 붙여 넣는다', () => {
    expect(parseSourceAllow('173.245.48.0/20\n2400:cb00::/32\n')).toEqual(CF);
    expect(parseSourceAllow('173.245.48.0/20, 2400:cb00::/32')).toEqual(CF);
    expect(parseSourceAllow(['173.245.48.0/20', '2400:cb00::/32'])).toEqual(CF);
  });

  it('여러 플래그와 파일을 합치고 중복을 접는다', () => {
    expect(parseSourceAllow(['10.0.0.0/8,10.0.0.0/8', '10.0.0.0/8\n192.168.0.0/16']))
      .toEqual(['10.0.0.0/8', '192.168.0.0/16']);
  });

  it('비었으면 undefined — 키를 안 만든다', () => {
    expect(parseSourceAllow(undefined)).toBeUndefined();
    expect(parseSourceAllow('')).toBeUndefined();
    expect(parseSourceAllow(' \n , ')).toBeUndefined();
    expect(parseSourceAllow([])).toBeUndefined();
  });

  it('CIDR 이 아니면 저장 전에 거절한다 — 해독기와 같은 판정이다', () => {
    expect(() => parseSourceAllow('10.0.0.0/8\ncloudflare')).toThrow(/cloudflare/);
    expect(() => parseSourceAllow('10.0.0.0/33')).toThrow(/CIDR/);
  });
});

describe('다섯 리스너 빌더가 모두 받는다', () => {
  const builds = [
    ['http', putHttpListenerPatch('l', { bind: '0.0.0.0', port: 80, pool: 'app', sourceAllow: CF })],
    ['https', putHttpsListenerPatch('l', { bind: '0.0.0.0', port: 443, pool: 'app', policy: 'p', certificate: 'c', sourceAllow: CF })],
    ['tcp', putTcpListenerPatch('l', { bind: '0.0.0.0', port: 9000, pool: 'l4', sourceAllow: CF })],
    ['udp', putUdpListenerPatch('l', { bind: '0.0.0.0', port: 53, pool: 'dns', preset: 'dns', sourceAllow: CF })],
    ['tls_passthrough', putPassthroughListenerPatch('l', { bind: '0.0.0.0', port: 8443, sourceAllow: CF })],
  ] as const;

  it.each(builds)('%s', (_, ops) => {
    expect(ops[0]!.body.sourceAllow).toEqual(CF);
  });

  it('안 적으면 키가 없다 — 렌더 바이트가 안 바뀐다', () => {
    const ops = putTcpListenerPatch('l', { bind: '0.0.0.0', port: 9000, pool: 'l4' });
    expect('sourceAllow' in ops[0]!.body).toBe(false);
    const empty = putTcpListenerPatch('l', { bind: '0.0.0.0', port: 9000, pool: 'l4', sourceAllow: [] });
    expect('sourceAllow' in empty[0]!.body).toBe(false);
  });

  it('만든 body 를 실제 해독기가 받는다', () => {
    const [op] = putTcpListenerPatch('l', { bind: '0.0.0.0', port: 9000, pool: 'l4', sourceAllow: CF });
    const r = decodeModel({
      listeners: [{ key: op!.key, ...op!.body }],
      httpRoutes: [], passthroughRoutes: [],
      pools: [{ key: 'l4', protocolClass: 'tcp', algorithm: 'round_robin' }],
      backends: [], certificates: [], tlsPolicies: [], sniBindings: [],
    });
    expect(r.ok).toBe(true);
  });
});

describe('CLI — `bary listener create --allow`', () => {
  it.each(['http', 'tcp', 'udp', 'tls_passthrough'])('%s 에 실린다', (protocol) => {
    const ops = listenerCreatePatch({
      name: 'l', protocol, bind: '0.0.0.0', port: 9000, pool: 'p', preset: 'dns', sourceAllow: CF,
    });
    expect(ops?.[0]?.body.sourceAllow).toEqual(CF);
  });
});
