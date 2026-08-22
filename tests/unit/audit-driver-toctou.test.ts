/**
 * 검수 2026-08-22 · S-09 — **검사한 바이트와 실행한 바이트가 같다**
 *
 * `loadDriver` 는 `readFileSync` 로 바이트를 읽어 sha512 를 대조한 뒤, **같은 경로를 다시**
 * `import()` 했다. 그 사이에 파일이 바뀌면 검사를 통과한 바이트와 실행되는 바이트가 다르다 —
 * 무결성 검사가 있는데 없는 것과 같다.
 *
 * 이 모듈의 존재 이유가 *"설정의 패키지명을 그대로 `import()` 하면 공급망이 설정 파일이
 * 된다"* 이고, 그렇다면 검사와 실행 사이에 창을 남기면 안 된다.
 *
 * ── 대가를 적는다 ──────────────────────────────────────────────────────
 *
 * 검증한 바이트를 그대로 실행하려면 `data:` URL 로 로드해야 하고, 그러면 드라이버 안의
 * **상대 import 가 안 된다.** 그런데 핀은 원래 **엔트리 파일 하나만** 덮는다 — 상대
 * import 는 핀 밖이었으므로, 그것을 허용하는 것 자체가 무결성 계약의 구멍이었다.
 * 드라이버가 자기완결적이어야 한다는 것을 이제 계약으로 적는다(`drivers/reference.mjs`
 * 가 이미 그렇다).
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DriverLoadError, driverIntegrityOf, loadDriver, type DriverPin } from '../../src/dp/loader.js';

let dir: string;

const GOOD = 'export const apiVersion = 1;\nexport const capabilities = { dnsResolve: true };\n';
const EVIL = 'export const apiVersion = 1;\nexport const capabilities = { pwned: true };\n';

const pinFor = (path: string, bytes: string): DriverPin => ({
  name: 'ref', version: '1.0.0',
  integrity: driverIntegrityOf(Buffer.from(bytes)),
  apiVersion: 1, path,
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bary-driver-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('드라이버 무결성 (검수 S-09)', () => {
  it('검사한 바이트와 실행한 바이트가 같다', async () => {
    // 핀은 GOOD 의 해시인데 디스크에는 EVIL 이 있다 — 읽기와 import 사이에 바뀐 것과
    // 같은 상태다. `import()` 가 경로를 다시 읽으면 EVIL 이 실행된다.
    const path = join(dir, 'swap.mjs');
    writeFileSync(path, EVIL);
    const pin = pinFor(path, GOOD);

    await expect(loadDriver([pin], 'ref')).rejects.toThrow(DriverLoadError);
  });

  it('핀이 맞으면 그 바이트가 로드된다', async () => {
    const path = join(dir, 'ok.mjs');
    writeFileSync(path, GOOD);
    const mod = await loadDriver([pinFor(path, GOOD)], 'ref');
    expect(mod.apiVersion).toBe(1);
    expect((mod['capabilities'] as { dnsResolve?: boolean }).dnsResolve).toBe(true);
  });

  it('로드 뒤 파일이 바뀌어도 이미 읽은 바이트가 정본이다', async () => {
    // 같은 경로를 두 번 로드하면 두 번째는 **그때의 바이트**를 검사한다 —
    // Node 의 모듈 캐시가 옛 결과를 돌려주면 안 된다.
    const path = join(dir, 'twice.mjs');
    writeFileSync(path, GOOD);
    await loadDriver([pinFor(path, GOOD)], 'ref');

    writeFileSync(path, EVIL);
    // 옛 핀으로는 거부된다.
    await expect(loadDriver([pinFor(path, GOOD)], 'ref')).rejects.toThrow(DriverLoadError);
    // 새 핀으로는 **새 바이트**가 온다. 캐시된 옛 모듈이 아니다.
    const mod = await loadDriver([pinFor(path, EVIL)], 'ref');
    expect((mod['capabilities'] as { pwned?: boolean }).pwned).toBe(true);
  });

  it('실제 참조 드라이버가 그대로 로드된다', async () => {
    // 계약을 좁혔으니 저장소가 내놓는 드라이버가 그 계약 안인지 확인한다.
    const path = join(process.cwd(), 'drivers/reference.mjs');
    const bytes = readFileSync(path);
    const mod = await loadDriver([{
      name: 'reference', version: '1.0.0',
      integrity: `sha512:${createHash('sha512').update(bytes).digest('hex')}`,
      apiVersion: 1, path,
    }], 'reference');
    expect(mod.apiVersion).toBe(1);
  });
});
