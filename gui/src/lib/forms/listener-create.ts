/**
 * 리스너 만들기 드로어의 「활성화」 · 「HTTP/2」 · 「원본 IP」 · 「preread 타임아웃」(시안 `fieldsFor('listeners', v, true, 'drawer')`).
 *
 * 만들기 patch 빌더(`put*ListenerPatch`)는 이것들을 받지 않는다 — 기본값이면 그대로 `desk.insert*Listener` 를 쓰고,
 * 기본값이 아닐 때만 같은 빌더가 만든 put 본문에 칸을 얹어 `desk.putResource` 로 올린다(같은 commit 이다).
 * 모양 검사는 그대로 저장소(해독기 · 검증기)가 한다.
 */
import { parseSourceAllow } from '../../../../src/web/edit.js';

/** 원본 IP — 설정 탭의 「원본 IP」 구획과 같은 값이다(`RealIpSection`). */
export type RealIpInput = { source: 'none' | 'proxy' | 'header'; header: string; trusted: string };

export type ListenerSwitches = {
  enabled: boolean;
  http2?: boolean;
  realIp?: RealIpInput;
  /** 패스스루만. 비우면 nginx 기본값이다. */
  preread?: string;
};

/** 원본 IP → 본문 칸. 「없음」 이면 아무 칸도 안 만든다. 헤더는 http 계열에서만 뜻이 있다(해독기가 막는다). */
export function realIpFields(r: RealIpInput | undefined): Record<string, unknown> {
  if (r === undefined || r.source === 'none') return {};
  const trustedCidrs = parseSourceAllow(r.trusted) ?? [];
  return r.source === 'header'
    ? { realIpFromHeader: { header: r.header, trustedCidrs } }
    : { acceptProxyProtocol: { trustedCidrs } };
}

/** 기본값과 같은가 — 그러면 원래 만들기 길을 쓴다. */
export const plainSwitches = (s: ListenerSwitches): boolean =>
  s.enabled && s.http2 !== false && (s.realIp === undefined || s.realIp.source === 'none') && (s.preread ?? '').trim() === '';

/** patch 의 첫 put 에 스위치를 얹은 본문. */
export function switchedBody(ops: readonly { key: string; body: object }[], s: ListenerSwitches): { key: string; body: Record<string, unknown> } {
  const op = ops[0];
  if (op === undefined) throw new Error('만들 리스너가 없다');
  const body: Record<string, unknown> = { ...(op.body as Record<string, unknown>), ...realIpFields(s.realIp) };
  if (!s.enabled) body['enabled'] = false;
  if (s.http2 === false) body['http2'] = false;
  const preread = (s.preread ?? '').trim();
  if (preread !== '') body['prereadTimeoutS'] = Number(preread);
  return { key: op.key, body };
}

/** 해독기와 같은 범위 — 1–3600 초. 비우면 nginx 기본값이다. */
export const prereadError = (v: string): string | undefined => {
  const t = v.trim();
  if (t === '') return undefined;
  const n = Number(t);
  return Number.isInteger(n) && n >= 1 && n <= 3600 ? undefined : '1–3600 사이의 정수(초)예요.';
};
