/**
 * 인증서 자료를 **읽어서 사실을 뽑는다** (DESIGN.md §7.2 · §4.6)
 *
 * §7.2 가 요구한다: *"직후 **인증서-키 일치·SAN·not_after**·권한(0400, DP uid) 검증."*
 * 그런데 하나도 없었다 — 체인과 **무관한 키**를 올려도 저장되고, 만료된 인증서도 그대로
 * 들어갔다. 실패는 한참 뒤 apply 의 `nginx -t` 에서 나고, 그때 보이는 것은 "설정이
 * 이상하다" 이지 "올린 키가 그 인증서 것이 아니다" 가 아니다.
 *
 * **의존성을 안 늘린다.** `node:crypto` 의 `X509Certificate` 가 SAN·유효기간·키 일치를
 * 전부 준다 (§11.2 가 PG 하나만 쓰기로 한 것과 같은 이유).
 *
 * ── 왜 이 사실들을 클라이언트에게 안 받는가 ─────────────────────────────
 *
 * §4.6 은 `Certificate` 리소스에 `domains[]` 와 `not_before`/`not_after` 를 둔다. 그런데
 * 그걸 changeset 으로 받으면 **클라이언트가 만료일을 거짓말할 수 있다.** "이 인증서는
 * 2030 년까지" 라고 적어 두면 만료 알람이 안 울린다.
 *
 * 그래서 여기서 **바이트에서 뽑고**, 내용 주소 참조(`store://name@version`)에 매단다.
 * 참조가 내용의 함수이므로 사실도 내용의 함수가 된다 — 거짓말할 자리가 없다.
 */
import { X509Certificate, createPrivateKey } from 'node:crypto';

export type CertFacts = {
  /** leaf 의 subject. 사람이 보는 이름이다. */
  subject: string;
  issuer: string;
  /** SAN 의 DNS 이름들. **CN 은 안 쓴다** — 현대 클라이언트가 CN 을 안 본다. */
  domains: string[];
  notBefore: string;
  notAfter: string;
  /** 체인에 들어 있는 인증서 수. leaf 만 있으면 1 이다. */
  chainLength: number;
};

export class CertMaterialError extends Error {
  constructor(readonly kind:
    | 'not_pem'
    | 'unparsable'
    | 'key_mismatch'
    | 'expired'
    | 'not_yet_valid',
  message: string) {
    super(message);
    this.name = 'CertMaterialError';
  }
}

const PEM_BLOCK = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g;

/** SAN 문자열(`DNS:a, DNS:*.b, IP Address:1.2.3.4`)에서 DNS 이름만. */
function dnsNames(san: string | undefined): string[] {
  if (san === undefined) return [];
  return san.split(',')
    .map((part) => part.trim())
    .filter((part) => part.startsWith('DNS:'))
    .map((part) => part.slice(4).trim())
    .filter((name) => name.length > 0);
}

/**
 * 체인과 키를 읽어 사실을 뽑고, **틀린 것을 거절한다.**
 *
 * `now` 를 인자로 받는 이유: 시각을 안에서 읽으면 만료 판정을 테스트할 수가 없고,
 * 그러면 이 검사가 실제로 도는지 아무도 모른다.
 */
export function inspectMaterial(
  fullchain: string, privkey: string, now: Date = new Date(),
): CertFacts {
  const blocks = fullchain.match(PEM_BLOCK) ?? [];
  if (blocks.length === 0) {
    throw new CertMaterialError('not_pem', 'fullchain 에 PEM 인증서 블록이 없다');
  }

  let leaf: X509Certificate;
  try {
    // **첫 블록이 leaf 다.** PEM 체인의 관례이고 nginx 도 그렇게 읽는다. 순서가 뒤집힌
    // 체인은 여기서 중간 CA 를 leaf 로 보게 되는데, 그 경우 키 일치가 실패하므로
    // 아래 검사가 잡는다 — 조용히 통과하지 않는다.
    leaf = new X509Certificate(blocks[0]!);
  } catch (e) {
    throw new CertMaterialError('unparsable', `인증서를 읽을 수 없다: ${(e as Error).message}`);
  }

  let key;
  try {
    key = createPrivateKey(privkey);
  } catch (e) {
    throw new CertMaterialError('not_pem', `개인키를 읽을 수 없다: ${(e as Error).message}`);
  }

  // **§7.2 의 "인증서-키 일치".** 이게 없으면 무관한 한 쌍이 저장되고, 실패는 한참 뒤
  // apply 의 `nginx -t` 에서 "설정이 이상하다" 로 나타난다.
  if (!leaf.checkPrivateKey(key)) {
    throw new CertMaterialError('key_mismatch',
      '개인키가 이 인증서의 것이 아니다 (leaf 의 공개키와 안 맞는다)');
  }

  const notBefore = leaf.validFromDate ?? new Date(leaf.validFrom);
  const notAfter = leaf.validToDate ?? new Date(leaf.validTo);
  if (notAfter.getTime() <= now.getTime()) {
    throw new CertMaterialError('expired',
      `이미 만료된 인증서다 (not_after=${notAfter.toISOString()})`);
  }
  if (notBefore.getTime() > now.getTime()) {
    // 미래 인증서를 올리는 것 자체는 정당할 수 있지만(예약 갱신), **지금 게시하면**
    // 클라이언트가 거절한다. 올리는 시점에 말해 준다.
    throw new CertMaterialError('not_yet_valid',
      `아직 유효하지 않은 인증서다 (not_before=${notBefore.toISOString()})`);
  }

  return {
    subject: leaf.subject.replace(/\n/g, ', '),
    issuer: leaf.issuer.replace(/\n/g, ', '),
    domains: dnsNames(leaf.subjectAltName),
    notBefore: notBefore.toISOString(),
    notAfter: notAfter.toISOString(),
    chainLength: blocks.length,
  };
}

/**
 * 이 인증서가 이 호스트를 덮는가 — **SAN 기준**이다.
 *
 * 렌더러의 `coversHost` 와 같은 규칙을 쓴다: 와일드카드는 **한 라벨만** 덮는다.
 * S17 이 실측한 그대로이고, 여기서 넓게 잡으면 "덮는다" 고 말해 놓고 클라이언트가
 * 거절하는 조합을 통과시키게 된다.
 */
export function certCoversHost(facts: CertFacts, host: string): boolean {
  const lower = host.toLowerCase();
  return facts.domains.some((name) => {
    const d = name.toLowerCase();
    if (d === lower) return true;
    if (!d.startsWith('*.')) return false;
    const suffix = d.slice(2);
    if (!lower.endsWith(`.${suffix}`)) return false;
    return !lower.slice(0, lower.length - suffix.length - 1).includes('.');
  });
}
