/**
 * GUI 의 ACME 인증서 (2026-10-30, 시안 대조에서 빠진 것).
 *
 * 시안의 인증서 만들기는 「발급자: ACME / 업로드」 다. 전에는 업로드만 있었다 — 서버에는 ACME 발급 ·
 * 갱신 스케줄러와 계정 API 가 있는데 화면에서 닿을 길이 없었다.
 *
 * 재는 것:
 *   · 인증서 폼이 ACME 와 업로드를 둘 다 고르게 한다
 *   · ACME 는 의도(계정 · 도메인)만 커밋한다 — 자료를 지어내지 않는다
 *   · 계정이 없으면 같은 화면에서 만든다(`POST /api/v1/acme/accounts`) — 계정이 있으면 「＋ 계정 생성」 을
 *     눌러야 만들기 칸이 펼쳐진다(늘 펼쳐 두면 고르는 사람에게 소음이다)
 *   · 인증서 상세가 주문의 실패 이유를 보인다
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const LIB = join(dirname(fileURLToPath(import.meta.url)), '../../gui/src/lib');
const read = (p: string): string => readFileSync(join(LIB, p), 'utf8');

describe('ACME 인증서 화면', () => {
  it('발급자를 ACME · 업로드 중에서 고른다 (시안: 「발급자」 셀렉트)', () => {
    const src = read('forms/CertificateForm.svelte');
    expect(src).toMatch(/value: 'acme', label: 'ACME'/);
    expect(src).toMatch(/value: 'upload', label: '업로드'/);
    expect(src).toContain('<Select label="발급자"');
  });

  it('ACME 는 의도만 커밋한다', () => {
    const src = read('forms/CertificateForm.svelte');
    expect(src).toContain("desk.putResource('certificate', k, { acme: { account, domains: domainList } })");
  });

  it('계정을 읽고 만든다', () => {
    const desk = read('desk.svelte.ts');
    expect(desk).toContain("'/api/v1/acme/accounts'");
    expect(desk).toMatch(/call\('POST', '\/api\/v1\/acme\/accounts'/);
    expect(read('forms/AcmeAccountField.svelte')).toContain('desk.createAcmeAccount(');
    expect(read('forms/CertificateForm.svelte')).toContain('<AcmeAccountField');
  });

  it('상세가 주문 상태와 실패 이유를 보인다', () => {
    const src = read('detail/Acme.svelte');
    expect(src).toContain('lastError');
    expect(src).toContain('attempts');
  });

  it('새 계정 칸은 셀렉트에서 「＋ 새 계정」 을 골랐을 때만 붙는다 (시안 `acct === \'__new\'`)', () => {
    const src = read('forms/AcmeAccountField.svelte');
    expect(src).toContain("export const NEW_ACCOUNT = '__new';");
    expect(src).toContain("{ value: NEW_ACCOUNT, label: '＋ 새 계정' }");
    expect(src).toContain('const adding = $derived(account === NEW_ACCOUNT);');
    expect(src).toContain('{#if adding}');
    // 계정이 없으면 「＋ 새 계정」 이 골라져 있다.
    expect(src).toContain('account = (want ?? list[0])?.key ?? NEW_ACCOUNT;');
    // 계정은 저장할 때 만든다 — 만들지 못하면 인증서를 커밋하지 않는다.
    const form = read('forms/CertificateForm.svelte');
    expect(form).toMatch(/const account = await field\?\.ensure\(\);\s*if \(account === undefined\) return;/);
    expect(form, '늘 보이는 계정 만들기 카드가 남았다').not.toContain('<Card title="ACME 계정 만들기"');
  });

  it('목록의 만들기 버튼은 모두 「＋ 만들기」 다 (시안)', () => {
    for (const l of ['Pool', 'Backend', 'AddressSet', 'Certificate', 'TlsPolicy', 'SniBinding']) {
      const src = read(`lists/${l}List.svelte`);
      expect(src, l).toMatch(/variant="primary" href="[^"]+\/new">＋ 만들기<\/Button>/);
    }
    // 라우트는 시안 `createItems` — 「＋ 만들기」 가 메뉴(라우트 만들기 · 경로별 묶음으로 만들기)를 연다.
    for (const l of ['HttpRoute', 'PassthroughRoute']) {
      const src = read(`lists/${l}List.svelte`);
      expect(src, l).toMatch(/<Button variant="primary" aria-haspopup="menu"[^>]*>＋ 만들기<\/Button>/);
      expect(src, l).toContain("{ label: '경로별 묶음으로 만들기', href: '/traffic/route/http/new/group' }");
    }
    // 리스너는 시안 `createItems` 메뉴다 — 「＋ 만들기 ▾」 아래 빠른 프록시 만들기 · 리스너 만들기.
    const ls = read('lists/ListenerList.svelte');
    expect(ls).toContain('＋ 만들기 ▾</Button>');
    expect(ls).toContain("{ label: '빠른 프록시 만들기', href: '/traffic/listener/new/quick' }");
    expect(ls).toContain("{ label: '리스너 만들기', href: '/traffic/listener/new' }");
  });

  /**
   * **CA 바꾸기** (2026-10-31) — 스테이징으로 받은 인증서를 새로 만들지 않고 운영 CA 로 다시 받는다.
   * 계정만 바꾸고 나머지 칸(자료 · 도메인)은 head 값 그대로 다시 싣는다 — PUT 은 통째로 덮는다.
   */
  it('상세의 설정 탭에서 계정을 바꿔 다시 발급한다 (시안 「ACME 계정」)', () => {
    const src = read('tls/CertificateSettings.svelte');
    expect(src).toContain('<AcmeAccountField bind:this={field} bind:account');
    expect(src).toContain("desk.putResource('certificate', key, certBody(item, { account: next, domains: parseDomains(domains) }))");
    // 화면용 칸(만료 · 사실)을 섞어 보내면 해독기가 거절한다 — 모델의 칸만 싣는다.
    const edit = read('tls/cert-edit.ts');
    expect(edit).toContain("export const MODEL_FIELDS = ['materialRef', 'chainDigest', 'keyDigest'] as const;");
    expect(edit).toContain('for (const f of MODEL_FIELDS) if (item[f] !== undefined) body[f] = item[f];');
    expect(read('detail/Acme.svelte'), '스테이징이면 운영으로 바꾸라고 먼저 말한다').toMatch(/staging && hasMaterial/);
  });
});
