/**
 * 인증서 수정(분할 인라인 · 설정 탭)이 같이 쓰는 규칙.
 *
 * 인증서에서 사람이 고치는 것은 **ACME 의도**(계정 · 도메인)뿐이다. 자료(PEM)는 「자료를 교체해요」 가 새로 올린다.
 * `put` 은 통째로 덮으므로 자료 참조 · digest 는 head 값 그대로 다시 싣는다.
 * **모델의 칸만 싣는다.** 화면이 받은 인증서에는 API 가 붙인 표시용 칸(만료 · 주체 …)이 섞여 있어서,
 * 그대로 보내면 해독기가 「모양이 잘못됐다」 로 거절한다.
 */
import type { Item } from '../../../../src/web/resources.js';

export const MODEL_FIELDS = ['materialRef', 'chainDigest', 'keyDigest'] as const;

/** head 의 인증서에서 모델 칸만 + 새 ACME 의도. */
export const certBody = (item: Item, acme: { account: string; domains: string[] }): Record<string, unknown> => {
  const body: Record<string, unknown> = {};
  for (const f of MODEL_FIELDS) if (item[f] !== undefined) body[f] = item[f];
  return { ...body, acme };
};

/** 호스트 이름 하나. 와일드카드는 맨 앞 `*.` 하나만. */
const HOST = /^(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** 시안 「도메인」 칸 — 쉼표로 구분한다(공백 · 줄바꿈도 받는다). */
export const parseDomains = (text: string): string[] =>
  text.split(/[\s,]+/).map((d) => d.trim().toLowerCase()).filter((d) => d !== '');

/** 도메인 칸 오류 — 시안 「도메인을 하나 이상 입력해요.」. 이름 모양이 틀리면 그 이름을 든다. */
export const domainsError = (text: string): string | undefined => {
  const list = parseDomains(text);
  if (list.length === 0) return '도메인을 하나 이상 입력해요.';
  const bad = list.find((d) => !HOST.test(d));
  return bad === undefined ? undefined : `${bad} 는 도메인 이름이 아니에요. 예: app.example.com · *.example.com`;
};

/** 검증 방식 — 서버가 도메인을 보고 고른다(와일드카드 → DNS-01, 나머지 → HTTP-01). */
export const challengeOf = (domains: readonly string[]): 'HTTP-01' | 'DNS-01' =>
  (domains.some((d) => d.startsWith('*.')) ? 'DNS-01' : 'HTTP-01');
