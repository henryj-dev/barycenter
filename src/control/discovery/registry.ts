/**
 * 백엔드 디스커버리 출처 등록부 (2026-11-05) — 풀의 `discovery.source` 이름으로 고른다.
 *
 * 다른 출처를 붙이려면: `DiscoverySource` 를 구현한 파일 하나 + 아래 표에 한 줄 + 모델의 `DISCOVERY_SOURCE_KINDS`.
 * 표의 타입이 `Record<DiscoverySourceKind, …>` 라서 모델에 이름을 더하고 여기를 잊으면 컴파일이 막는다.
 *
 * ── 설정 (env) ─────────────────────────────────────────────────────────
 *
 *   BARY_DISCOVERY_INTERVAL_MS     폴링 간격 (기본 30000, 지터 ±10%)
 *   BARY_DISCOVERY_TIMEOUT_MS      한 번 묻는 시간 상한 (기본 5000)
 *   BARY_DISCOVERY_DNS_SERVERS     SRV 를 물을 서버 IP (쉼표). 없으면 시스템 설정
 *   BARY_DISCOVERY_CONSUL_URL      https 주소. 없으면 Consul 출처가 꺼진다
 *   BARY_DISCOVERY_CONSUL_TOKEN_FILE   ACL 토큰 파일 (선택)
 *   BARY_DISCOVERY_K8S_URL         API 서버 https 주소. 클러스터 안(`KUBERNETES_SERVICE_HOST`)이면 기본값이 있다
 *   BARY_DISCOVERY_K8S_TOKEN_FILE  서비스 계정 토큰 파일 (클러스터 안 기본: …/serviceaccount/token)
 *   BARY_DISCOVERY_K8S_CA_FILE     API 서버 CA (클러스터 안 기본: …/serviceaccount/ca.crt)
 *   BARY_DISCOVERY_FILE_DIR        파일 출처의 디렉터리. 없으면 파일 출처가 꺼진다
 *
 * **반만 설정하면 기동을 거부한다** — 토큰 파일만 주고 주소를 안 주면 조용히 꺼진 출처가 되고, 그 풀은 운영자가
 * 모르는 채 정적 백엔드로 돈다. 설정이 하나도 없으면 DNS SRV 만 쓸 수 있다(시스템 리졸버) — 그 출처를 쓰는 풀이
 * 없으면 지금 동작과 같다.
 *
 * 비밀(토큰)은 파일로만 받는다. 값을 env 에 두지 않는다. 파일은 **부를 때마다** 읽는다(회전하는 토큰).
 */
import { existsSync, readFileSync } from 'node:fs';
import { isIP } from 'node:net';

import type { DiscoverySourceKind } from '../../model/provisional.js';
import { fetchWithCa, type FetchLike } from '../sources/fetch.js';
import { consulSource } from './consul.js';
import { dnsSrvSource, type DnsLookups } from './dns-srv.js';
import { fileSource } from './file.js';
import { kubernetesSource } from './kubernetes.js';
import type { DiscoverySource } from './source.js';

export type DiscoveryConfig = {
  intervalMs: number;
  timeoutMs: number;
  dns: { servers?: string[]; lookups?: DnsLookups };
  consul?: { baseUrl: string; tokenFile?: string };
  kubernetes?: { baseUrl: string; tokenFile: string; caFile?: string };
  file?: { dir: string };
  /** 시험이 주입한다. 없으면 전역 fetch (Kubernetes 는 CA 를 정한 fetch). */
  fetch?: FetchLike;
  /** 시험이 주입한다. */
  readText?: (path: string) => string;
};

const IN_CLUSTER_TOKEN = '/var/run/secrets/kubernetes.io/serviceaccount/token';
const IN_CLUSTER_CA = '/var/run/secrets/kubernetes.io/serviceaccount/ca.crt';

type Make = (c: DiscoveryConfig) => DiscoverySource | undefined;

