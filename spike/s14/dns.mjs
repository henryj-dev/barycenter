/**
 * S14 통제 DNS — 존을 파일에서 매 질의마다 읽는다.
 *
 * ── 왜 직접 쓰나 ────────────────────────────────────────────────────────
 *
 * dnsmasq·CoreDNS 로는 **"응답을 아예 안 준다"** 를 만들 수 없다. 그런데 §12.0 이
 * S14 에 요구하는 것 중 하나가 정확히 그것이다 — `timeout`. NXDOMAIN 과 SERVFAIL 과
 * 무응답은 nginx 에서 **서로 다른 동작**을 낼 수 있고, 그 차이가 우리 모델의
 * `on_nxdomain`/`on_timeout` 선택형과 1:1 대응하지 않는다는 것이 §7.3 의 미결 항목이다.
 *
 * 그래서 와이어 포맷을 손으로 짠다. `src/acme/der.ts` 가 같은 이유로 그랬다.
 *
 * ── 존을 파일에서 읽는다 ────────────────────────────────────────────────
 *
 * 매 질의마다 읽으므로 **프로브가 파일만 갈아 끼우면 즉시 반영된다.** 제어 포트를 따로
 * 열면 그 포트가 또 하나의 계측기가 되고, 그게 죽었는지 살았는지를 다시 재야 한다.
 *
 *   { "mode": "normal" | "nxdomain" | "servfail" | "drop",
 *     "ttl": 5,
 *     "A":    { "be.test": ["172.20.0.5"] },
 *     "AAAA": { "be.test": ["fd00::5"] },
 *     "SRV":  { "_be._tcp.svc.test": [{ "priority":0,"weight":10,"port":8080,"target":"a.test" }] } }
 *
 * `drop` 은 침묵이다 — 소켓은 살아 있고 응답만 안 나간다. 서버를 죽이면 ICMP
 * port unreachable 이 돌아가서 **timeout 이 아니라 즉시 실패**가 된다. 그건 다른 실험이다.
 */
import { createSocket } from 'node:dgram';
import { readFileSync } from 'node:fs';

const ZONE = process.argv[2];
const PORT = Number(process.argv[3] ?? 53);

const TYPE = { A: 1, AAAA: 28, SRV: 33 };
const NAME_OF_TYPE = { 1: 'A', 28: 'AAAA', 33: 'SRV' };

/** 라벨 시퀀스를 읽는다. 압축 포인터는 질문 섹션에 안 오므로 안 다룬다. */
function readName(buf, off) {
  const parts = [];
  for (;;) {
    const len = buf[off];
    if (len === undefined) throw new Error('이름이 잘렸다');
    off += 1;
    if (len === 0) break;
    parts.push(buf.subarray(off, off + len).toString('latin1'));
    off += len;
  }
  return { name: parts.join('.'), off };
}

function writeName(name) {
  const out = [];
  for (const label of name.split('.')) {
    if (label.length === 0) continue;
    out.push(Buffer.from([label.length]), Buffer.from(label, 'latin1'));
  }
  out.push(Buffer.from([0]));
  return Buffer.concat(out);
}

function v4(addr) {
  return Buffer.from(addr.split('.').map((x) => Number(x)));
}

/** `fd00::5` 같은 압축 표기를 16 바이트로. */
function v6(addr) {
  const [head, tail = ''] = addr.split('::');
  const h = head === '' ? [] : head.split(':');
  const t = tail === '' ? [] : tail.split(':');
  const fill = 8 - h.length - t.length;
  const groups = [...h, ...Array(addr.includes('::') ? fill : 0).fill('0'), ...t];
  const buf = Buffer.alloc(16);
  groups.forEach((g, i) => buf.writeUInt16BE(parseInt(g || '0', 16), i * 2));
  return buf;
}

function rr(name, type, ttl, rdata) {
  const head = Buffer.concat([writeName(name), Buffer.alloc(10)]);
  const n = writeName(name).length;
  head.writeUInt16BE(type, n);
  head.writeUInt16BE(1, n + 2);          // IN
  head.writeUInt32BE(ttl, n + 4);
  head.writeUInt16BE(rdata.length, n + 8);
  return Buffer.concat([head, rdata]);
}

const sock = createSocket({ type: 'udp4', reuseAddr: true });

sock.on('message', (msg, rinfo) => {
  let zone;
  try {
    zone = JSON.parse(readFileSync(ZONE, 'utf8'));
  } catch {
    return;  // 존 파일이 잠깐 없으면 침묵한다 — 프로브가 갈아 끼우는 순간이다
  }
  if (zone.mode === 'drop') return;

  let q;
  try {
    q = readName(msg, 12);
  } catch {
    return;
  }
  const qtype = msg.readUInt16BE(q.off);
  const qname = q.name.toLowerCase();
  const kind = NAME_OF_TYPE[qtype];

  const id = msg.readUInt16BE(0);
  const question = msg.subarray(12, q.off + 4);

  let rcode = 0;
  const answers = [];
  const ttl = zone.ttl ?? 5;

  if (zone.mode === 'servfail') {
    rcode = 2;
  } else if (zone.mode === 'nxdomain') {
    rcode = 3;
  } else if (kind === 'A') {
    for (const a of zone.A?.[qname] ?? []) answers.push(rr(q.name, TYPE.A, ttl, v4(a)));
    if ((zone.A?.[qname] ?? []).length === 0 && zone.AAAA?.[qname] === undefined) rcode = 3;
  } else if (kind === 'AAAA') {
    for (const a of zone.AAAA?.[qname] ?? []) answers.push(rr(q.name, TYPE.AAAA, ttl, v6(a)));
    if ((zone.AAAA?.[qname] ?? []).length === 0 && zone.A?.[qname] === undefined) rcode = 3;
  } else if (kind === 'SRV') {
    for (const s of zone.SRV?.[qname] ?? []) {
      const head = Buffer.alloc(6);
      head.writeUInt16BE(s.priority, 0);
      head.writeUInt16BE(s.weight, 2);
      head.writeUInt16BE(s.port, 4);
      answers.push(rr(q.name, TYPE.SRV, ttl, Buffer.concat([head, writeName(s.target)])));
    }
    if ((zone.SRV?.[qname] ?? []).length === 0) rcode = 3;
  } else {
    // 모르는 타입은 NODATA 로 답한다 — NXDOMAIN 으로 답하면 nginx 가 이름 자체를
    // 없다고 판단해 A 조회까지 버릴 수 있다.
    rcode = 0;
  }

  const header = Buffer.alloc(12);
  header.writeUInt16BE(id, 0);
  header.writeUInt16BE(0x8400 | rcode, 2);   // QR=1 AA=1
  header.writeUInt16BE(1, 4);
  header.writeUInt16BE(answers.length, 6);
  sock.send(Buffer.concat([header, question, ...answers]), rinfo.port, rinfo.address);

  if (process.env.S14_DNS_LOG === '1') {
    process.stdout.write(`QUERY ${kind ?? qtype} ${qname} → rcode=${rcode} ans=${answers.length}\n`);
  }
});

sock.bind(PORT, '0.0.0.0', () => {
  process.stdout.write(`DNS listening ${PORT} zone=${ZONE}\n`);
});
