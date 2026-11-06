/**
 * SQLite 배치 검사 — 기동 때 거부할 조합 (docs/adr-multi-db.md 「SQLite 의 한계」)
 *
 * SQLite 는 **파일**이다. 한 파일을 여러 호스트가 함께 쓰면 안 된다 — 네트워크 파일시스템 위의 `fcntl`
 * 잠금은 믿을 수 없고, 그러면 쓰기 직렬화(`BEGIN IMMEDIATE`)도 리더 잠금 파일도 뜻을 잃는다. 그래서:
 *
 * 1. **클러스터 모드(`BARY_CLUSTER=1`)에서 설정 DB · 계정 DB 가 SQLite 면 거부한다.** 클러스터는 여러 호스트가
 *    설정 DB 하나를 공유하는 배치다(ADR-CLUSTER).
 * 2. **SQLite 파일이 네트워크 파일시스템(NFS · SMB/CIFS · Ceph · AFS · Lustre) 위면 거부한다.** 리눅스의
 *    `statfs` 형 번호로 가른다. 다른 OS 는 이 검사를 하지 않는다(형 번호 체계가 다르다 — 런북에 적었다).
 * 3. **전역 화면(`BARY_GLOBAL_HOST`)이 켜졌고 계정 DB 가 SQLite 면, 모든 지역의 API 주소가 이 호스트여야 한다.**
 *    전역과 지역은 계정 DB 를 공유한다(`BARY_ACCOUNTS_DSN`). 파일을 공유하려면 같은 호스트다. 지역 API 주소의
 *    호스트 이름을 풀어 **이 호스트의 주소**(루프백 포함)인지 본다. 지역이 다른 호스트면 계정 DB 를 공유 서버
 *    DB(PG)로 둔다 — 설정 DB 만 SQLite 인 것은 괜찮다(ADR 의 두 갈래).
 *
 * 조용히 고치지 않는다. 사유를 말하고 멈춘다.
 */
import { lookup } from 'node:dns/promises';
import { statfsSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { dirname } from 'node:path';

import { dbKindOf } from './db.js';
import { sqlitePathOf } from './sqlite.js';

/** 리눅스 `statfs.f_type` 의 네트워크 파일시스템 번호(`linux/magic.h`). */
export const NETWORK_FS: Readonly<Record<number, string>> = {
  0x6969: 'nfs',
  0x517b: 'smb',
  0xff534d42: 'cifs',
  0xfe534d42: 'smb2',
  0x00c36400: 'ceph',
  0x5346414f: 'afs',
  0x0bd00bd0: 'lustre',
};

export type SqliteDeployment = {
  /** `BARY_DSN`. */
  readonly dsn: string;
  /** `BARY_ACCOUNTS_DSN` (없으면 빈 문자열). */
  readonly accountsDsn: string;
  readonly cluster: boolean;
  /** 전역 화면이 켜졌으면 지역 API 주소들. */
  readonly regionApis?: readonly string[];
};

export type HostProbe = {
  readonly platform: NodeJS.Platform;
  /** 디렉터리의 파일시스템 형 번호. */
  fsType(dir: string): number;
  /** 이 호스트의 주소(루프백 포함). */
  localAddresses(): ReadonlySet<string>;
  resolve(host: string): Promise<string[]>;
};

export const realHostProbe: HostProbe = {
  platform: process.platform,
  fsType: (dir) => Number(statfsSync(dir).type),
  localAddresses: () => new Set(Object.values(networkInterfaces()).flatMap((l) => (l ?? []).map((a) => a.address))),
  resolve: async (host) => (await lookup(host, { all: true })).map((a) => a.address),
};

const isLoopback = (a: string): boolean => a === '::1' || /^127\./.test(a) || a === '::ffff:127.0.0.1';

/** 거부할 사유들. 비어 있으면 괜찮다. 사유는 사람이 읽는다 — DSN 은 싣지 않고 경로만 싣는다. */
export async function sqliteDeploymentProblems(d: SqliteDeployment, probe: HostProbe = realHostProbe): Promise<string[]> {
  const out: string[] = [];
  const files: Array<[string, string]> = [];
  if (dbKindOf(d.dsn) === 'sqlite') files.push(['BARY_DSN', sqlitePathOf(d.dsn, 'BARY_DSN')]);
  const accountsSqlite = d.accountsDsn !== '' && dbKindOf(d.accountsDsn) === 'sqlite';
  if (accountsSqlite) files.push(['BARY_ACCOUNTS_DSN', sqlitePathOf(d.accountsDsn, 'BARY_ACCOUNTS_DSN')]);
  if (files.length === 0) return out;

  if (d.cluster) {
    for (const [label] of files) {
      out.push(`BARY_CLUSTER=1 인데 ${label} 가 SQLite 다 — 클러스터는 여러 호스트가 DB 를 공유하는 배치라 SQLite 파일로는 설 수 없다 (PG 를 쓴다)`);
    }
  }

  if (probe.platform === 'linux') {
    for (const [label, path] of files) {
      let type: number;
      try {
        type = probe.fsType(dirname(path));
      } catch (e) {
        out.push(`${label} 의 디렉터리(${dirname(path)})를 볼 수 없다: ${e instanceof Error ? e.message : String(e)}`);
        continue;
      }
      const fs = NETWORK_FS[type];
      if (fs !== undefined) {
        out.push(`${label} 의 파일(${path})이 네트워크 파일시스템(${fs}) 위다 — SQLite 의 파일 잠금을 믿을 수 없다 (로컬 디스크에 둔다)`);
      }
    }
  }

  if (accountsSqlite && d.regionApis !== undefined && d.regionApis.length > 0) {
    const local = probe.localAddresses();
    for (const api of d.regionApis) {
      let host: string;
      try {
        host = new URL(api).hostname.replace(/^\[|\]$/g, '');
      } catch {
        out.push(`지역 API 주소를 읽을 수 없다: ${api}`);
        continue;
      }
      let addrs: string[];
      try {
        addrs = /^[0-9.]+$|:/.test(host) ? [host] : await probe.resolve(host);
      } catch (e) {
        out.push(`계정 DB 가 SQLite 라 지역 API(${host})가 이 호스트인지 봐야 하는데 이름을 못 풀었다: ${e instanceof Error ? e.message : String(e)}`);
        continue;
      }
      const away = addrs.filter((a) => !isLoopback(a) && !local.has(a));
      if (addrs.length === 0 || away.length > 0) {
        out.push(`계정 DB(BARY_ACCOUNTS_DSN)가 SQLite 인데 지역 API ${host}(${away.join(', ') || '주소 없음'})가 이 호스트가 아니다 — `
          + '전역과 지역은 계정 DB 를 공유한다. 같은 호스트에 두거나(지역 API 를 루프백 주소로) 계정 DB 를 PG 로 둔다');
      }
    }
  }
  return out;
}

/** 기동 검사. 사유가 하나라도 있으면 던진다. */
export async function assertSqliteDeployment(d: SqliteDeployment, probe: HostProbe = realHostProbe): Promise<void> {
  const problems = await sqliteDeploymentProblems(d, probe);
  if (problems.length > 0) throw new Error(`SQLite 배치가 맞지 않는다 (docs/adr-multi-db.md 「SQLite 의 한계」):\n  - ${problems.join('\n  - ')}`);
}
