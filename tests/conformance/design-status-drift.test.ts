/**
 * **DESIGN 의 "아직 없다" 가 거짓이 되면 깨진다** (2026-08-23).
 *
 * ── 왜 이 게이트가 생겼나
 *
 * DESIGN.md 를 실제로 **파싱해서 코드와 대조하는 테스트는 하나뿐**이었다 —
 * `review6-design-abi.test.ts` 이고, 그건 §6.2 의 단계 표만 본다. 나머지 3,300 줄은
 * 손으로 맞춰야 했고, 실제로 갈라졌다. 한 회차 점검에서 **열 자리**가 나왔다 — 목록은
 * 아래 "이번 회차에 고친 자리" 에 있다. 손으로 센 것은 여덟이었고, 이 게이트를 먼저
 * 세웠더니 둘이 더 나왔다(§15.3 의 같은 문장, 화면 수를 낱말로 세는 자리).
 *
 * **낡은 문서는 없는 문서보다 나쁘다.** 없으면 코드를 읽지만, 있으면 믿는다.
 *
 * ── 무엇을 재는가
 *
 * 산문 전체의 정확성은 기계가 못 잰다(48차 판정 — 그건 검수의 축이다). 재는 것은
 * **부재 주장** 하나다: 문서가 "X 는 없다/아직이다" 라고 적었는데 코드에 X 가 있는 경우.
 *
 * 부재 주장을 고른 이유는 그것이 **거짓이 되는 방향이 하나**이기 때문이다. 기능은 늘고
 * 문서는 안 따라온다 — 위 여덟 자리가 전부 그 방향이었다. 반대 방향("있다" 고 적었는데
 * 없다)은 도달성 게이트와 표면 게이트가 이미 다른 각도에서 잡는다.
 *
 * ⚠️ **이 게이트는 산문을 안 읽는다.** 정해 둔 주장 목록만 본다. 새 부재 주장을 문서에
 * 적는 사람은 여기에도 한 줄을 더해야 하고, 그게 이 게이트의 값이다 — "없다" 고 적는
 * 것이 공짜가 아니게 만든다.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const design = readFileSync(join(ROOT, 'DESIGN.md'), 'utf8');
const read = (rel: string): string =>
  existsSync(join(ROOT, rel)) ? readFileSync(join(ROOT, rel), 'utf8') : '';

/**
 * 부재 주장 하나.
 *
 * `claim` 이 DESIGN 에 **있으면서** `present()` 가 참이면 그 주장은 거짓이다.
 */
type AbsenceClaim = {
  what: string;
  /** DESIGN.md 안의 문자열. 문서가 이 말을 하고 있는가. */
  claim: string;
  /** 코드에 실제로 있는가. */
  present: () => boolean;
  /** 있다면 어디에. 실패 메시지가 다음 사람을 그리로 보낸다. */
  where: string;
};

const CLAIMS: AbsenceClaim[] = [
  {
    what: '`least_conn` 알고리즘',
    claim: '`least_conn` 은 v0 enum 에 아예 넣지 않는다',
    present: () => /'least_conn'/.test(read('src/model/provisional.ts')),
    where: 'src/model/provisional.ts — algorithm 유니온에 들어왔다',
  },
  {
    what: 'HTTP/3 (h3)',
    claim: 'h3 는 **모델에서 뺀다**',
    present: () => /'h3'|'http3'/.test(read('src/model/provisional.ts')),
    where: 'src/model/provisional.ts — 모델이 h3 를 표현한다',
  },
  {
    what: 'OCSP stapling',
    claim: 'OCSP stapling — **안 짓는다**',
    present: () => /ssl_stapling/.test(read('src/conf/render.ts')),
    where: 'src/conf/render.ts — `ssl_stapling` 을 렌더한다',
  },
  {
    what: '메서드×경로 ALLOW/DENY',
    claim: '메서드×경로 ALLOW/DENY 는 WAF 다',
    present: () => /methodAllow|methodDeny|allowMethods/.test(read('src/model/provisional.ts')),
    where: 'src/model/provisional.ts — 모델에 메서드 규칙이 생겼다',
  },
  {
    what: '`on_nxdomain` · `on_timeout` 모델 필드',
    claim: '`on_nxdomain` / `on_timeout` 선택형은 이 경로에서 표현할 수 없다',
    present: () => /onNxdomain|onTimeout/.test(read('src/model/provisional.ts')),
    where: 'src/model/provisional.ts — 선택형이 모델에 들어왔다',
  },
];

