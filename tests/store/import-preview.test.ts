/**
 * 가져오기 · 복원의 **미리 보기**와 **미리 본 head 고정** (2026-11-21).
 *
 * GUI 「백업·복원」 은 파일을 올리면 먼저 미리 본다 — 서버가 커밋과 같은 changeset · plan 경로로 바뀌는 것과 영향을
 * 계산하고 changeset 을 버린다. 그다음 커밋은 미리 본 head(`base_revision`)에서만 한다. 그 사이 head 가 움직였으면
 * 409 `head_moved` 다 — 미리 본 것과 다른 것을 커밋하지 않는다.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { ConfigStore, StoreError, type PatchOp } from '../../src/store/config-store.js';
import { exportManifest, type Manifest } from '../../src/store/manifest.js';
import { Db, dockerAvailable, pgFor, reset, startPg, stopPg, TEST_DB } from './pg-fixture.js';

const PG = pgFor('import-preview');
let db: Db;
let store: ConfigStore;

beforeAll(async () => {
  if (TEST_DB !== 'sqlite' && !dockerAvailable()) throw new Error('도커가 없다 — BARY_TEST_DB=sqlite 로 돌린다');
  startPg(PG);
  db = new Db(PG.dsn);
  await db.migrate();
  store = new ConfigStore(db);
}, 180_000);
afterAll(async () => { await db?.close(); stopPg(PG); });
beforeEach(async () => { await reset(db); });

async function commitAll(ops: PatchOp[]): Promise<string> {
  const head = await store.head();
  const cs = await store.createChangeset(head.revision, 'tester');
  await store.patchChangeset(cs, ops, 'tester');
  const plan = await store.plan(cs, 'tester');
  return (await store.commit(cs, plan.id, 'tester')).revision;
}

const base: PatchOp[] = [
  { op: 'put', kind: 'pool', key: 'app', body: { protocolClass: 'http', algorithm: 'round_robin' } },
  { op: 'put', kind: 'backend', key: 'app-1', body: { pool: 'app', host: '10.0.0.1', port: 8080, weight: 1 } },
  { op: 'put', kind: 'backend', key: 'app-2', body: { pool: 'app', host: '10.0.0.2', port: 8080, weight: 1 } },
];

const changesetStates = async (): Promise<string[]> =>
  (await db.query('SELECT state FROM changesets')).rows.map((r) => String(r['state']));

describe('가져오기 미리 보기', () => {
  it('바뀌는 것과 영향을 주고, 리비전을 안 올리고, changeset 을 버린다', async () => {
    const rev = await commitAll(base);
    const m = exportManifest(await store.modelAt(rev));
    // 백엔드 하나를 바꾸고 하나를 뺀다 — replace 면 뺀 것을 지운다.
    const edited: Manifest = {
      ...m,
      resources: m.resources
        .filter((r) => r.key !== 'app-2')
        .map((r) => (r.key === 'app-1' ? { ...r, spec: { ...r.spec, weight: 5 } } : r)),
    };
    const out = await store.importFromManifest(edited, 'replace', 'tester', { preview: true });
    expect(out.preview).toBe(true);
    expect(out.unchanged).toBe(false);
    expect(out.revision).toBe(rev);
    expect(out.changes).toEqual([
      { change: 'changed', kind: 'backend', key: 'app-1' },
      { change: 'removed', kind: 'backend', key: 'app-2' },
    ]);
    expect('impact' in out && out.impact !== undefined).toBe(true);
    expect((await store.head()).revision).toBe(rev);
    const states = await changesetStates();
    expect(states).toContain('discarded');
    expect(states).not.toContain('open');
    expect(states).not.toContain('sealed');

    // merge 면 지우지 않는다.
    const merged = await store.importFromManifest(edited, 'merge', 'tester', { preview: true });
    expect(merged.changes).toEqual([{ change: 'changed', kind: 'backend', key: 'app-1' }]);
  });

  it('같으면 changeset 을 만들지 않는다', async () => {
    const rev = await commitAll(base);
    const before = (await changesetStates()).length;
    const out = await store.importFromManifest(exportManifest(await store.modelAt(rev)), 'replace', 'tester', { preview: true });
    expect(out).toMatchObject({ unchanged: true, preview: true, revision: rev, changes: [] });
    expect((await changesetStates()).length).toBe(before);
  });

  it('검증이 실패하면 미리 보기도 실패하고 changeset 은 남지 않는다', async () => {
    await commitAll(base);
    // 없는 풀을 가리키는 백엔드.
    const bad: Manifest = { schemaVersion: '1', resources: [
      { kind: 'backend', key: 'orphan', spec: { pool: 'nope', host: '10.0.0.9', port: 1, weight: 1 } },
    ] };
    await expect(store.importFromManifest(bad, 'merge', 'tester', { preview: true })).rejects.toBeInstanceOf(Error);
    expect(await changesetStates()).not.toContain('open');
    expect(await changesetStates()).not.toContain('sealed');
  });
});

describe('미리 본 head 에서만 커밋한다', () => {
  it('head 가 움직였으면 409 head_moved', async () => {
    const rev = await commitAll(base);
    const m = exportManifest(await store.modelAt(rev));
    await commitAll([{ op: 'put', kind: 'backend', key: 'app-3', body: { pool: 'app', host: '10.0.0.3', port: 8080, weight: 1 } }]);
    const err = await store.importFromManifest(m, 'replace', 'tester', { baseRevision: rev }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StoreError);
    expect((err as StoreError).status).toBe(409);
    expect((err as StoreError).code).toBe('head_moved');
  });

  it('같은 head 면 커밋하고 바뀐 것을 싣는다', async () => {
    const rev = await commitAll(base);
    const m = exportManifest(await store.modelAt(rev));
    const edited: Manifest = { ...m, resources: m.resources.filter((r) => r.key !== 'app-2') };
    const out = await store.importFromManifest(edited, 'replace', 'tester', { baseRevision: rev });
    expect(out.unchanged).toBe(false);
    expect(out.preview).toBeUndefined();
    expect(Number(out.revision)).toBeGreaterThan(Number(rev));
    expect(out.changes).toEqual([{ change: 'removed', kind: 'backend', key: 'app-2' }]);
    expect((await store.modelAt(out.revision)).backends.map((b) => b.key)).toEqual(['app-1']);
  });
});