const SOURCES: Readonly<Record<DiscoverySourceKind, Make>> = {
  'dns-srv': (c) => dnsSrvSource({
    timeoutMs: c.timeoutMs,
    ...(c.dns.servers === undefined ? {} : { servers: c.dns.servers }),
    ...(c.dns.lookups === undefined ? {} : { lookups: c.dns.lookups }),
  }),
  consul: (c) => {
    if (c.consul === undefined) return undefined;
    const read = c.readText ?? ((p: string) => readFileSync(p, 'utf8'));
    const tokenFile = c.consul.tokenFile;
    return consulSource({
      baseUrl: c.consul.baseUrl,
      timeoutMs: c.timeoutMs,
      ...(tokenFile === undefined ? {} : { token: () => read(tokenFile) }),
      ...(c.fetch === undefined ? {} : { fetch: c.fetch }),
    });
  },
  kubernetes: (c) => {
    const k = c.kubernetes;
    if (k === undefined) return undefined;
    const read = c.readText ?? ((p: string) => readFileSync(p, 'utf8'));
    const f = c.fetch ?? (k.caFile === undefined ? undefined : fetchWithCa(read(k.caFile)));
    return kubernetesSource({
      baseUrl: k.baseUrl,
      timeoutMs: c.timeoutMs,
      token: () => read(k.tokenFile),
      ...(f === undefined ? {} : { fetch: f }),
    });
  },
  file: (c) => (c.file === undefined ? undefined : fileSource({ dir: c.file.dir })),
};

export function discoveryKinds(): string[] {
  return Object.keys(SOURCES);
}

/**
 * 이름 → 출처. **모르는 이름이면 던진다**(모델 해독기가 먼저 막으므로 여기 오면 프로그래밍 오류다).
 * 이 데몬에 설정되지 않은 출처면 `undefined` — 러너가 그 풀을 「설정 안 됨」 으로 보이고 정적 백엔드를 쓴다.
 */
export function discoverySource(kind: string, c: DiscoveryConfig): DiscoverySource | undefined {
  const make = Object.hasOwn(SOURCES, kind) ? SOURCES[kind as DiscoverySourceKind] : undefined;
  if (make === undefined) throw new Error(`모르는 디스커버리 출처: ${kind} (쓸 수 있는 것: ${discoveryKinds().join(', ')})`);
  return make(c);
}

/** 이름마다 한 번 만든다(Kubernetes 의 CA 를 한 번 읽는다). */
export function discoverySources(c: DiscoveryConfig): (kind: DiscoverySourceKind) => DiscoverySource | undefined {
  const made = new Map<DiscoverySourceKind, DiscoverySource | undefined>();
  for (const k of Object.keys(SOURCES) as DiscoverySourceKind[]) made.set(k, discoverySource(k, c));
  return (kind) => made.get(kind);
}

/** 어떤 출처가 켜졌나 — 기동 로그 · `/discovery` 가 말한다. */
export function configuredKinds(c: DiscoveryConfig): DiscoverySourceKind[] {
  return (Object.keys(SOURCES) as DiscoverySourceKind[]).filter((k) => SOURCES[k](c) !== undefined);
}

