/**
 * dns-01 공급자 등록부 — `BARY_DNS01_KIND` 의 이름으로 고른다.
 *
 *   (없음)       `BARY_DNS01_DIR` 이 있으면 `file`, 없으면 dns-01 을 끈다 — **지금 동작 그대로**.
 *   file         TXT 를 파일로(`FileDns01`). 실제 DNS 반영은 운영자 몫.
 *   cloudflare   API 토큰 파일 · 영역 id 또는 이름(없으면 찾는다).
 *   powerdns     API 주소 · API 키 파일 · 서버 id · 영역(없으면 찾는다).
 *   route53      호스팅 영역 id · 접근 키 id · 비밀 키 파일(SigV4 직접).
 *   rfc2136      이름서버 · TSIG 키 파일 · 영역(`nsupdate` 를 쉘 없이).
 *
 * 다른 공급자를 붙이려면: `Dns01Provider` 를 구현한 파일 하나 + 아래 `PROVIDERS` 에 한 줄.
 *
 * **반만 설정하면 기동을 거부한다** — 공급자 변수를 적었는데 종류를 안 골랐거나, 고른 종류에 필요한 값이 빠졌거나,
 * 다른 종류의 변수가 섞였으면 던진다. 조용히 dns-01 이 꺼진 채 와일드카드 주문이 실패하는 상태를 만들지 않는다.
 */
import { existsSync } from 'node:fs';

import type { ChallengePlacer } from '../acme-runner.js';
import { FileDns01 } from '../dns01.js';
import { envOf, readFileUtf8, readSecretFile, required, type ReadFile } from '../../outbound/secret-file.js';
import { insecureReason } from '../../outbound/http.js';
import { envInt } from '../../validate/env.js';
import { cloudflareDns01 } from './cloudflare.js';
import { Dns01Placer } from './placer.js';
import type { PropagationOptions } from './propagation.js';
import { powerDns01 } from './powerdns.js';
import type { Dns01Provider } from './provider.js';
import { rfc2136Dns01, validServer } from './rfc2136.js';
import { route53Dns01 } from './route53.js';

export type Dns01Deps = { readFile?: ReadFile; fetch?: typeof fetch; fileExists?: (p: string) => boolean };

type Spec = {
  /** 이 종류가 읽는 변수(없으면 안 되는 것 · 있어도 되는 것). 다른 종류의 변수가 섞였는지 가르는 데 쓴다. */
  vars: readonly string[];
  make: (env: NodeJS.ProcessEnv, d: Required<Pick<Dns01Deps, 'readFile' | 'fileExists'>> & Dns01Deps) => Dns01Provider;
};

const why = (kind: string): string => `BARY_DNS01_KIND=${kind}`;
const fetchOf = (d: Dns01Deps): { fetch?: typeof fetch } => (d.fetch === undefined ? {} : { fetch: d.fetch });
const https = (name: string, url: string): string => {
  const bad = insecureReason(url);
  if (bad !== undefined) throw new Error(`${name}: ${bad}`);
  return url;
};

const PROVIDERS: Readonly<Record<string, Spec>> = {
  cloudflare: {
    vars: ['BARY_DNS01_CLOUDFLARE_TOKEN_FILE', 'BARY_DNS01_ZONE'],
    make: (env, d) => {
      const zone = envOf(env, 'BARY_DNS01_ZONE');
      return cloudflareDns01({
        token: readSecretFile('BARY_DNS01_CLOUDFLARE_TOKEN_FILE', required(env, 'BARY_DNS01_CLOUDFLARE_TOKEN_FILE', why('cloudflare')), d.readFile),
        ...(zone === undefined ? {} : { zone }), ...fetchOf(d),
      });
    },
  },
  powerdns: {
    vars: ['BARY_DNS01_POWERDNS_URL', 'BARY_DNS01_POWERDNS_API_KEY_FILE', 'BARY_DNS01_POWERDNS_SERVER', 'BARY_DNS01_ZONE'],
    make: (env, d) => {
      const zone = envOf(env, 'BARY_DNS01_ZONE');
      const server = envOf(env, 'BARY_DNS01_POWERDNS_SERVER');
      return powerDns01({
        apiUrl: https('BARY_DNS01_POWERDNS_URL', required(env, 'BARY_DNS01_POWERDNS_URL', why('powerdns'))),
        apiKey: readSecretFile('BARY_DNS01_POWERDNS_API_KEY_FILE', required(env, 'BARY_DNS01_POWERDNS_API_KEY_FILE', why('powerdns')), d.readFile),
        ...(zone === undefined ? {} : { zone }), ...(server === undefined ? {} : { server }), ...fetchOf(d),
      });
    },
  },
  route53: {
    vars: ['BARY_DNS01_ZONE', 'BARY_DNS01_AWS_ACCESS_KEY_ID', 'BARY_DNS01_AWS_SECRET_ACCESS_KEY_FILE'],
    make: (env, d) => route53Dns01({
      hostedZoneId: required(env, 'BARY_DNS01_ZONE', `${why('route53')}(호스팅 영역 id)`),
      credentials: {
        accessKeyId: required(env, 'BARY_DNS01_AWS_ACCESS_KEY_ID', why('route53')),
        secretAccessKey: readSecretFile('BARY_DNS01_AWS_SECRET_ACCESS_KEY_FILE', required(env, 'BARY_DNS01_AWS_SECRET_ACCESS_KEY_FILE', why('route53')), d.readFile),
      },
      ...fetchOf(d),
    }),
  },
  rfc2136: {
    vars: ['BARY_DNS01_RFC2136_SERVER', 'BARY_DNS01_RFC2136_KEY_FILE', 'BARY_DNS01_RFC2136_NSUPDATE', 'BARY_DNS01_ZONE'],
    make: (env, d) => {
      const server = required(env, 'BARY_DNS01_RFC2136_SERVER', why('rfc2136'));
      if (validServer(server) === undefined) throw new Error(`BARY_DNS01_RFC2136_SERVER 형식이 아니다: ${JSON.stringify(server)}`);
      const keyFile = required(env, 'BARY_DNS01_RFC2136_KEY_FILE', why('rfc2136'));
      // 키는 nsupdate 가 읽는다 — 여기서는 있는지 · 비지 않았는지만 본다(값을 들고 있지 않는다).
      if (!d.fileExists(keyFile)) throw new Error(`BARY_DNS01_RFC2136_KEY_FILE(${keyFile}) 이 없다`);
      readSecretFile('BARY_DNS01_RFC2136_KEY_FILE', keyFile, d.readFile);
      const zone = envOf(env, 'BARY_DNS01_ZONE');
      const nsupdate = envOf(env, 'BARY_DNS01_RFC2136_NSUPDATE');
      return rfc2136Dns01({ server, keyFile, ...(zone === undefined ? {} : { zone }), ...(nsupdate === undefined ? {} : { nsupdate }) });
    },
  },
};

