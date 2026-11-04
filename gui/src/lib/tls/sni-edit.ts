/**
 * SNI 바인딩 폼(만들기 드로어 · 분할 인라인 · 설정 탭)이 같이 쓰는 것 — 콘솔 시안 `fieldsFor('sni')`.
 * 호스트 목록은 시안 `list` 칸이다: 한 줄에 하나, 도움말 끝에 「(N개)」.
 */
import type { createDesk } from '#lib/desk.svelte.ts';

type Desk = ReturnType<typeof createDesk>;

/** 줄 · 쉼표 · 공백으로 끊는다(붙여 넣은 목록도 받는다). */
export const parseHosts = (text: string): string[] => text.split(/[\s,]+/).map((h) => h.trim()).filter((h) => h !== '');
/** 시안 「호스트를 하나 이상 입력해요.」. */
export const hostsError = (text: string): string | undefined => (parseHosts(text).length === 0 ? '호스트를 하나 이상 입력해요.' : undefined);
/** 시안 `list` 칸의 도움말 — 「한 줄에 하나씩 입력해요. (N개)」. */
export const hostsHelp = (text: string): string => `한 줄에 하나씩 입력해요. (${text.split('\n').filter((x) => x.trim() !== '').length}개)`;
/** 시안 `list` 칸의 줄 수 — `Math.max(3, 줄 수)`. */
export const listRows = (text: string): number => Math.max(3, text.split('\n').length);

/** 시안: 리스너는 HTTPS 리스너만. */
export const httpsListeners = (desk: Desk): { value: string }[] =>
  desk.listeners.rows.filter((l) => l.protocol === 'https').map((l) => ({ value: l.key }));
/** 인증서 — 자료가 있는 것만(자료 없는 인증서는 바인딩할 수 없다, 검증기가 막는다). */
export const boundCerts = (desk: Desk, keep?: string): { value: string }[] =>
  desk.certs.rows.filter((c) => c.hasMaterial || c.key === keep).map((c) => ({ value: c.key }));
