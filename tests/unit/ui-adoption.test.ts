/**
 * 화면이 디자인 시스템 컴포넌트를 쓰는가 (#126).
 *
 * 공통 컴포넌트(`#lib/ui`)를 만들어 두고 화면이 자기 마크업을 계속 그리면, 시안을 고칠 때 두 벌을
 * 고쳐야 하고 한 벌은 반드시 낡는다. 그래서 「이 화면은 공통 컴포넌트로 옮겼다」 를 기계로 지킨다.
 * 단계마다 아래 표에 화면을 더한다.
 *
 *   1단계(이 파일의 첫 판) — 리소스 목록 9개는 `DataTable` 이다.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const GUI = join(dirname(fileURLToPath(import.meta.url)), '../../gui/src');
const read = (p: string): string => readFileSync(join(GUI, p), 'utf8');
/**
 * 스크립트 · 스타일을 뺀 마크업 — 마지막 스크립트 닫는 태그 뒤부터 스타일 여는 태그 앞까지.
 * 정규식으로 태그를 지우지 않는다(코드 스캔이 그것을 불완전한 정화로 본다). 우리 파일의 모양은
 * 언제나 「스크립트들 → 마크업 → 스타일」 이다.
 */
const markup = (src: string): string => {
  const close = '</' + 'script>';
  const start = src.lastIndexOf(close);
  const body = start < 0 ? src : src.slice(start + close.length);
  const style = body.indexOf('<' + 'style');
  return style < 0 ? body : body.slice(0, style);
};

const LISTS: readonly [route: string, component: string][] = [
  ['routes/traffic/listener/+page.svelte', 'ListenerList'],
  ['routes/traffic/route/http/+page.svelte', 'HttpRouteList'],
  ['routes/traffic/route/passthrough/+page.svelte', 'PassthroughRouteList'],
  ['routes/traffic/pool/+page.svelte', 'PoolList'],
  ['routes/traffic/backend/+page.svelte', 'BackendList'],
  ['routes/traffic/address-set/+page.svelte', 'AddressSetList'],
  ['routes/tls/certificate/+page.svelte', 'CertificateList'],
  ['routes/tls/policy/+page.svelte', 'TlsPolicyList'],
  ['routes/tls/sni/+page.svelte', 'SniBindingList'],
];

describe('리소스 목록은 공통 데이터 테이블이다', () => {
  for (const [route, component] of LISTS) {
    it(`${route} → ${component} → DataTable`, () => {
      expect(read(route)).toContain(`from '#lib/lists/${component}.svelte'`);
      const src = read(`lib/lists/${component}.svelte`);
      expect(src).toMatch(/import \{[^}]*\bDataTable\b[^}]*\} from '#lib\/ui'/);
      expect(markup(src)).toContain('<DataTable');
      // 자기 표·목록을 그리지 않는다 — 그건 DataTable 의 몫이다.
      expect(markup(src)).not.toMatch(/<(table|ul|ol)\b/);
      // 「만들기」 는 페이지 머리 오른쪽이다(시안). 전역 모드면 안 그린다.
      expect(src).toContain('usePageActions(');
    });
  }

  it('목록의 삭제는 이름을 넣는 확인 대화상자를 거친다', () => {
    const dlg = read('lib/lists/DeleteConfirm.svelte');
    expect(dlg).toMatch(/requireName=\{target\.key\}/);
    for (const [, component] of LISTS) {
      const src = read(`lib/lists/${component}.svelte`);
      if (src.includes("'삭제…'")) expect(src, component).toContain('<DeleteConfirm');
    }
  });
});
