/**
 * TLS 화면(인증서 · TLS 정책 · SNI 바인딩)을 콘솔 시안과 1:1 로 (2026-11-04, 사용자 요구 「모든 요소를 시안과 1:1」).
 *
 * 재는 것:
 *   · 인증서 만료일 칸이 시안 `cells('certs')` 식 그대로다 — 넉넉하면 **배지 없이 날짜만**(지난 PR 은 정상 인증서에도 배지를 달았다)
 *   · 목록 열이 시안 `colsOf` 그대로고, 칸에 링크가 없고, 분할 인라인 수정이 시안 `INL` 필드만 둔다
 *   · 만들기 드로어의 필드 · 문구가 시안 `fieldsFor(…, true, 'drawer')` 그대로다(ACME 계정 「＋ 새 계정」 · DNS-01 「준비 중」 · 적용 안내)
 *   · 상세: 인증서 머리 메타(발급자 · 만료 · 사용처) · 「자료를 교체해요」 · 개요(주체 · SAN · 지문 · ACME 주문) · 설정 폼 · 연결 · 기록
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const GUI = join(dirname(fileURLToPath(import.meta.url)), '../../gui/src');
const src = (p: string): string => readFileSync(join(GUI, p), 'utf8');

describe('인증서 만료일 칸 — 시안 식 그대로', () => {
  it('넉넉하면 날짜만 · 30일 안이면 ▲ 「(N일 전)」 · 지났으면 ✕ 「(만료됨)」', async () => {
    const { certExpiryCell } = await import('../../gui/src/lib/tls/cert-cells.js');
    const at = (notAfter: string, d: number) => certExpiryCell({ acme: true, notAfter, expiresInDays: d });
    expect(at('2027-02-02T00:00:00Z', 96), '정상 인증서에 배지를 달지 않는다').toEqual({ kind: 'mono', t: '2027-02-02' });
    expect(at('2026-12-04T00:00:00Z', 31)).toEqual({ kind: 'mono', t: '2026-12-04' });
    expect(at('2026-12-03T00:00:00Z', 30)).toEqual({ kind: 'badge', tone: 'warn', icon: '▲', t: '2026-12-03 (30일 전)' });
    expect(at('2026-11-10T00:00:00Z', 12)).toEqual({ kind: 'badge', tone: 'warn', icon: '▲', t: '2026-11-10 (12일 전)' });
    expect(at('2026-11-04T00:00:00Z', 0)).toEqual({ kind: 'badge', tone: 'warn', icon: '▲', t: '2026-11-04 (0일 전)' });
    expect(at('2026-10-20T00:00:00Z', -9)).toEqual({ kind: 'badge', tone: 'danger', icon: '✕', t: '2026-10-20 (만료됨)' });
  });

  it('자료가 없으면 남은 날을 모른다 — ACME 는 「발급 대기」, 업로드는 「—」', async () => {
    const { certExpiryCell } = await import('../../gui/src/lib/tls/cert-cells.js');
    expect(certExpiryCell({ acme: true, notAfter: undefined, expiresInDays: undefined })).toEqual({ kind: 'mono', t: '발급 대기' });
    expect(certExpiryCell({ acme: false, notAfter: undefined, expiresInDays: undefined })).toEqual({ kind: 'mono', t: '—' });
  });
});

describe('목록 — 시안 colsOf · cells · INL', () => {
  const LISTS = [
    ['CertificateList', ['이름', '도메인', '발급자', '만료일', '사용처'], 'CertificateInline'],
    ['TlsPolicyList', ['이름', '최소 버전', '최대 버전', '암호군', 'HSTS', 'SNI-Host 불일치'], 'TlsPolicyInline'],
    ['SniBindingList', ['이름', '리스너', '호스트 수', '호스트', '인증서'], 'SniBindingInline'],
  ] as const;

  it.each(LISTS)('%s: 열이 시안 순서 · 칸은 평문 · 분할 인라인 수정', (file, cols, inline) => {
    const s = src(`lib/lists/${file}.svelte`);
    const labels = [...s.matchAll(/\{ key: '[^']+', label: '([^']+)'/g)].map((m) => m[1]);
    expect(labels.slice(0, cols.length)).toEqual([...cols]);
    expect(s, '칸에 링크를 두지 않는다').not.toMatch(/<a\s/);
    expect(s).toContain(`<${inline} {key} {detailHref} {pending} />`);
    expect(s).toMatch(/search=\{\{\}\}( \{chips\})? fill/);
    expect(s).toContain("label: '상세 페이지 열기'");
  });

  it('TLS 정책의 「사용처」 는 시안에 없는 기존 열 — 처음에 숨긴다', () => {
    expect(src('lib/lists/TlsPolicyList.svelte')).toMatch(/label: '사용처'.*hidden: true/);
  });

  it('칸 값은 시안 cells 식이다', () => {
    const v = src('lib/tls/tls-view.ts');
    expect(v).toContain("x(age === undefined ? '꺼짐' : `max-age ${age}s`), x(p['sniHostMismatch'] === 'reject_421' ? '거절' : '허용')");
    expect(v).toContain("x(`${hs.length}개`)");
    expect(v).toContain("`${hs[0]}${hs.length > 1 ? ` 외 ${hs.length - 1}` : ''}`");
    expect(v).toContain('[m(c.key), m(certDomains(desk, c).join(\', \')), x(certIssuer(c)), certExpiryCell(c), x(certUsage(desk, c.key))]');
  });

  it.each([
    ['CertificateInline', ['도메인', '자동 갱신']],
    ['TlsPolicyInline', ['최소 버전', '최대 버전', '암호군']],
    ['SniBindingInline', ['호스트 목록', '인증서']],
  ] as const)('%s 는 시안 INL 필드만 둔다(구획 「기본」)', (file, rows) => {
    const s = src(`lib/tls/${file}.svelte`);
    expect([...s.matchAll(/<FormRow label="([^"]+)"/g)].map((m) => m[1])).toEqual([...rows]);
    expect(s).toContain('<FormSection title="기본">');
    expect(s).toContain('<InlineEdit ');
  });
});

describe('만들기 드로어 — 시안 fieldsFor(…, true, \'drawer\')', () => {
  it('인증서: 이름 · 도메인 · 발급자 · ACME 계정 · 자동 갱신 · 검증 방식 · DNS 공급자 · 적용', () => {
    const s = src('lib/forms/CertificateForm.svelte');
    const rows = [...s.matchAll(/<FormRow label="([^"]+)"|<AcmeAccountField /g)].map((m) => m[1] ?? 'ACME 계정');
    expect(rows).toEqual(['이름', '도메인', '발급자', 'ACME 계정', '자동 갱신', '검증 방식', 'DNS 공급자', '적용', '인증서 체인', '개인 키']);
    expect(s).toContain("<Resolved items={[['상태', '준비 중']]} help=\"DNS-01 공급자 설정은 아직 없어요. 준비 중이에요.\" />");
    expect(s).toContain("'적용 대기 중인 변경이 있어서 함께 적용해야 해요. 적용하면 발급을 시작해요.'");
    expect(s).toContain("'트래픽이 바뀌지 않아서 바로 적용해요. 발급은 이어서 진행해요.'");
    expect(s).toContain("link={{ label: '적용 대기로 가기', href: '/change/pending' }}");
    expect(s).toContain('help="쉼표로 구분해요."');
    expect(s).toContain("'도메인 형식으로 입력해요.'");
  });

  it('ACME 계정: 「이름 · 연락 이메일」 줄 + 「＋ 새 계정」 → 계정 이름 · 연락 이메일', () => {
    const s = src('lib/forms/AcmeAccountField.svelte');
    expect(s).toContain('`${a.key} · ${mail(a)}`');
    expect(s).toContain('<FormRow label="계정 이름"');
    expect(s).toContain('<FormRow label="연락 이메일"');
    expect(s).toContain("'name@example.com 형식으로 입력해요.'");
  });

  it('TLS 정책: 기본 · HSTS · 검증 / SNI: 기본', () => {
    const t = src('lib/forms/TlsPolicyForm.svelte');
    expect([...t.matchAll(/<FormSection title="([^"]+)"/g)].map((m) => m[1])).toEqual(['기본', 'HSTS', '검증']);
    expect([...t.matchAll(/<FormRow label="([^"]+)"/g)].map((m) => m[1])).toEqual(['이름', '최소 버전', '최대 버전', '암호군', 'HSTS', 'max-age', '하위 도메인', 'SNI-Host 불일치']);
    const p = src('lib/tls/policy-edit.ts');
    expect(p).toContain("[{ value: 'reject_421', label: '거절' }, { value: 'allow', label: '허용' }]");
    const n = src('lib/forms/SniBindingForm.svelte');
    expect([...n.matchAll(/<FormRow label="([^"]+)"/g)].map((m) => m[1])).toEqual(['이름', '리스너', '호스트 목록', '인증서']);
    expect(src('lib/tls/sni-edit.ts')).toContain('`한 줄에 하나씩 입력해요. (${');
  });
});

describe('상세 — 시안 상세 페이지', () => {
  it('라우트가 TLS 상세 틀 · 탭을 쓴다', () => {
    for (const d of ['certificate', 'policy', 'sni']) {
      expect(src(`routes/tls/${d}/[key]/+layout.svelte`)).toContain('<TlsFrame kind=');
      expect(src(`routes/tls/${d}/[key]/+page.svelte`)).toContain('<TlsOverview kind=');
      expect(src(`routes/tls/${d}/[key]/settings/+page.svelte`)).toContain('<TlsSettings kind=');
      expect(src(`routes/tls/${d}/[key]/resources/+page.svelte`)).toContain('<TlsRelations kind=');
      expect(src(`routes/tls/${d}/[key]/history/+page.svelte`)).toContain('<TlsHistory kind=');
    }
  });

  it('인증서 머리: 메타 「발급자 · 만료 · 사용처」 · 업로드는 「자료를 교체해요」 · 배지는 첫 배지 칸', () => {
    const f = src('lib/tls/TlsFrame.svelte');
    expect(f).toContain("{ label: '발급자', value: certIssuer(cert) }");
    expect(f).toContain("{ label: '만료', value: certExp(cert) || '—', mono: true }");
    expect(f).toContain("{ label: '사용처', value: certUsage(desk, key) }");
    expect(f).toContain('>자료를 교체해요</Button>');
    expect(f).toContain("find((c) => c.kind === 'badge')");
    expect(src('lib/detail/ResourceFrame.svelte')).toContain('{#if edit}{@render edit()}{:else if spec.editable');
  });

  it('개요: 열 이름 + 칸(ovRows) · 인증서는 주체 · SAN · 지문 · ACME 주문', () => {
    const o = src('lib/tls/TlsOverview.svelte');
    expect(o).toContain("{ l: '주체', v: subject, mono: true }, { l: 'SAN', v: san, mono: true }, { l: '지문', v: '—', mono: true }");
    expect(o).toContain('grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 14px 24px;');
    const a = src('lib/detail/Acme.svelte');
    expect(a).toContain('<div class="t">ACME 주문</div>');
    expect(a).toContain('마지막 갱신 {notBefore} · {challenge} · 다음 시도 —');
  });

  it('설정 탭: 저장 줄(안내 · 되돌리기 · 저장) · 읽기 전용이면 보기 구획', () => {
    const s = src('lib/tls/SettingsFrame.svelte');
    expect(s).toContain("'저장하면 커밋하고 적용 대기에 새 리비전이 생겨요.'");
    expect(s).toContain('{#if scope?.blocked === true}');
    expect(s).toContain('<WriteNote />');
  });

  it('연결 · 기록: 시안 격자(100px 1fr 1fr · 110px 1fr 40px)와 문구', () => {
    const r = src('lib/tls/TlsRelations.svelte');
    expect(r).toContain('grid-template-columns: 100px 1fr 1fr;');
    expect(r).toContain("'TLS 정책으로 사용'");
    expect(r).toContain("'이 바인딩이 속한 리스너'");
    expect(r).toContain("'호스트에 연결한 인증서'");
    const h = src('lib/tls/TlsHistory.svelte');
    expect(h).toContain('grid-template-columns: 110px 1fr 40px;');
    expect(h).toContain('`${key} 만듦`');
  });
});