/**
 * ── 이번 회차에 **고친** 자리 (2026-08-23)
 *
 * 아래는 전부 "없다" 고 적혀 있었는데 실제로는 있던 것들이다. 문서를 고쳤으므로 목록에서
 * 뺐다 — 남겨 두면 `if (!claimed) return` 으로 영원히 조용히 통과하고, 그 침묵이 이
 * 파일을 "도는 것처럼 보이는 죽은 게이트" 로 만든다.
 *
 *   §12.1 v0.4  "드레인 명령은 아직"            → `bary backend drain` 이 있다
 *   §12.1 v0.5  "Kit 아님" · "여덟 화면"        → Kit 이고, 화면은 세지 않고 적는다
 *   §5.6  :1099 `--weight` "# 아직"             → `backend create --weight` 가 있다
 *   §5.6  :1131 "주문 GET 은 없다"              → 같은 절 :1135 와 자기모순이었다
 *   §9.1.1      "주문 GET 은 없다"              → 있다
 *   §10   :2669 "드레인·inflight 는 없다"        → 드레인 버튼이 있다
 *   §10   :2673 "주문·챌린지 상태는 API 에 없다" → `certs-view.ts` 가 낸다
 *   §10   :2709 "주문 GET 없음"                 → 같다
 *   §15.3       "Kit·드레인은 아직"             → 둘 다 있다
 *   §11.1       "CP ↔ DP 는 mTLS gRPC"          → **낡음이 아니라 미구현**이었다.
 *               구현체는 `LocalDataplaneDriver` 하나뿐이고 배포는 한 컨테이너다.
 *               "없는 것을 있다고 적지 않는다" 로 고쳤다.
 */

describe('DESIGN 의 부재 주장이 거짓이 되면 깨진다', () => {
  for (const c of CLAIMS) {
    it(`"${c.what}" — 문서가 없다고 하면 코드에도 없어야 한다`, () => {
      const claimed = design.includes(c.claim);
      if (!claimed) return;   // 문서가 그 말을 안 한다 — 잴 것이 없다.
      expect(
        c.present(),
        `DESIGN.md 가 "${c.claim}" 이라고 적었는데 실제로는 있다 — ${c.where}.\n`
        + '문서를 고치거나, 정말 없앴다면 이 목록에서 이 줄을 지운다.',
      ).toBe(false);
    });
  }

  it('게이트가 실제로 잰다 — 통과 신호를 위조하지 않는다', () => {
    /**
     * 목록이 비거나 `claim` 이 전부 오타면 위 테스트는 **전부 조용히 통과한다**
     * (`if (!claimed) return`). 그 침묵과 진짜 통과가 구분되지 않으면 이 파일은
     * 없는 것과 같다 — `verify.sh` 가 도달성 게이트에 같은 짝을 붙여 둔 이유다.
     *
     * 그래서 **적어도 하나는 문서에 실재해야** 한다고 요구한다. 전부 정리되는 날이
     * 오면 이 단언이 그 사실을 알려 주고, 그때 이 파일을 지우는 것이 옳다.
     */
    const live = CLAIMS.filter((c) => design.includes(c.claim));
    expect(
      live.length,
      '부재 주장이 DESIGN 에 하나도 없다 — 목록이 낡았거나 전부 정리됐다.\n'
      + '후자면 이 파일을 지운다. 전자면 오타를 고친다.',
    ).toBeGreaterThan(0);
  });

  it('§12.1 로드맵 표에 "아직" 이 남아 있지 않다', () => {
    /**
     * 로드맵의 상태 열은 **가장 빨리 낡는 자리**다 — 단계가 끝나도 표는 안 고쳐진다.
     * v0.1~v1.0 이 전부 코드에 있는 지금, 이 표에 "아직" 이 있으면 그건 거의 확실히
     * 낡은 것이다. 새로 미룬 것이 생기면 **무엇을 왜 미뤘는지** 함께 적게 만든다.
     */
    const start = design.indexOf('### 12.1 이후 단계');
    expect(start).toBeGreaterThan(-1);
    const rest = design.slice(start);
    const table = rest.slice(0, rest.indexOf('\n> '));
    const rows = table.split('\n').filter((l) => l.startsWith('| **v'));
    expect(rows.length, '로드맵 표를 못 찾았다').toBeGreaterThan(5);
    const stale = rows.filter((l) => /아직/.test(l));
    expect(
      stale,
      '§12.1 상태 열에 "아직" 이 남았다. 끝났으면 지우고, 정말 안 했으면\n'
      + '무엇을 왜 미뤘는지 적는다 — 한 낱말로 미룬 것은 다음 사람이 재확인할 수 없다.',
    ).toEqual([]);
  });

  it('GUI 화면 수를 문서가 세지 않는다 — 세면 틀린다', () => {
    /**
     * §12.1 이 "여덟 화면" 이라고 적었는데 §10 과 STATUS 는 아홉을 센다(로그인 포함).
     * 세는 기준이 둘이면 둘 다 낡는다. **숫자 대신 목록**을 쓰게 한다.
     */
    const routes = readdirSync(join(ROOT, 'gui/src/routes'), { withFileTypes: true })
      .filter((e) => e.isDirectory()).length + 1;   // +1 은 최상위 `+page.svelte`
    expect(routes).toBeGreaterThan(0);
    expect(
      /여덟 화면|아홉 화면|일곱 화면/.test(design),
      `DESIGN 이 화면 수를 낱말로 센다. 실제 Kit 경로는 ${routes} 개다 —\n`
      + '화면이 하나 늘 때마다 조용히 거짓이 되므로 숫자 대신 목록으로 적는다.',
    ).toBe(false);
  });
});
