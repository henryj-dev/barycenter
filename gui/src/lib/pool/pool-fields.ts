/**
 * 풀 칸 — 시안 `fieldsFor('pools')` 의 알고리즘 선택지와 hash 키 검사. 만들기 · 설정 탭 · 인라인 수정이 같이 쓴다.
 * 규칙은 검증기와 같다 — stream(TCP · UDP) 풀은 `remote_addr` 만 쓴다. 최종 판정은 서버다(`invalid_hash_key`).
 */
export type Algo = 'round_robin' | 'least_conn' | 'source_ip_hash' | 'hash';
/** 시안 선택지 글: round_robin · least_conn · ip_hash · hash. 모델의 이름은 `source_ip_hash` 다. */
export const ALGOS: { value: Algo; label: string }[] = [
  { value: 'round_robin', label: 'round_robin' },
  { value: 'least_conn', label: 'least_conn' },
  { value: 'source_ip_hash', label: 'ip_hash' },
  { value: 'hash', label: 'hash' },
];

/** hash 키 — 시안 「hash 키를 입력해요.」 + 검증기와 같은 꼴. 맞으면 undefined. */
export function hashKeyError(v: string, protocolClass: string): string | undefined {
  const t = v.trim();
  if (t === '') return 'hash 키를 입력해요.';
  if (t === 'remote_addr') return undefined;
  if (protocolClass !== 'http') return `${protocolClass.toUpperCase()} 풀은 remote_addr 만 쓸 수 있어요.`;
  if (t === 'request_uri' || /^header\([A-Za-z0-9-]+\)$/.test(t) || /^cookie\([A-Za-z0-9_]+\)$/.test(t)) return undefined;
  return 'remote_addr · request_uri · header(이름) · cookie(이름) 중 하나예요.';
}
