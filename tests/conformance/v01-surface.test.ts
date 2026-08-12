/**
 * v0.1 공개 표면을 못박는다 (DESIGN.md §9.1.1)
 *
 * "동결" 이 문서의 문장으로만 있으면 아무 뜻이 없다. 여섯 번의 검수 동안 "이건 v0.1 에
 * 없다" 고 적어 놓고 코드에는 남아 있는 경우를 여러 번 봤다 — 6차가 그걸 지적했다
 * (`tls_passthrough` · `source_ip_hash` · `applyHealth` 가 "뺐다" 는 문서와 달리 남아 있었다).
 *
 * 그래서 표면을 **값으로** 적어 둔다. 늘어나거나 줄면 여기가 깨지고, 고치려면 이 목록을
 * 의도적으로 손대야 한다. 실수로 새는 것과 정하고 바꾸는 것을 가른다.
 *
 * ⚠️ 이 목록을 고칠 때는 §9.1.1 과 `src/index.ts` 의 주석도 같이 고쳐야 한다.
 */
import { describe, expect, it } from 'vitest';
import * as surface from '../../src/index.js';

/**
 * v0.1 이 내보내는 **런타임 값**. 타입은 런타임에 없으므로 여기 안 나온다 —
 * 타입 표면은 `tsc` 가 지킨다.
 */
const FROZEN_VALUES = [
  // 모델과 렌더러
  'ModelValidationError',
  'decodeModel',
  'parseModel',
  'render',
  'validateModel',
  // DP — 오퍼레이션
  'ALL_APPLY_PHASES',
  'isTerminalPhase',
  'provesActivation',
  // DP — 드라이버
  'LocalDataplaneDriver',
  // DP — 세대
  'GenerationError',
  'digestOfFiles',
  'materializeGeneration',
  'readManifest',
  'verifyGeneration',
  // DP — 부작용과 저장
  'DpRejection',
  'FileStore',
  'FsEffects',
  'ReadOnlyFileStore',
  'StoreCorrupted',
  'StoreLockLost',
  'StoreLocked',
].sort();

describe('v0.1 표면', () => {
  it('내보내는 것이 정확히 목록과 같다', () => {
    const actual = Object.keys(surface).sort();
    expect(actual).toEqual(FROZEN_VALUES);
  });

  it('**뺐다고 적은 것이 표면에 없다** — 문서만 줄이는 것은 축소가 아니다', () => {
    const names = Object.keys(surface).join(' ');
    // §9.1.1 이 v0.1 에서 뺀 것들. 이름이 표면에 새면 사실상 계약이 된다.
    for (const excluded of ['Membership', 'Health', 'Secret', 'Certificate', 'Acme', 'Discovery']) {
      expect(names, `'${excluded}' 계열이 표면에 남아 있다`).not.toContain(excluded);
    }
  });

  it('DP Agent 는 표면이 아니다 — 드라이버 뒤에 있다', () => {
    expect(Object.keys(surface)).not.toContain('DpAgent');
    expect(Object.keys(surface)).not.toContain('ApplyRunner');
  });

  it('테스트용 도구는 표면이 아니다', () => {
    for (const testOnly of ['FakeEffects', 'MemoryStore', 'CrashClock', 'FaultStore']) {
      expect(Object.keys(surface), `${testOnly} 가 공개 표면에 있다`).not.toContain(testOnly);
    }
  });
});

describe('표면이 실제로 쓸 만한가 — 목록만 맞추면 의미가 없다', () => {
  it('모델을 해독해서 렌더까지 간다', () => {
    const parsed = surface.parseModel({
      listeners: [
        { key: 'l', protocol: 'tcp', bind: '0.0.0.0', port: 9000, enabled: true, defaultPool: 'p' },
      ],
      httpRoutes: [],
      passthroughRoutes: [],
      pools: [{ key: 'p', protocolClass: 'tcp', algorithm: 'round_robin' }],
      backends: [{ key: 'b', pool: 'p', host: '10.0.0.1', port: 80, weight: 1 }],
    });
    expect(parsed.ok ? 'ok' : parsed.issues[0]?.message).toBe('ok');
    if (parsed.ok) {
      const rendered = surface.render(parsed.model);
      expect(rendered.conf).toContain('listen 9000');
      expect(rendered.digest).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('단계 목록과 종단 판정이 함께 나온다', () => {
    expect(surface.ALL_APPLY_PHASES).toContain('preflight');
    expect(surface.isTerminalPhase('activated')).toBe(true);
    expect(surface.isTerminalPhase('reload_intent')).toBe(false);
  });

  it('활성화 판정 규칙이 공개돼 있다 — 드라이버 구현자가 같은 규칙을 써야 한다', () => {
    expect(surface.provesActivation({ acceptingGeneration: 'g' }, 'g')).toBe(true);
    expect(surface.provesActivation({ acceptingGeneration: 'g', errorLogGrowth: 1 }, 'g')).toBe(false);
  });
});
