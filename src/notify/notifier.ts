/**
 * 알림의 **어댑터 계약** — 운영자가 봐야 할 사건을 바깥(웹훅 · Slack · 메일)으로 보낸다.
 *
 * 다른 통로를 붙이려면 이 인터페이스의 구현 하나와 `registry.ts` 의 등록 한 줄이면 된다.
 * 무엇을 언제 보낼지(중복 억제 · 큐)는 `NotifyHub` 가, 사건을 찾는 것은 `NotifyWatch` · 데몬이 한다.
 *
 * **실패를 예외로 던지지 않는다** — 결과 객체다. 알림은 부가 기능이다. 보내기 실패가 본 동작(적용 · 발급)을 막지 않는다.
 */

export type NotifyKind =
  /** ACME 발급 · 갱신 주문이 실패했다(백오프 뒤 다시 한다). */
  | 'acme.failed'
  /** 인증서 만료가 N일 안이다. */
  | 'cert.expiring'
  /** head 의 적용(apply)이 실패했다. */
  | 'apply.failed'
  /** 이 노드가 리더가 됐거나 리더를 잃었다. */
  | 'leader.changed'
  /** 시작했지만 끝나지 않은 전환(미완 전환)이 남아 있다. */
  | 'transition.incomplete'
  /** 백업이 실패했다. **데몬 안에 백업 작업이 없어서 지금은 아무도 내지 않는다** — 바깥 백업 작업이 쓸 자리다. */
  | 'backup.failed'
  /** 전역 화면이 한 지역에 닿지 못한다. */
  | 'region.unreachable';

export type Severity = 'critical' | 'warning' | 'info';

export type NotifyEvent = {
  kind: NotifyKind;
  severity: Severity;
  /** **사건 키** — 같은 키는 재알림 간격 안에 다시 보내지 않는다. 예: `cert.expiring:web:2026-12-01T00:00:00Z`. */
  key: string;
  title: string;
  detail: string;
  /** 사람이 볼 짧은 사실들(인증서 이름 · 리비전 …). 비밀을 싣지 않는다. */
  facts?: Record<string, string | number | boolean>;
  /** ISO 시각. */
  at: string;
  /** 낸 노드(`BARY_NODE_NAME`). */
  node: string;
};

export type NotifyFailure = 'auth' | 'rejected' | 'rate-limited' | 'unavailable' | 'insecure';
export type NotifyResult = { ok: true } | { ok: false; reason: NotifyFailure; detail: string };

export interface Notifier {
  readonly kind: string;
  send(e: NotifyEvent): Promise<NotifyResult>;
}

/** HTTP 상태코드의 공통 뜻(2xx 는 호출자가 본다). */
export function notifyStatus(service: string, status: number, said: string): NotifyResult {
  if (status === 401 || status === 403) return { ok: false, reason: 'auth', detail: `${service} 가 거절했다 (${status} ${said})` };
  if (status === 429) return { ok: false, reason: 'rate-limited', detail: `${service} 가 시도를 제한했다 (${said})` };
  if (status >= 500) return { ok: false, reason: 'unavailable', detail: `${service} 가 ${status} 로 답했다 (${said})` };
  return { ok: false, reason: 'rejected', detail: `${service} 가 거절했다 (${status} ${said})` };
}

/** 사람이 읽는 한 덩어리 — Slack · 메일이 같은 글을 쓴다. */
export function plainText(e: NotifyEvent): string {
  const facts = Object.entries(e.facts ?? {}).map(([k, v]) => `  ${k}: ${String(v)}`);
  return [`[${e.severity}] ${e.title}`, '', e.detail, ...(facts.length === 0 ? [] : ['', ...facts]), '', `${e.at} · ${e.node} · ${e.kind}`].join('\n');
}
