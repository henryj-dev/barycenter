/**
 * 저장한 뒤 어디로 가나 (2026-10-30, web-01 에서 인증서를 넣고 나온 지적).
 *
 * 전에는 무엇을 저장하든 적용 대기 화면(`/change/pending`)으로 끌고 갔다. 사람은 방금 만든 것을 먼저 보고
 * 싶고, 시안도 그렇다 — 만들면 그 항목을 보이고 「커밋했어요」 토스트를 띄운다. 적용은 셸의 적용 대기
 * 배너가 늘 알린다.
 *
 * 재는 것:
 *   · 저장 뒤 동작(`after`)이 적용 대기로 보내지 않고, 토스트를 띄운다
 *   · 만들기 폼마다 그 리소스의 상세 주소(`resourcePath(종류, …)`)로 간다
 *   · 방금 만든 것이 모델에 늦게 와도 상세 틀이 곧바로 「없어요」 를 보이지 않는다
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const LIB = join(dirname(fileURLToPath(import.meta.url)), '../../gui/src/lib');
const read = (p: string): string => readFileSync(join(LIB, p), 'utf8');

const FORMS: readonly [file: string, kind: string][] = [
  ['forms/HttpListenerForm.svelte', 'listener'],
  ['forms/TcpListenerForm.svelte', 'listener'],
  ['forms/UdpListenerForm.svelte', 'listener'],
  ['forms/PassthroughListenerForm.svelte', 'listener'],
  ['forms/HttpRouteForm.svelte', 'httpRoute'],
  ['forms/PassthroughRouteForm.svelte', 'passthroughRoute'],
  ['forms/PoolForm.svelte', 'pool'],
  ['forms/BackendForm.svelte', 'backend'],
  ['forms/AddressSetForm.svelte', 'addressSet'],
  ['forms/CertificateForm.svelte', 'certificate'],
  ['forms/TlsPolicyForm.svelte', 'tlsPolicy'],
  ['forms/SniBindingForm.svelte', 'sniBinding'],
];

describe('저장한 뒤', () => {
  it('적용 대기로 끌고 가지 않고 「커밋했어요」 를 알린다', () => {
    const src = read('after.ts');
    expect(src).not.toContain('/change/pending');
    expect(src).toContain('toast.ok(');
  });

  for (const [file, kind] of FORMS) {
    it(`${file} → ${kind} 상세`, () => {
      const src = read(file);
      expect(src).toContain(`after(resourcePath('${kind}'`);
      expect(src, '어디로 갈지 없이 넘긴다').not.toMatch(/\.then\(after\)/);
    });
  }

  it('수정 · URL로 다시 만들기도 그 리소스로 돌아간다', () => {
    expect(read('detail/JsonEdit.svelte')).toContain('after(resourcePath(kind, key))');
    expect(read('listener/ListenerForm.svelte')).toContain("after(resourcePath('listener', key))");
    expect(read('detail/Rebuild.svelte')).toContain("after(resourcePath('httpRoute', key))");
  });

  it('상세 틀은 방금 만든 것을 잠깐 기다린다', () => {
    const src = read('detail/ResourceFrame.svelte');
    expect(src).toMatch(/item === undefined && !settled/);
  });
});
