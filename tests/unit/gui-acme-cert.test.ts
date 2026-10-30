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
  it('발급자를 ACME · 업로드 중에서 고른다', () => {
    const src = read('forms/CertificateForm.svelte');
    expect(src).toMatch(/value: 'acme'/);
    expect(src).toMatch(/value: 'upload'/);
    expect(src).toContain('<RadioGroup');
  });

  it('ACME 는 의도만 커밋한다', () => {
    const src = read('forms/CertificateForm.svelte');
    expect(src).toContain("desk.putResource('certificate', k, { acme: { account, domains: domainList } })");
  });

  it('계정을 읽고 만든다', () => {
    const desk = read('desk.svelte.ts');
    expect(desk).toContain("'/api/v1/acme/accounts'");
    expect(desk).toMatch(/call\('POST', '\/api\/v1\/acme\/accounts'/);
    expect(read('forms/CertificateForm.svelte')).toContain('desk.createAcmeAccount(');
  });

  it('상세가 주문 상태와 실패 이유를 보인다', () => {
    const src = read('detail/Acme.svelte');
    expect(src).toContain('lastError');
    expect(src).toContain('attempts');
  });

  it('만들기 칸은 계정이 없거나 「＋ 계정 생성」 을 눌렀을 때만 펼친다', () => {
    const src = read('forms/CertificateForm.svelte');
    expect(src).toContain('{#if noAccount || adding}');
    expect(src).toContain('＋ 계정 생성');
    expect(src, '늘 보이는 계정 만들기 카드가 남았다').not.toContain('<Card title="ACME 계정 만들기"');
  });

  it('목록의 만들기 버튼은 모두 「＋ 생성」 이다', () => {
    for (const l of ['Listener', 'HttpRoute', 'PassthroughRoute', 'Pool', 'Backend', 'AddressSet', 'Certificate', 'TlsPolicy', 'SniBinding']) {
      const src = read(`lists/${l}List.svelte`);
      expect(src, l).toMatch(/variant="primary" href="[^"]+\/new">＋ 생성<\/Button>/);
    }
  });
});
