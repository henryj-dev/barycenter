/**
 * dns-01 — RFC 2136 동적 갱신(TSIG). BIND 의 `nsupdate` 를 부른다.
 *
 * ── 왜 직접 구현하지 않고 `nsupdate` 인가
 *
 * DNS UPDATE + TSIG 를 직접 만들 수는 있다(UDP/TCP 와이어 형식 + HMAC). 그러나 그것은 서명 · 시각 · 잘림 처리가
 * 얽힌 보안 프로토콜이고, 이 저장소의 시험은 진짜 이름서버에 대고 맞춰 볼 수 없다. 맞는지 확인할 수 없는 서명
 * 코드를 들이는 것보다, ISC 의 기준 구현을 **쉘 없이** 부르는 편이 안전하다고 판단했다.
 *
 * 안전하게 부르는 방법:
 *   - `spawn(nsupdate, ['-k', 키파일])` — 쉘을 거치지 않는다. 명령은 표준입력으로 준다.
 *   - 이름 · 값 · 서버는 미리 거른다(`validTxtName` · `validTxtValue` · 서버 형식). 줄바꿈이 섞일 수 없다.
 *   - TSIG 키는 파일 경로만 넘긴다(인자 · 입력에 비밀이 없다). 타임아웃 · 출력 상한.
 *
 * 평문 DNS 다 — TSIG 는 위조를 막지 내용을 숨기지 않는다. TXT 값은 원래 공개되는 값이라 괜찮다.
 */
import { spawn } from 'node:child_process';

import { fail, OK, validTxtName, validTxtValue, type Dns01Provider, type DnsResult } from './provider.js';

export type RunResult = { code: number | null; stdout: string; stderr: string; error?: string };
export type Runner = (cmd: string, args: string[], stdin: string, timeoutMs: number) => Promise<RunResult>;

export type Rfc2136Options = {
  /** 이름서버 — `ns1.example.com` · `192.0.2.1` · `[2001:db8::1]:5353` 꼴. */
  server: string;
  /** BIND 형식 TSIG 키 파일(`key "name" { algorithm hmac-sha256; secret "…"; };`). */
  keyFile: string;
  zone?: string;
  nsupdate?: string;
  run?: Runner;
  timeoutMs?: number;
};

const MAX_OUTPUT = 64 * 1024;

export function validServer(s: string): { host: string; port?: string } | undefined {
  const m = /^\[([0-9A-Fa-f:.]+)\](?::(\d{1,5}))?$/.exec(s) ?? /^([A-Za-z0-9.-]+)(?::(\d{1,5}))?$/.exec(s) ?? /^([0-9A-Fa-f:]+)$/.exec(s);
  if (m === null || m[1] === undefined) return undefined;
  return m[2] === undefined ? { host: m[1] } : { host: m[1], port: m[2] };
}

export const spawnRunner: Runner = (cmd, args, stdin, timeoutMs) => new Promise((resolve) => {
  let out = '';
  let err = '';
  let done = false;
  const finish = (r: RunResult): void => {
    if (done) return;
    done = true;
    resolve(r);
  };
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], shell: false, timeout: timeoutMs, killSignal: 'SIGKILL' });
  } catch (e) {
    finish({ code: null, stdout: '', stderr: '', error: (e as Error).message });
    return;
  }
  child.stdout?.on('data', (b: Buffer) => { if (out.length < MAX_OUTPUT) out += b.toString('utf8'); });
  child.stderr?.on('data', (b: Buffer) => { if (err.length < MAX_OUTPUT) err += b.toString('utf8'); });
  child.on('error', (e: NodeJS.ErrnoException) => finish({ code: null, stdout: out, stderr: err, error: e.code ?? e.message }));
  child.on('close', (code, signal) => finish({ code, stdout: out, stderr: err, ...(signal === null ? {} : { error: `신호 ${signal}(타임아웃?)` }) }));
  child.stdin?.on('error', () => undefined);
  child.stdin?.end(stdin);
});

export function rfc2136Dns01(o: Rfc2136Options): Dns01Provider {
  const server = validServer(o.server);
  if (server === undefined) throw new Error(`RFC 2136 서버 형식이 아니다: ${JSON.stringify(o.server)}`);
  if (o.zone !== undefined && !validTxtName(o.zone.replace(/\.$/, ''))) throw new Error(`RFC 2136 영역 이름 형식이 아니다: ${JSON.stringify(o.zone)}`);
  const run = o.run ?? spawnRunner;

  const update = async (op: 'add' | 'delete', name: string, value: string): Promise<DnsResult> => {
    if (!validTxtName(name) || !validTxtValue(value)) return fail('rejected', `TXT 이름 · 값 형식이 아니다: ${JSON.stringify(name)}`);
    const lines = [
      `server ${server.host}${server.port === undefined ? '' : ` ${server.port}`}`,
      ...(o.zone === undefined ? [] : [`zone ${o.zone}`]),
      op === 'add' ? `update add ${name}. 60 IN TXT "${value}"` : `update delete ${name}. IN TXT "${value}"`,
      'send',
      'quit',
      '',
    ];
    const r = await run(o.nsupdate ?? 'nsupdate', ['-k', o.keyFile], lines.join('\n'), o.timeoutMs ?? 15_000);
    if (r.code === 0) return OK;
    const said = `${r.stderr} ${r.stdout}`.replace(/\s+/g, ' ').trim().slice(0, 300);
    if (r.error === 'ENOENT') return fail('unavailable', `nsupdate 를 찾지 못했다 (${o.nsupdate ?? 'nsupdate'}) — bind-utils/dnsutils 를 설치한다`);
    if (r.error !== undefined && r.code === null) return fail('unavailable', `nsupdate 실행 실패: ${r.error} ${said}`.trim());
    if (/NOTAUTH|BADSIG|BADKEY|BADTIME|tsig/i.test(said)) return fail('auth', `이름서버가 TSIG 키를 거절했다: ${said}`);
    if (/NOTZONE/.test(said)) return fail('zone-not-found', `이름서버에 그 영역이 없다: ${said}`);
    if (/REFUSED/.test(said)) return fail('rejected', `이름서버가 갱신을 거절했다: ${said}`);
    return fail('unavailable', `nsupdate 가 ${r.code ?? '?'} 로 끝났다: ${said}`);
  };

  return {
    kind: 'rfc2136',
    addTxt: (name, value) => update('add', name, value),
    removeTxt: (name, value) => update('delete', name, value),
  };
}
