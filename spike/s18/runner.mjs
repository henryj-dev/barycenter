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
/**
 * 시나리오용 클라이언트.
 *
 * ── **재시도를 넉넉히 준다** (검수 W3-6)
 *
 * Pebble 이 `PEBBLE_WFE_NONCEREJECT` 로 nonce 를 20% 거절한다. 제품 기본값
 * (`nonceRetries: 5`)이면 한 요청이 여섯 번 연속 거절될 확률이 `0.2^6 = 6.4e-5` 인데,
 * **한 회차에 요청이 수백 개다**(③ 이 상한 300 까지 주문한다). 합치면 **~2%** 이고,
 * 실제로 게이트가 그 확률로 빨갰다:
 *
 *   FAIL  fail  예외: ACME 400 …:badNonce: JWS has an invalid anti-replay nonce
 *
 * ③ 의 주석이 이미 같은 것을 적어 뒀다 — *"그러면 시나리오가 무작위로 빨개진다.
 * 간헐적으로 깨지는 게이트는 없느니만 못하다."* **그 판단이 여기에는 안 적용돼
 * 있었다.** 나머지 시나리오가 재는 것은 발급·고아·와일드카드·DNS 이지 nonce 내성이
 * 아니므로, 재시도 예산은 그것들에게 **재는 대상이 아니라 잡음**이다.
 *
 * 30 이면 `0.2^31 ≈ 4e-22` 다. 흔한 경우의 비용은 없다 — 기대 재시도가 요청당 0.25 회이고
 * Pebble 은 같은 호스트에 있다.
 *
 * ⚠️ **②·③ 은 이 기본값을 안 쓴다.** 그 둘이 재는 것이 바로 재시도 예산이라,
 * 각자 값을 명시한다.
 */
const SPIKE_NONCE_RETRIES = 30;

function tracked(opts = {}) {
  const key = newEcKey();
  const c = new AcmeClient({
    directoryUrl: DIRECTORY, accountKey: key,
    nonceRetries: SPIKE_NONCE_RETRIES, ...opts,
  });
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
      // `/tmp/s18-cert.pem` 에 쓰던 줄을 **지웠다** (검수 2026-08-24 SCAN-9).
      // **아무도 안 읽었다** — 남는 것은 예측 가능한 이름의 임시 파일뿐이었고,
      // 그건 이 저장소가 세는 「도달 불가한 코드」의 산출물 판이다.
    } finally {
      await http.close();
    }
  },

  /** ② badNonce 재시도 — RFC 8555 §6.5. */
  async nonce() {
    // **제품 기본값을 명시한다.** 이 시나리오가 재는 것이 「그 값이 충분한가」이므로,
    // 하네스의 넉넉한 기본값(`SPIKE_NONCE_RETRIES`)을 쓰면 재는 대상이 사라진다.
    const c = tracked({ nonceRetries: 5 });
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
    // **남는 거짓 빨강을 드러낸다** (③ 이 하는 것과 같다). 요청 하나가 재시도 5 회를
    // 소진할 확률이 `0.2^6 = 6.4e-5` 이고 여기서 요청이 열댓 개다 — 합쳐서 ~1e-3.
    // 그것을 더 낮추려면 재시도를 늘려야 하는데, **이 시나리오가 재는 것이 바로 제품
    // 기본값의 적정성**이라 그러면 재는 대상이 사라진다. 숨기지 말고 적어 둔다.
    say('nonce', failed === 0,
      `주문 12 회 중 성공 ${ok} 실패 ${failed} (badNonce 재시도 5 회 = 제품 기본값, 거짓 빨강 ~1e-3)`);
  },

  /** ③ 재시도를 껐을 때 — 대조군. 이게 실패해야 ②가 무언가를 증명한다. */
  async nonce_norety() {
    const c = tracked({ nonceRetries: 0 });
    // **등록은 재시도한다.** 이 시나리오가 재는 것은 *주문*이 badNonce 로 실패하는가지
    // 등록이 아니다. 재시도를 끈 클라이언트로 그냥 `register()` 를 부르면 20% 확률로
    // 거기서 죽고, 그러면 **시나리오가 무작위로 빨개진다** — 간헐적으로 깨지는 게이트는
    // 없느니만 못하다(이 저장소가 e2e 에서 이미 배운 것).
    for (let i = 0; ; i += 1) {
      try {
        await c.register();
        break;
      } catch (e) {
        if (i >= 10 || !(e instanceof AcmeHttpError)) throw e;
      }
    }
    // **고정 횟수로 재면 안 된다.** 게이트가 실제로 여기서 한 번 빨개져서 알았다.
    //
    // 처음엔 `PEBBLE_WFE_NONCEREJECT=20` 을 "20% 거절" 로 읽고 `0.8^12 = 6.9%` 라고
    // 계산했다. **실측이 그걸 뒤집었다** — 첫 실패가 나온 주문 번호가 세 번의 실행에서
    // 3·13·14·7 이었다. 기하분포 MLE 로 `p̂ = 4/37 ≈ 0.11` 이고, 그러면 옛 12 회 루프의
    // 거짓 빨강은 `0.89^12 ≈ 25%` — **네 번에 한 번**이었다. 6.9% 가 아니라.
    //
    // (13·14 회째에 잡힌 실행이 둘이다. 옛 코드였으면 넷 중 둘이 빨간색이다.)
    //
    // 그래서 **관측될 때까지 돌리고 상한에서만 실패한다.** 상한은 실측 p̂ 이 아니라
    // 그 절반(0.05)을 가정해 잡는다 — 표본이 셋뿐이라 p̂ 을 믿고 조이면 이 함정을
    // 한 번 더 밟는다. `0.95^300 ≈ 2.4e-7`. 흔한 경우엔 열 번쯤에 끝나므로 **더 빠르다.**
    const CAP = 300;
    let failed = 0;
    let tried = 0;
    for (; tried < CAP && failed === 0; tried += 1) {
      try {
        await c.newOrder([`noretry-${tried}.test`]);
      } catch (e) {
        if (e instanceof AcmeHttpError && e.problem.type?.endsWith(':badNonce')) failed += 1;
        else if (!(e instanceof AcmeHttpError)) throw e;
      }
    }
    say('nonce.control', failed > 0,
      `재시도를 끄면 badNonce 가 난다 — 주문 ${tried} 회째에 관측 (상한 ${CAP}, 거짓 빨강 2.4e-7). ②가 재는 것이 있다`);
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
