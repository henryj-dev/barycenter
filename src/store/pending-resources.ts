/**
 * **적용 대기 리소스** — 엔진이 지금 돌리는 리비전(활성)과 커밋된 head 를 리소스 하나씩 비교한다 (#126 후속).
 *
 * GUI 가 목록 · 상세에 「◐ 적용 대기」 를 붙이는 근거다. 리스너 단위가 아니라 (kind, key) 단위다 — 라우트 하나만
 * 바뀌어도 그 라우트에만 붙는다.
 *
 * **모델이 가진 것만 비교한다.** 인증서 *자료*(PEM · 키)는 모델 밖의 비밀 저장소에 있다 — 여기서는 인증서 리소스의
 * 모델 필드(이름 · 출처 · 참조)가 바뀌었는지만 본다. 자료만 바꾼 것은 리비전을 만들지 않으므로 여기에 안 나온다.
 * 엔진 전역 설정(`engine`)은 key 가 있는 리소스가 아니라서 뺀다.
 */
import type { Model } from '../model/provisional.js';
import type { HistoryKind } from './config-store.js';

/** kind → 모델의 컬렉션. `HISTORY_COLLECTIONS` 와 같아야 한다 — kind 가 늘면 이 타입이 빨개진다. */
const COLLECTIONS: Record<HistoryKind, keyof Model> = {
  listener: 'listeners',
  httpRoute: 'httpRoutes',
  passthroughRoute: 'passthroughRoutes',
  pool: 'pools',
  backend: 'backends',
  certificate: 'certificates',
  tlsPolicy: 'tlsPolicies',
  sniBinding: 'sniBindings',
  addressSet: 'addressSets',
};

export type PendingResource = {
  kind: HistoryKind;
  key: string;
  change: 'added' | 'changed' | 'removed';
};

export type PendingResources = {
  /** 엔진이 돌리는 리비전. 아직 활성화된 적이 없으면 null. */
  activeRevision: string | null;
  headRevision: string;
  resources: PendingResource[];
};

/** 키 순서와 상관없는 직렬화. 다시 직렬화해서 키 순서만 바뀐 것을 「바뀜」 이라 하지 않는다. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v !== null && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}

function byKey(model: Model | undefined, collection: keyof Model): Map<string, string> {
  const items = (model?.[collection] ?? []) as unknown;
  const out = new Map<string, string>();
  if (!Array.isArray(items)) return out;
  for (const item of items as { key?: unknown }[]) {
    if (typeof item?.key === 'string') out.set(item.key, canonical(item));
  }
  return out;
}

/**
 * 활성 모델과 head 모델의 차이. `active` 가 없으면(활성화된 적이 없다) head 의 모든 리소스가 `added` 다.
 * 순서: kind 순(위 표), 그 안에서 key 순.
 */
export function diffResources(active: Model | undefined, head: Model): PendingResource[] {
  const out: PendingResource[] = [];
  for (const [kind, collection] of Object.entries(COLLECTIONS) as [HistoryKind, keyof Model][]) {
    const before = byKey(active, collection);
    const after = byKey(head, collection);
    const keys = [...new Set([...before.keys(), ...after.keys()])].sort();
    for (const key of keys) {
      const b = before.get(key);
      const a = after.get(key);
      if (b === undefined && a !== undefined) out.push({ kind, key, change: 'added' });
      else if (b !== undefined && a === undefined) out.push({ kind, key, change: 'removed' });
      else if (b !== a) out.push({ kind, key, change: 'changed' });
    }
  }
  return out;
}
