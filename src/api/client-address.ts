/**
 * 요청을 보낸 사람의 주소 — 믿을 프록시 뒤에서도 사람마다 갈린다 (2026-11-01, web-01).
 *
 * GUI 를 barycenter 의 nginx 로 내면, API 가 보는 접속 주소는 모든 사람이 nginx 주소 하나다. 그 주소로
 * 인증 실패를 세면 한 사람이 틀린 토큰을 다섯 번 보낼 때 **모든 사람**이 429 로 잠긴다. 로그인 시도 제한과
 * 감사 기록의 IP 도 같다.
 *
 * `BARY_TRUSTED_PROXIES` 에 프록시 주소(IP · CIDR)를 적는다. 접속 주소가 그 안이면 `X-Forwarded-For` 를
 * **오른쪽부터** 읽고, 믿을 프록시가 아닌 첫 주소를 쓴다. 왼쪽 값은 클라이언트가 마음대로 적을 수 있다 — 그래서
 * 맨 왼쪽을 쓰지 않는다. 접속 주소가 목록 밖이면 헤더를 보지 않는다. 목록이 비면 지금처럼 접속 주소만 쓴다.
 */
import { BlockList } from 'node:net';
import type { IncomingMessage } from 'node:http';
import { cidrVersion, ipVersion } from '../validate/ip.js';

export type TrustedProxies = BlockList;

/**
 * `::ffff:10.0.0.1` 은 IPv4 다. 두 모양을 하나로 맞춰야 목록과 비교가 맞는다. 존 ID(`%eth0`)는 뗀다 —
 * 주소의 일부가 아니고 `BlockList` 가 받지 않는다.
 */
function normalize(addr: string): string {
  const s = addr.trim().replace(/%.*$/, '');
  const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(s);
  return m?.[1] ?? s;
}

/**
 * `10.253.65.250, 127.0.0.1/32 fd00::/8` 를 읽는다. 쉼표나 공백으로 나눈다. 빈 값은 `undefined`(끔).
 * 틀린 항목은 기동을 실패시킨다 — 조용히 빼면 켰다고 믿는데 다 같이 잠기는 상태가 남는다.
 */
export function parseTrustedProxies(raw: string): TrustedProxies | undefined {
  const items = raw.split(/[\s,]+/).filter((s) => s !== '');
  if (items.length === 0) return undefined;
  const list = new BlockList();
  for (const item of items) {
    const slash = item.indexOf('/');
    if (slash < 0) {
      const v = ipVersion(item);
      if (v === 0) throw new Error(`BARY_TRUSTED_PROXIES 의 '${item}' 은 IP 주소나 CIDR 가 아니다`);
      list.addAddress(item, v === 4 ? 'ipv4' : 'ipv6');
      continue;
    }
    const v = cidrVersion(item);
    if (v === 0) throw new Error(`BARY_TRUSTED_PROXIES 의 '${item}' 은 IP 주소나 CIDR 가 아니다`);
    list.addSubnet(item.slice(0, slash), Number(item.slice(slash + 1)), v === 4 ? 'ipv4' : 'ipv6');
  }
  return list;
}

function trusts(list: TrustedProxies, addr: string): boolean {
  const v = ipVersion(addr);
  return v !== 0 && list.check(addr, v === 4 ? 'ipv4' : 'ipv6');
}

/** 이 요청을 보낸 사람의 주소. 모르면 `undefined`. */
export function clientAddress(req: IncomingMessage, trusted: TrustedProxies | undefined): string | undefined {
  const peer = req.socket.remoteAddress;
  if (peer === undefined) return undefined;
  let addr = normalize(peer);
  if (trusted === undefined || !trusts(trusted, addr)) return addr;
  const raw = req.headers['x-forwarded-for'];
  const header = Array.isArray(raw) ? raw.join(',') : raw ?? '';
  const hops = header.split(',').map(normalize).filter((s) => s !== '');
  for (let i = hops.length - 1; i >= 0; i--) {
    const hop = hops[i] as string;
    // 주소가 아닌 값에서 멈춘다. 그 왼쪽은 믿을 근거가 없다 — 마지막으로 믿은 홉이 보낸 사람이다.
    if (ipVersion(hop) === 0) return addr;
    addr = hop;
    if (!trusts(trusted, hop)) return addr;
  }
  return addr;
}