const COMMON_VARS = ['BARY_DNS01_KIND', 'BARY_DNS01_DIR', 'BARY_DNS01_PROPAGATION_TIMEOUT_S', 'BARY_DNS01_PROPAGATION_INTERVAL_S'];

export function dns01Kinds(): string[] {
  return ['file', ...Object.keys(PROVIDERS)];
}

export type Dns01Setup = { kind: string; placer: ChallengePlacer; propagation?: PropagationOptions };

/**
 * env 에서 dns-01 배치기를 만든다. 끄는 설정이면 `undefined`. 반만 설정이면 던진다.
 */
export function dns01FromEnv(env: NodeJS.ProcessEnv = process.env, deps: Dns01Deps = {}): Dns01Setup | undefined {
  const d = { readFile: deps.readFile ?? readFileUtf8, fileExists: deps.fileExists ?? existsSync, ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }) };
  const set = Object.keys(env).filter((k) => k.startsWith('BARY_DNS01_') && envOf(env, k) !== undefined);
  const dir = envOf(env, 'BARY_DNS01_DIR');
  const kind = envOf(env, 'BARY_DNS01_KIND') ?? (dir !== undefined ? 'file' : undefined);

  if (kind === undefined) {
    if (set.length > 0) throw new Error(`dns-01 변수(${set.join(', ')})를 적었지만 BARY_DNS01_KIND 가 없다 (${dns01Kinds().join(' | ')})`);
    return undefined;
  }
  if (kind !== 'file' && !Object.hasOwn(PROVIDERS, kind)) {
    throw new Error(`모르는 dns-01 공급자: ${kind} (쓸 수 있는 것: ${dns01Kinds().join(', ')})`);
  }
  const allowed = new Set([...COMMON_VARS, ...(kind === 'file' ? [] : PROVIDERS[kind]!.vars)]);
  const stray = set.filter((k) => !allowed.has(k) || (k === 'BARY_DNS01_DIR' && kind !== 'file'));
  if (stray.length > 0) throw new Error(`BARY_DNS01_KIND=${kind} 에 쓰지 않는 변수가 있다: ${stray.join(', ')} — 다른 공급자의 설정이 섞였나 본다`);

  if (kind === 'file') {
    if (dir === undefined) throw new Error('BARY_DNS01_KIND=file — BARY_DNS01_DIR 이 필요하다');
    // 지금 동작 그대로 — 파일을 쓰고 기다리지 않는다(반영은 운영자 몫).
    return { kind, placer: new FileDns01(dir) };
  }

  const provider = PROVIDERS[kind]!.make(env, d);
  const timeoutS = envInt('BARY_DNS01_PROPAGATION_TIMEOUT_S', 60, { min: 0, max: 3600 }, env);
  const intervalS = envInt('BARY_DNS01_PROPAGATION_INTERVAL_S', 5, { min: 1, max: 600 }, env);
  const propagation = timeoutS === 0 ? undefined : { timeoutMs: timeoutS * 1000, intervalMs: intervalS * 1000 };
  return { kind, placer: new Dns01Placer(provider, propagation), ...(propagation === undefined ? {} : { propagation }) };
}