const intOf = (raw: string | undefined, name: string, dflt: number, min: number, max: number): number => {
  if (raw === undefined || raw.trim() === '') return dflt;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name} 은 ${min}~${max} 의 정수다 (받은 것: ${raw})`);
  return n;
};

const httpsUrl = (raw: string, name: string): string => {
  let ok = false;
  try { ok = new URL(raw).protocol === 'https:'; } catch { ok = false; }
  if (!ok) throw new Error(`${name} 은 https 주소여야 한다 (받은 것: ${raw}) — 받은 주소가 곧 트래픽을 보낼 곳이다`);
  return raw.replace(/\/+$/, '');
};

/**
 * env → 설정. **반만 설정되면 던진다**(기동 거부). 파일은 여기서 한 번 읽어 본다 — 못 읽는 토큰 파일로 뜨면
 * 첫 폴링에서야 알게 된다.
 */
export function discoveryConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  exists: (p: string) => boolean = existsSync,
  read: (p: string) => string = (p) => readFileSync(p, 'utf8'),
): DiscoveryConfig {
  const v = (k: string): string => (env[k] ?? '').trim();
  const intervalMs = intOf(env['BARY_DISCOVERY_INTERVAL_MS'], 'BARY_DISCOVERY_INTERVAL_MS', 30_000, 1_000, 86_400_000);
  const timeoutMs = intOf(env['BARY_DISCOVERY_TIMEOUT_MS'], 'BARY_DISCOVERY_TIMEOUT_MS', 5_000, 100, 60_000);
  const mustRead = (p: string, name: string): void => {
    try { read(p); } catch (e) { throw new Error(`${name} (${p}) 를 읽지 못했다: ${e instanceof Error ? e.message : String(e)}`); }
  };

  const servers = v('BARY_DISCOVERY_DNS_SERVERS').split(',').map((s) => s.trim()).filter((s) => s !== '');
  for (const s of servers) {
    if (isIP(s) === 0) throw new Error(`BARY_DISCOVERY_DNS_SERVERS 는 IP 목록이다 — 포트 없이 (받은 것: ${s})`);
  }

  const consulUrl = v('BARY_DISCOVERY_CONSUL_URL');
  const consulToken = v('BARY_DISCOVERY_CONSUL_TOKEN_FILE');
  if (consulUrl === '' && consulToken !== '') {
    throw new Error('BARY_DISCOVERY_CONSUL_TOKEN_FILE 을 줬으면 BARY_DISCOVERY_CONSUL_URL 도 필요하다');
  }
  if (consulToken !== '') mustRead(consulToken, 'BARY_DISCOVERY_CONSUL_TOKEN_FILE');

  let k8sUrl = v('BARY_DISCOVERY_K8S_URL');
  let k8sToken = v('BARY_DISCOVERY_K8S_TOKEN_FILE');
  let k8sCa = v('BARY_DISCOVERY_K8S_CA_FILE');
  const inCluster = v('KUBERNETES_SERVICE_HOST') !== '';
  if (k8sUrl === '' && inCluster && (k8sToken !== '' || exists(IN_CLUSTER_TOKEN))) {
    const host = v('KUBERNETES_SERVICE_HOST');
    const port = v('KUBERNETES_SERVICE_PORT') || '443';
    k8sUrl = `https://${host.includes(':') ? `[${host}]` : host}:${port}`;
  }
  if (k8sUrl !== '') {
    if (k8sToken === '' && exists(IN_CLUSTER_TOKEN)) k8sToken = IN_CLUSTER_TOKEN;
    if (k8sCa === '' && exists(IN_CLUSTER_CA)) k8sCa = IN_CLUSTER_CA;
    if (k8sToken === '') {
      throw new Error('BARY_DISCOVERY_K8S_URL 을 줬으면 BARY_DISCOVERY_K8S_TOKEN_FILE 도 필요하다 (클러스터 밖에는 기본 토큰이 없다)');
    }
    mustRead(k8sToken, 'BARY_DISCOVERY_K8S_TOKEN_FILE');
    if (k8sCa !== '') mustRead(k8sCa, 'BARY_DISCOVERY_K8S_CA_FILE');
  } else if (k8sToken !== '' || k8sCa !== '') {
    throw new Error('BARY_DISCOVERY_K8S_TOKEN_FILE · _CA_FILE 을 줬으면 BARY_DISCOVERY_K8S_URL 도 필요하다 (클러스터 밖)');
  }

  const dir = v('BARY_DISCOVERY_FILE_DIR');
  if (dir !== '' && !exists(dir)) throw new Error(`BARY_DISCOVERY_FILE_DIR (${dir}) 가 없다`);

  return {
    intervalMs, timeoutMs,
    dns: servers.length === 0 ? {} : { servers },
    ...(consulUrl === '' ? {} : {
      consul: {
        baseUrl: httpsUrl(consulUrl, 'BARY_DISCOVERY_CONSUL_URL'),
        ...(consulToken === '' ? {} : { tokenFile: consulToken }),
      },
    }),
    ...(k8sUrl === '' ? {} : {
      kubernetes: {
        baseUrl: httpsUrl(k8sUrl, 'BARY_DISCOVERY_K8S_URL'),
        tokenFile: k8sToken,
        ...(k8sCa === '' ? {} : { caFile: k8sCa }),
      },
    }),
    ...(dir === '' ? {} : { file: { dir } }),
    readText: read,
  };
}
