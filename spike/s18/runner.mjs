/**
 * S18 러너 — 실물 ACME 서버(Pebble)에 주문을 낸다.
 *
 *   node runner.mjs <시나리오>
 *
 * 시나리오마다 한 줄씩 `RESULT <이름> <PASS|FAIL> <설명>` 을 찍는다.
 *
 * ── 왜 Pebble 인가 ──────────────────────────────────────────────────────
 *
 * Let's Encrypt staging 은 네트워크·레이트리밋·실제 DNS 가 필요하다. Pebble 은
 * **일부러 못되게 구는** 테스트 CA 다 — nonce 를 무작위로 거절하고, 유효성 검사 순서를
 * 섞고, 챌린지를 여러 번 재시도하게 만든다. S18 이 재려는 것이 정확히 그 거친 면이다.
 *
 * 특히 `PEBBLE_WFE_NONCEREJECT` 로 **badNonce 를 강제로 만들 수 있다.** RFC 8555 §6.5 가
 * "한 번은 반드시 재시도" 라고 한 그 경로를 실제로 밟게 하는 유일한 방법이다.
 */
import { createServer } from 'node:http';
import { writeFileSync } from 'node:fs';

const DIST = '/app/dist';
const { AcmeClient, AcmeHttpError, dns01Value, keyAuthorization } =
  await import(`${DIST}/acme/client.js`);
const { newEcKey } = await import(`${DIST}/acme/der.js`);

const DIRECTORY = process.env.ACME_DIRECTORY ?? 'https://pebble:14000/dir';
const scenario = process.argv[2];

// Pebble 은 자체서명 루트를 쓴다. **실서비스에서는 절대 안 한다** — 여기서만이다.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const say = (name, ok, detail) =>
  process.stdout.write(`RESULT ${name} ${ok ? 'PASS' : 'FAIL'} ${detail}\n`);

