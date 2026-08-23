// S9 스파이크 프로브 — ssl_preread 가 무엇을 갈라 주는가 (DESIGN.md §12.0 S9)
//
// ClientHello 를 **손으로 짠다.** `tls.connect` 를 쓰면 백엔드가 TLS 가 아니라
// 핸드셰이크가 못 끝나고, 그러면 백엔드가 뱉은 표식을 못 읽는다 — E26.2 가 스킵된
// 바로 그 이유다. 여기서는 우리가 재려는 것이 핸드셰이크가 아니라 **분기** 이므로,
// 바이트를 직접 만들어 보내고 돌아오는 한 줄만 읽는다.
import net from 'node:net';

const PORT = Number(process.argv[2] ?? 19900);
const HOST = process.argv[3] ?? '127.0.0.1';

/**
 * 최소 TLS 1.2 ClientHello. `name` 이 있으면 server_name 확장을 붙인다.
 *
 * 확장을 **아예 안 붙이는** 것과 확장 목록은 있는데 SNI 만 없는 것을 갈라 두었다.
 * 실물 클라이언트(구형 스택·IP 로 직접 붙는 클라이언트)는 후자가 더 흔한데,
 * 앞의 것만 재고 "no-SNI 를 쟀다" 고 하면 실제 트래픽을 안 잰 것이 된다.
 */
function clientHello({ name, emptyExtList = false } = {}) {
  const exts = [];
  if (name !== undefined) {
    const host = Buffer.from(name, 'ascii');
    const entry = Buffer.concat([Buffer.from([0x00]), u16(host.length), host]);
    const list = Buffer.concat([u16(entry.length), entry]);
    exts.push(Buffer.concat([Buffer.from([0x00, 0x00]), u16(list.length), list]));
  }
  const body = Buffer.concat([
    Buffer.from([0x03, 0x03]),            // client_version TLS 1.2
    Buffer.alloc(32, 0x41),               // random (고정 — 재현 가능해야 한다)
    Buffer.from([0x00]),                  // session_id 없음
    u16(2), Buffer.from([0x00, 0x2f]),    // cipher_suites: TLS_RSA_WITH_AES_128_CBC_SHA
    Buffer.from([0x01, 0x00]),            // compression: null
    ...(name === undefined && !emptyExtList
      ? []                                 // 확장 블록 자체가 없다
      : [u16(Buffer.concat(exts).length), Buffer.concat(exts)]),
  ]);
  const hs = Buffer.concat([Buffer.from([0x01]), u24(body.length), body]);
  return Buffer.concat([Buffer.from([0x16, 0x03, 0x01]), u16(hs.length), hs]);
}

const u16 = (n) => Buffer.from([(n >> 8) & 0xff, n & 0xff]);
const u24 = (n) => Buffer.from([(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]);

/**
 * 한 번 붙어서 `send` 를 보내고 돌아오는 첫 줄을 읽는다.
 *
 * `hold` 가 참이면 보내고 나서 **닫지 않는다** — preread timeout 을 재려면 연결이
 * 살아 있어야 한다. 닫아 버리면 EOF 로 끝나서 timeout 과 구분이 안 된다.
 */
function probe(send, { hold = false, waitMs = 6000 } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    const sock = net.connect(PORT, HOST);
    let out = '';
    let settled = false;
    const done = (verdict) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.destroy();
      resolve({ verdict, ms: Date.now() - started });
    };
    const timer = setTimeout(() => done(out === '' ? 'HUNG' : out.trim()), waitMs);
    sock.on('connect', () => {
      if (send !== undefined && send.length > 0) sock.write(send);
      if (!hold && send !== undefined) { /* 반이중으로 안 닫는다 — 백엔드가 먼저 말한다 */ }
    });
    sock.on('data', (b) => { out += b.toString('latin1'); done(out.trim()); });
    // **끊긴 것과 아무 말도 안 한 것을 가른다.** 둘 다 "표식이 없다" 지만 원인이 다르다.
    sock.on('end', () => done(out === '' ? 'CLOSED_EMPTY' : out.trim()));
    sock.on('error', (e) => done(out === '' ? `ERR:${e.code ?? e.message}` : out.trim()));
  });
}

const cases = [
  ['plain', () => probe(Buffer.from('GET / HTTP/1.0\r\n\r\n'))],
  ['sni', () => probe(clientHello({ name: 'a.example.com' }))],
  ['no_sni_no_ext', () => probe(clientHello())],
  ['no_sni_empty_ext', () => probe(clientHello({ emptyExtList: true }))],
  // TLS 레코드처럼 시작하지만 핸드셰이크 본문이 쓰레기다. ssl_preread 가 이것을
  // 어떻게 처리하는지가 "malformed 를 가를 수 있는가" 의 답이다.
  ['malformed', () => probe(Buffer.concat([
    Buffer.from([0x16, 0x03, 0x01, 0x00, 0x10]), Buffer.alloc(0x10, 0xff),
  ]))],
  // 레코드 헤더가 큰 길이를 주장하고 본문을 안 준다 — TLS 처럼 보이는 채로 멈춘다.
  ['truncated_hold', () => probe(Buffer.from([0x16, 0x03, 0x01, 0x02, 0x00]), { hold: true })],
  // 한 바이트도 안 보낸다. 순수 preread timeout.
  ['silent_hold', () => probe(Buffer.alloc(0), { hold: true })],
];

const out = {};
for (const [name, run] of cases) out[name] = await run();
process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
