/**
 * **토큰 표를 재시작 없이 갈아 끼운다 · 지역이 자기 판을 말한다** (2026-10-18).
 *
 * 데몬과 엔진이 한 유닛이라 재시작은 데이터 플레인을 몇 초 끊는다. 토큰 철회가 그 비용을
 * 지면 철회가 늦어진다 — SIGHUP 이 `tokens.json` 을 다시 읽는다(`TokenAuth.replace`).
 * 실제 reload 경로(유닛의 `ExecReload` → PID 그대로)는 `tests/install/run.sh` ⑤-b 가 잰다.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { hashToken, TokenAuth } from '../../src/api/auth.js';
import { parseBuildInfo } from '../../src/api/server.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const bearer = (t: string): string => `Bearer ${t}`;

describe('TokenAuth.replace', () => {
  it('**새 토큰이 통하고 지운 토큰은 그 자리에서 죽는다**', () => {
    const auth = new TokenAuth([{ name: 'old', scopes: ['read'], hash: hashToken('old-token') }]);
    expect(auth.authenticate(bearer('old-token'))?.name).toBe('old');

    auth.replace([{ name: 'global', role: 'auditor', hash: hashToken('new-token') }]);
    expect(auth.authenticate(bearer('new-token'))?.name).toBe('global');
    expect(auth.authenticate(bearer('old-token'))).toBeUndefined();
    expect(auth.byName('global')?.role).toBe('auditor');
  });

  it('**해독이 틀리면 던지고 옛 표가 그대로 산다**', () => {
    const auth = new TokenAuth([{ name: 'ops', scopes: ['read', 'write'], hash: hashToken('ops-token') }]);
    expect(() => auth.replace([{ name: 'bad', scopes: ['read'], hash: 'sha256:xyz' }])).toThrow();
    expect(() => auth.replace([])).toThrow();
    expect(auth.authenticate(bearer('ops-token'))?.name).toBe('ops');
  });
});

describe('parseBuildInfo', () => {
  it('설치 스크립트가 쓴 파일을 읽는다', () => {
    expect(parseBuildInfo('commit=c168265\ndescribe=v0.7-12-gc168265\ninstalled_at=2026-10-18T03:00:00Z\n'))
      .toEqual({ commit: 'c168265', describe: 'v0.7-12-gc168265', installedAt: '2026-10-18T03:00:00Z' });
  });

  it('빈 파일·모르는 키뿐이면 null — 모른다는 것이지 판이 없다는 것이 아니다', () => {
    expect(parseBuildInfo('')).toBeNull();
    expect(parseBuildInfo('foo=bar\n')).toBeNull();
  });
});

describe('배선', () => {
  const daemon = readFileSync(join(root, 'src/bin/barycenterd.ts'), 'utf8');
  const install = readFileSync(join(root, 'deploy/install.sh'), 'utf8');

  it('데몬이 SIGHUP 에 죽지 않고 토큰을 다시 읽는다', () => {
    expect(daemon).toMatch(/process\.on\('SIGHUP'/);
    expect(daemon).toContain('auth.replace(loadTokens())');
  });

  it('유닛 둘 다 reload 를 SIGHUP 으로 잇는다 (재시작이 아니다)', () => {
    expect(install).toContain('ExecReload=/bin/kill -HUP \\$MAINPID');
    expect(install).toContain('extra_started_commands="reload"');
    expect(install).toContain('start-stop-daemon --signal HUP');
  });
});