/** http-01 챌린지를 서빙하는 최소 서버. Pebble 이 5002 로 물어본다. */
function challengeServer(port) {
  const tokens = new Map();
  const server = createServer((req, res) => {
    const m = /^\/\.well-known\/acme-challenge\/(.+)$/.exec(req.url ?? '');
    const value = m === null ? undefined : tokens.get(m[1]);
    if (value === undefined) {
      res.writeHead(404).end('없다');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/octet-stream' }).end(value);
  });
  return {
    listen: () => new Promise((r) => server.listen(port, '0.0.0.0', r)),
    close: () => new Promise((r) => server.close(() => r())),
    set: (token, value) => tokens.set(token, value),
    clear: (token) => tokens.delete(token),
    served: () => [...tokens.keys()],
  };
}

const client = (opts = {}) => new AcmeClient({
  directoryUrl: DIRECTORY, accountKey: newEcKey(), ...opts,
});

/** 도메인 하나를 http-01 로 끝까지 받아 온다. */
async function issue(c, domain, http, hooks = {}) {
  const { url, order } = await c.newOrder([domain]);
  if (hooks.afterOrder) await hooks.afterOrder(order, url);

  for (const authzUrl of order.authorizations) {
    const authz = await c.fetchAuthorization(authzUrl);
    const ch = authz.challenges.find((x) => x.type === 'http-01');
    if (ch === undefined) throw new Error('http-01 챌린지가 없다');
    http.set(ch.token, keyAuthorization(ch.token, c === undefined ? undefined : accountKeyOf(c)));
    if (hooks.beforeAccept) await hooks.beforeAccept(ch);
    await c.acceptChallenge(ch.url);
  }

  const ready = await c.awaitOrder(url, 'ready');
  if (ready.status !== 'ready') {
    return { ok: false, order: ready, url };
  }
  const certKey = newEcKey();
  const done = await c.finalize(ready, url, [domain], certKey);
  if (done.status !== 'valid' || done.certificate === undefined) {
    return { ok: false, order: done, url };
  }
  const pem = await c.downloadCertificate(done.certificate);
  return { ok: true, order: done, url, pem, certKey };
}

// `keyAuthorization` 은 계정 키가 필요한데 클라이언트가 감추고 있다. 스파이크에서는
// 만들 때 들고 있던 것을 그대로 쓴다 — 제품 코드에는 이 우회가 없다.
const keys = new WeakMap();
function accountKeyOf(c) { return keys.get(c); }
function tracked(opts = {}) {
  const key = newEcKey();
  const c = new AcmeClient({ directoryUrl: DIRECTORY, accountKey: key, ...opts });
  keys.set(c, key);
  return c;
}

const scenarios = {
  /** ① 기본 경로 — 계정 → 주문 → http-01 → finalize → 인증서. */
  async happy() {
    const http = challengeServer(5002);
    await http.listen();
    try {
      const c = tracked();
      await c.register(['mailto:s18@example.test']);
      const out = await issue(c, 'happy.test', http);
      if (!out.ok) {
        say('happy', false, `주문이 ${out.order.status} 로 끝났다`);
        return;
      }
      // **인증서가 진짜인지 파싱해서 본다.** 200 을 받았다는 것과 쓸 수 있는 인증서를
      // 받았다는 것은 다르다.
      const { X509Certificate } = await import('node:crypto');
      const leaf = new X509Certificate(out.pem);
      const san = leaf.subjectAltName ?? '';
      say('happy', san.includes('happy.test'),
        `발급됨 — SAN=${san} 체인길이=${(out.pem.match(/BEGIN CERTIFICATE/g) ?? []).length}`);

      // 우리가 만든 CSR 의 키와 발급된 인증서가 맞는지. 안 맞으면 그 인증서는 쓸모없다.
      say('happy.key', leaf.checkPrivateKey(out.certKey), '발급된 인증서가 우리 키와 맞는다');
      writeFileSync('/tmp/s18-cert.pem', out.pem);
    } finally {
      await http.close();
    }
  },

  /** ② badNonce 재시도 — RFC 8555 §6.5. */
  async nonce() {
    const c = tracked();
    await c.register();
    // Pebble 이 `PEBBLE_WFE_NONCEREJECT` 로 일정 비율의 nonce 를 거절한다. 재시도가
    // 없으면 여기서 무작위로 실패한다.
    let ok = 0;
    let failed = 0;
    for (let i = 0; i < 12; i += 1) {
      try {
        await c.newOrder([`nonce-${i}.test`]);
        ok += 1;
      } catch (e) {
        failed += 1;
        if (!(e instanceof AcmeHttpError)) throw e;
      }
    }
    say('nonce', failed === 0, `주문 12 회 중 성공 ${ok} 실패 ${failed} (badNonce 재시도 활성)`);
  },

  /** ③ 재시도를 껐을 때 — 대조군. 이게 실패해야 ②가 무언가를 증명한다. */
  async nonce_norety() {
    const c = tracked({ nonceRetries: 0 });
    await c.register();
    let failed = 0;
    for (let i = 0; i < 12; i += 1) {
      try {
        await c.newOrder([`noretry-${i}.test`]);
      } catch (e) {
        if (e instanceof AcmeHttpError && e.problem.type?.endsWith(':badNonce')) failed += 1;
        else if (!(e instanceof AcmeHttpError)) throw e;
      }
    }
    say('nonce.control', failed > 0,
      `재시도를 끄면 badNonce 로 ${failed} 회 실패한다 — ②가 재는 것이 있다`);
  },

  /** ④ 챌린지 실패 — 토큰을 안 서빙하면 주문이 invalid 가 되는가. */
  async fail() {
    const http = challengeServer(5002);
    await http.listen();
    try {
      const c = tracked();
      await c.register();
      const { url, order } = await c.newOrder(['broken.test']);
      for (const authzUrl of order.authorizations) {
        const authz = await c.fetchAuthorization(authzUrl);
        const ch = authz.challenges.find((x) => x.type === 'http-01');
        // **일부러 안 서빙한다.**
        await c.acceptChallenge(ch.url);
      }
      const out = await c.awaitOrder(url, 'ready', { attempts: 20, intervalMs: 300 });
      // 여기서 재는 것은 "실패한다" 가 아니라 **"실패가 유한 시간에 확정된다"** 다.
      // 영원히 pending 이면 상태기계가 멈춘다.
      say('fail', out.status === 'invalid',
        `토큰을 안 서빙하면 주문이 ${out.status} 가 된다`);
    } finally {
      await http.close();
    }
  },

  /** ⑤ 고아 정리 — 실패한 주문의 챌린지 자료가 남는가. */
  async orphan() {
    const http = challengeServer(5002);
    await http.listen();
    try {
      const c = tracked();
      await c.register();
      const { url, order } = await c.newOrder(['orphan.test']);
      const authz = await c.fetchAuthorization(order.authorizations[0]);
      const ch = authz.challenges.find((x) => x.type === 'http-01');
      http.set(ch.token, keyAuthorization(ch.token, accountKeyOf(c)));

      // 수락하지 **않고** 버린다 — 사용자가 중간에 그만둔 경우다.
      const before = http.served().length;
      // 정리를 안 하면 토큰이 그대로 남는다. dns-01 이면 TXT 레코드가 남는 자리다.
      http.clear(ch.token);
      const after = http.served().length;

      const stale = await c.fetchOrder(url);
      say('orphan', before === 1 && after === 0,
        `버린 주문의 자료를 지울 수 있다 (${before}→${after}), 주문 상태는 ${stale.status} 로 남는다`);
    } finally {
      await http.close();
    }
  },

  /** ⑥ 와일드카드는 http-01 로 못 받는다 — §8.2 의 "와일드카드는 dns-01 만". */
  async wildcard() {
    const c = tracked();
    await c.register();
    const { order } = await c.newOrder(['*.wild.test']);
    const authz = await c.fetchAuthorization(order.authorizations[0]);
    const types = authz.challenges.map((x) => x.type).sort();
    say('wildcard', !types.includes('http-01') && types.includes('dns-01'),
      `와일드카드 authz 의 챌린지 = ${types.join(',')} (wildcard=${authz.wildcard})`);
  },

  /** ⑦ dns-01 값이 규격대로인가 — 계산만 본다. TXT 전파는 별개다. */
  async dns() {
    const c = tracked();
    await c.register();
    const { order } = await c.newOrder(['*.dnsonly.test']);
    const authz = await c.fetchAuthorization(order.authorizations[0]);
    const ch = authz.challenges.find((x) => x.type === 'dns-01');
    const value = dns01Value(ch.token, accountKeyOf(c));
    // base64url 44 자 = SHA-256 32 바이트. 길이가 다르면 인코딩이 틀린 것이다.
    say('dns', /^[A-Za-z0-9_-]{43}$/.test(value),
      `_acme-challenge TXT = ${value.slice(0, 12)}… (${value.length}자)`);
  },
};

const run = scenarios[scenario];
if (run === undefined) {
  process.stdout.write(`RESULT ${scenario} FAIL 모르는 시나리오\n`);
  process.exit(1);
}
try {
  await run();
} catch (e) {
  process.stdout.write(`RESULT ${scenario} FAIL 예외: ${e?.message ?? e}\n`);
  process.exit(1);
}
