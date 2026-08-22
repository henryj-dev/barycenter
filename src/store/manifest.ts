/**
 * 안정 키 매니페스트 — DESIGN.md §5.5
 *
 * export/import 의 정본 식별자는 `key` 다. 모델에 UUID 가 없으므로 remap 표는
 * 필요 없다. spec 만 나간다 — id/version/revision/status 는 여기에 없다.
 *
 * 별도 YAML 문법을 만들지 않는다. CLI 가 API 와 다른 모양을 들면 둘이 갈라진다
 * (bary.ts 가 patch 배열을 그대로 쓰는 이유와 같다). JSON 이 계약이다.
 *
 * import 는 **한 장의 changeset** 이다. 순차 CRUD 로 풀어 쓰면 중간 상태가
 * 커밋되고, 두 번째 import 가 같은 결과가 된다는 말을 할 수 없다.
 */
import type { Model } from '../model/provisional.js';
import type { PatchOp, ResourceKind } from './config-store.js';

export const MANIFEST_SCHEMA = '1' as const;

const KINDS: readonly ResourceKind[] = [
  'pool', 'backend', 'certificate', 'tlsPolicy', 'listener',
  'httpRoute', 'passthroughRoute', 'sniBinding',
];

const BAG: Record<ResourceKind, keyof Model> = {
  pool: 'pools',
  backend: 'backends',
  certificate: 'certificates',
  tlsPolicy: 'tlsPolicies',
  listener: 'listeners',
  httpRoute: 'httpRoutes',
  passthroughRoute: 'passthroughRoutes',
  sniBinding: 'sniBindings',
};

export type ManifestResource = {
  kind: ResourceKind;
  key: string;
  spec: Record<string, unknown>;
};

export type Manifest = {
  schemaVersion: typeof MANIFEST_SCHEMA;
  resources: ManifestResource[];
};

export type ImportMode = 'merge' | 'replace';

const isKind = (v: unknown): v is ResourceKind =>
  typeof v === 'string' && (KINDS as readonly string[]).includes(v);

/** 키 순서를 고정해 비교한다. 필드 순서만 다른 같은 spec 을 다른 것으로 세지 않는다. */
export function canon(v: unknown): string {
  return JSON.stringify(v, (_k, x: unknown) => {
    if (x !== null && typeof x === 'object' && !Array.isArray(x)) {
      const o = x as Record<string, unknown>;
      return Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]]));
    }
    return x;
  });
}

function specOf(row: object): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (k === 'key') continue;
    out[k] = v;
  }
  return out;
}

function resourcesOf(model: Model): ManifestResource[] {
  const out: ManifestResource[] = [];
  for (const kind of KINDS) {
    const bag = model[BAG[kind]];
    if (!Array.isArray(bag)) continue;
    for (const row of bag) {
      if (row === null || typeof row !== 'object' || !('key' in row)) continue;
      out.push({ kind, key: String((row as { key: string }).key), spec: specOf(row) });
    }
  }
  return out;
}

export function exportManifest(model: Model): Manifest {
  return { schemaVersion: MANIFEST_SCHEMA, resources: resourcesOf(model) };
}

export function parseManifest(input: unknown): Manifest {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('매니페스트는 객체여야 한다');
  }
  const obj = input as Record<string, unknown>;
  for (const k of Object.keys(obj)) {
    if (k !== 'schemaVersion' && k !== 'resources') {
      throw new Error(`매니페스트에 모르는 필드 '${k}'`);
    }
  }
  if (obj['schemaVersion'] !== MANIFEST_SCHEMA) {
    throw new Error(`schemaVersion 은 '${MANIFEST_SCHEMA}' 이어야 한다`);
  }
  const raw = obj['resources'];
  if (!Array.isArray(raw)) throw new Error('resources 는 배열이어야 한다');
  const resources = raw.map((r, i) => {
    if (r === null || typeof r !== 'object' || Array.isArray(r)) {
      throw new Error(`resources[${i}] 는 객체여야 한다`);
    }
    const rec = r as Record<string, unknown>;
    for (const k of Object.keys(rec)) {
      if (k !== 'kind' && k !== 'key' && k !== 'spec') {
        throw new Error(`resources[${i}] 에 모르는 필드 '${k}'`);
      }
    }
    const kind = rec['kind'];
    const key = rec['key'];
    const spec = rec['spec'];
    if (!isKind(kind)) throw new Error(`resources[${i}].kind 가 아는 종류가 아니다`);
    if (typeof key !== 'string' || key === '') {
      throw new Error(`resources[${i}].key 는 비어 있지 않은 문자열이어야 한다`);
    }
    if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) {
      throw new Error(`resources[${i}].spec 은 객체여야 한다`);
    }
    if ('key' in spec) throw new Error(`resources[${i}].spec 에 key 를 넣지 마라 — 옆자리가 정본이다`);
    return { kind, key, spec: spec as Record<string, unknown> };
  });
  return { schemaVersion: MANIFEST_SCHEMA, resources };
}

/**
 * 현재 모델과 매니페스트의 차이. 비면 두 번째 import 는 쓸 것이 없다.
 *
 * merge 는 매니페스트에 있는 것만 맞춘다. replace 는 매니페스트에 없는 현재 자원을 지운다.
 */
export function importPatch(current: Model, manifest: Manifest, mode: ImportMode): PatchOp[] {
  const have = new Map<string, Record<string, unknown>>();
  for (const r of resourcesOf(current)) have.set(`${r.kind}\0${r.key}`, r.spec);

  const want = new Set<string>();
  const ops: PatchOp[] = [];
  for (const r of manifest.resources) {
    const id = `${r.kind}\0${r.key}`;
    want.add(id);
    if (canon(have.get(id)) !== canon(r.spec)) {
      ops.push({ op: 'put', kind: r.kind, key: r.key, body: r.spec });
    }
  }
  if (mode === 'replace') {
    /**
     * **참조하는 쪽부터 지운다** (검수 B-03).
     *
     * `have` 는 `KINDS` 순(풀 → 백엔드 → … → 리스너 → 라우트)으로 채워지는데, 그건
     * **만들 때의 순서**다. 지울 때는 반대여야 한다 — DDL 이 그렇게 걸려 있다:
     *
     *   listeners.default_pool_id → pools     ON DELETE RESTRICT
     *   http_routes.listener_id   → listeners ON DELETE RESTRICT
     *   backends.pool_id          → pools     ON DELETE CASCADE
     *
     * 그대로 두면 리소스를 지우는 `replace` import 와 `POST /restore` 가 첫 delete 에서
     * 422 로 죽는다. CASCADE 쪽은 더 조용하다 — 풀을 먼저 지우면 백엔드가 딸려 가고,
     * 그 다음 백엔드 delete 가 "없다" 로 409 를 낸다.
     *
     * `rollbackTo` 는 이미 라우트 → 리스너 → 풀 순서로 지운다. **같은 규칙을 두 자리에
     * 적는 셈이라, 한쪽이 틀려 있었다.**
     */
    const rank = new Map(KINDS.map((k, i) => [k, i]));
    const doomed = [...have.keys()]
      .filter((id) => !want.has(id))
      .map((id) => {
        const sep = id.indexOf('\0');
        return { kind: id.slice(0, sep) as ResourceKind, key: id.slice(sep + 1) };
      })
      .sort((a, b) => (rank.get(b.kind) ?? 0) - (rank.get(a.kind) ?? 0));
    for (const { kind, key } of doomed) ops.push({ op: 'delete', kind, key });
  }
  return ops;
}
