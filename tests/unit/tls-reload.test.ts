/**
 * **인증서 갱신이 재시작 없이 들어간다** (2026-10-19, stardust 문의).
 *
 * 인증서가 갱신돼 파일이 바뀌어도 데몬이 옛 인증서를 계속 내는 실패를 막는다. SIGHUP 이 부르는
 * `reloadApiTls` 가 지금 리스너에 새 인증서를 걸고, 새 연결이 새 인증서를 받는지 실제 TLS 로 잰다.
 * 틀린 파일이면 던지고 옛 인증서가 그대로 산다.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect } from 'node:tls';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { apiTlsOptions, reloadApiTls } from '../../src/api/server.js';

let dir = '';
let server: Server;
let port = 0;

function makeCert(name: string): { cert: string; key: string } {
  const cert = join(dir, `${name}.crt`);
  const key = join(dir, `${name}.key`);
  execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes',
    '-days', '1', '-subj', `/CN=${name}`, '-keyout', key, '-out', cert], { stdio: 'ignore' });
  return { cert, key };
}

/** 새 연결을 열어 서버가 낸 인증서의 CN 을 읽는다. */
function servedCn(): Promise<string> {
  return new Promise((resolve, reject) => {
    const s = connect({ host: '127.0.0.1', port, rejectUnauthorized: false }, () => {
      const cn = s.getPeerCertificate().subject?.CN;
      s.end();
      resolve(String(cn));
    });
    s.on('error', reject);
  });
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'bary-tls-'));
  const a = makeCert('old');
  const { readFileSync } = await import('node:fs');
  server = createServer(apiTlsOptions({ cert: readFileSync(a.cert, 'utf8'), key: readFileSync(a.key, 'utf8') }), (_q, r) => r.end('ok'));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(dir, { recursive: true, force: true });
});

describe('API 인증서 재적재', () => {
  it('**새 연결부터 새 인증서를 낸다** — 재시작 없이', async () => {
    expect(await servedCn()).toBe('old');
    const b = makeCert('new');
    const validTo = reloadApiTls(server, b);
    expect(validTo).toMatch(/GMT$/);
    expect(await servedCn()).toBe('new');
  });

  it('**짝이 안 맞거나 깨진 파일이면 던지고 옛 인증서가 산다**', async () => {
    const before = await servedCn();
    const c = makeCert('mismatch-cert');
    const d = makeCert('mismatch-key');
    expect(() => reloadApiTls(server, { cert: c.cert, key: d.key })).toThrow();
    const broken = join(dir, 'broken.crt');
    writeFileSync(broken, 'not a certificate');
    expect(() => reloadApiTls(server, { cert: broken, key: d.key })).toThrow();
    expect(() => reloadApiTls(server, { cert: join(dir, 'missing.crt'), key: d.key })).toThrow();
    expect(await servedCn()).toBe(before);
  });
});
