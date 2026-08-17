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
  'MEMBERSHIP_DICT',
  'ModelValidationError',
  'decodeModel',
  'parseModel',
  'render',
  'validateModel',
  // DP — 오퍼레이션
  'ALL_APPLY_PHASES',
  'isTerminalPhase',
  'provesActivation',
  'publishedByMe',
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
  'StoreConflict',
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

  /**
   * 7차 검수 ③ — 이름 검사만으로는 못 잡는 것이 있다.
   *
   * `tls_passthrough` 와 `source_ip_hash` 는 **값**이 아니라 문자열 리터럴이라 표면
   * 목록에 안 나온다. 그런데 `parseModel` 이 받아들이면 그건 v0.1 계약이다.
   * 그래서 **해독기가 무엇을 받는지**를 직접 못박는다.
   */
  it('해독기가 받는 프로토콜과 알고리즘이 §9.1.1 과 같다', () => {
    const accepts = (over: Record<string, unknown>): boolean =>
      surface.parseModel({
        listeners: [{ key: 'l', protocol: 'http', bind: '0.0.0.0', port: 80, enabled: true }],
        httpRoutes: [],
        certificates: [], tlsPolicies: [], sniBindings: [],
        passthroughRoutes: [],
        pools: [{ key: 'p', protocolClass: 'tcp', algorithm: 'round_robin', ...over }],
        backends: [{ key: 'b', pool: 'p', host: '10.0.0.1', port: 80, weight: 1 }],
      }).ok;

    // v0.1 에 **있는** 것 — 구현·엔진 테스트·골든이 지킨다 (§9.1.1, 7차 뒤 뒤집은 결정).
    expect(accepts({ algorithm: 'round_robin' })).toBe(true);
    expect(accepts({ algorithm: 'hash', hashKey: 'remote_addr' })).toBe(true);
    expect(accepts({ algorithm: 'source_ip_hash' })).toBe(true);
    // v0.1 에 **없는** 것
    expect(accepts({ algorithm: 'least_conn' }), 'least_conn 은 v0 에 없다').toBe(false);

    const listener = (protocol: string): boolean =>
      surface.parseModel({
        listeners: [{ key: 'l', protocol, bind: '0.0.0.0', port: 443, enabled: true }],
        httpRoutes: [],
        certificates: [], tlsPolicies: [], sniBindings: [],
        passthroughRoutes: [],
        pools: [],
        backends: [],
      }).ok;
    expect(listener('tls_passthrough'), 'tls_passthrough 는 v0.1 에 있다').toBe(true);
    expect(listener('https'), 'https 는 렌더러가 TLS 를 못 내므로 없다').toBe(false);
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

/**
 * **이름만 보면 ④ 같은 결함을 못 잡는다** (7차 검수 ⑤).
 *
 * 목록 검사는 `LocalDataplaneDriver` 가 있다는 것만 확인했다. 그런데 그 생성자가
 * **비공개 타입**을 요구해서 표면만으로는 만들 수 없었다. 이름은 맞고 계약은 깨져 있었다.
 *
 * 그래서 여기서는 **소비자처럼 쓴다.** 루트에서 import 한 것만으로 드라이버를 만들고
 * 저장소를 구현한다. 시그니처가 바뀌면 `tsc` 가 잡는다.
 */
/**
 * 아무것도 하지 않는 부작용. 표면의 타입만으로 만든다.
 *
 * **여기가 11차부터 네 회차 동안 열려 있던 자리다.** 전에는 이 자리에 `async publish() {}`
 * 라고 적어 두고 "strict typecheck 를 통과한다 — lease 를 필수 인자로 만들어도 사용을
 * 강제하지 못한다" 는 사실을 남겨 뒀다. TypeScript 가 인자를 덜 받는 함수를 대입할 수
 * 있게 하기 때문이다.
 *
 * 15차에 닫았다. **인자로는 못 막지만 반환 타입으로는 막을 수 있다** — `assertValid()`
 * 만이 만드는 표(`Checked`)를 돌려주게 하면, 표를 얻으려면 확인을 부를 수밖에 없다.
 * 아래 구현은 그래서 lease 를 받고 부른다. 안 부르면 컴파일이 안 된다.
 */
const NOOP_EFFECTS: surface.Effects = {
  async preflight(): Promise<surface.PreflightResult> {
    return { ok: true };
  },
  async publish(_record, lease) {
    return lease.assertValid();
  },
  async observePublished(): Promise<surface.PublishedState> {
    return { kind: 'none' };
  },
  async signalReload(lease) {
    return lease.assertValid();
  },
  async observeActivation() {
    return undefined;
  },
};

describe('lease 를 건너뛴 구현은 타입이 거부한다 (11차 ⑤ · 15차에 닫았다)', () => {
  /**
   * **이건 런타임 테스트가 아니라 타입 테스트다.** `@ts-expect-error` 가 붙은 줄이
   * 컴파일 오류가 **아니면** `tsc` 가 "쓸데없는 지시자" 라고 실패한다. 즉 이 파일이
   * 타입체크를 통과한다는 것 자체가 "여기는 반드시 오류다" 의 증거다.
   *
   * 11차부터 네 회차 동안 "타입이 강제 못 한다" 고 적어 왔다. 인자로는 못 막는 게 맞다 —
   * TypeScript 는 인자를 덜 받는 함수를 대입할 수 있게 한다. 그런데 **반환 타입으로는
   * 막을 수 있었다.**
   */
  it('lease 를 안 부르면 컴파일되지 않는다', () => {
    const skipsLease = {
      async preflight(): Promise<surface.PreflightResult> {
        return { ok: true };
      },
      // @ts-expect-error — 표를 안 돌려주므로 Effects 가 아니다
      async publish(): Promise<void> {},
      async observePublished(): Promise<surface.PublishedState> {
        return { kind: 'none' };
      },
      // @ts-expect-error — 여기도 마찬가지다
      async signalReload(): Promise<void> {},
      async observeActivation() {
        return undefined;
      },
    } satisfies surface.Effects;
    expect(skipsLease).toBeDefined();
  });

  it('표는 assertValid 에서만 나온다 — 손으로 만들 수 없다', () => {
    // @ts-expect-error — `Checked` 는 unique symbol 로 봉인돼 있다
    const forged: surface.Checked = {};
    expect(forged).toBeDefined();
  });
});

describe('표면만으로 실제로 구현할 수 있는가', () => {
  it('저장소를 갈아 끼울 수 있다 — DurableStore 를 밖에서 구현한다', async () => {
    /** 표면에서 가져온 타입만으로 만든 저장소. */
    class InMemory implements surface.DurableStore {
      private state: surface.StoredState | undefined;
      load(): surface.StoredState | undefined {
        return this.state === undefined ? undefined : structuredClone(this.state);
      }
      async save(next: surface.StoredState): Promise<void> {
        const expected = (this.state?.version ?? 0) + 1;
        // CAS 를 구현하려면 이 오류 타입이 필요하다. 없으면 정확한 저장소를 못 만든다.
        if (next.version !== expected) throw new surface.StoreConflict('버전 충돌');
        this.state = structuredClone(next);
      }
    }

    /** 부작용도 밖에서 구현한다. */
    const effects: surface.Effects = {
      ...NOOP_EFFECTS,
      async observePublished(): Promise<surface.PublishedState> {
        return {
          kind: 'owned',
          record: {
            generation: 'gen-1', leaderToken: '10', operationId: 'o',
            transitionId: 't', generationDigest: 'sha256:g',
          },
        };
      },
      async observeActivation() {
        return { acceptingGeneration: 'gen-1' };
      },
    };

    const driver: surface.DataplaneDriver = surface.LocalDataplaneDriver.create({
      store: new InMemory(),
      effects,
    });

    await driver.fence('10');
    const op: surface.ApplyOperation = {
      leaderToken: '10',
      operationId: 'o',
      transitionId: 't',
      affectedPlanes: ['http', 'stream'],
      targetGeneration: 'gen-1',
      generationDigest: 'sha256:g',
      planes: {
        http: {
          expectedCurrent: { activationEpoch: '0', membershipRevision: '0' },
          target: { activationEpoch: '1', membershipRevision: '1' },
          payloadDigest: 'sha256:h',
        },
        stream: {
          expectedCurrent: { activationEpoch: '0', membershipRevision: '0' },
          target: { activationEpoch: '1', membershipRevision: '1' },
          payloadDigest: 'sha256:s',
        },
      },
    };
    const result: surface.ApplyResult = await driver.applyConfig(op);
    expect(result.phase).toBe('activated');

    // 수렴은 표면의 일부다 — 컨트롤 플레인이 주기적으로 불러야 한다.
    const reconciled: surface.ReconcileResult = await driver.reconcileConfig();
    expect(reconciled.kind).toBe('converged');

    const status: surface.DriverStatus = await driver.status();
    expect(status.planes.http.activationEpoch).toBe('1');
    expect(status.published.kind).toBe('owned');
    expect(status.maxLeaderToken).toBe('10');
  });

  it('거부를 분류할 수 있다 — 오류 타입이 공개돼 있어야 한다', async () => {
    let saved: surface.StoredState | undefined;
    const driver = surface.LocalDataplaneDriver.create({
      store: {
        load: () => saved,
        save: async (s) => {
          saved = s;
        },
      },
      effects: NOOP_EFFECTS,
    });

    await driver.fence('20');
    try {
      await driver.fence('10');
      expect.unreachable('낮은 토큰이 통과했다');
    } catch (e) {
      expect(e).toBeInstanceOf(surface.DpRejection);
      const kind: surface.RejectionKind = (e as surface.DpRejection).kind;
      expect(kind).toBe('stale_leader');
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
      certificates: [], tlsPolicies: [], sniBindings: [],
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

// ── 저장소가 정말 불투명한가 (9차 반례 ④) ──────────────────────────────

describe('불투명 저장소 — 내용을 모르는 구현이 실제로 돈다', () => {
  /**
   * 9차 검수 ④: "불투명" 이라 적어 놓고 실제로는 `AgentState` 의 모양을 요구했다.
   * `{version}` 만 보관하는 정직한 구현이 두 번째 쓰기에서 TypeError 를 냈다.
   *
   * 그래서 **내용을 문자열로 직렬화해 보관하는** 저장소로 시험한다. 모양을 안다면
   * 이렇게 만들 수 없다.
   */
  it('payload 를 문자열로 말아 두는 저장소로도 전체가 돈다', async () => {
    let blob: string | undefined;
    let version = 0;

    const store: surface.DurableStore = {
      load() {
        return blob === undefined ? undefined : { version, payload: JSON.parse(blob) };
      },
      async save(next) {
        if (next.version !== version + 1) throw new surface.StoreConflict('버전 충돌');
        // **해석하지 않는다.** 통째로 문자열이 된다.
        blob = JSON.stringify(next.payload);
        version = next.version;
      },
    };

    const driver = surface.LocalDataplaneDriver.create({
      store,
      effects: {
        ...NOOP_EFFECTS,
        async observePublished(): Promise<surface.PublishedState> {
          return published;
        },
        async publish(record, lease) {
          const checked = lease.assertValid();
          published = { kind: 'owned', record };
          return checked;
        },
        async observeActivation() {
          return { acceptingGeneration: 'gen-1' };
        },
      },
    });
    let published: surface.PublishedState = { kind: 'none' };

    await driver.fence('10');
    const result = await driver.applyConfig({
      leaderToken: '10',
      operationId: 'o',
      transitionId: 't',
      affectedPlanes: ['http', 'stream'],
      targetGeneration: 'gen-1',
      generationDigest: 'sha256:g',
      planes: {
        http: {
          expectedCurrent: { activationEpoch: '0', membershipRevision: '0' },
          target: { activationEpoch: '1', membershipRevision: '1' },
          payloadDigest: 'sha256:h',
        },
        stream: {
          expectedCurrent: { activationEpoch: '0', membershipRevision: '0' },
          target: { activationEpoch: '1', membershipRevision: '1' },
          payloadDigest: 'sha256:s',
        },
      },
    });

    expect(result.phase).toBe('activated');
    expect((await driver.status()).planes.http.activationEpoch).toBe('1');
    // 저장소는 끝까지 내용을 몰랐다.
    expect(typeof blob).toBe('string');
    expect(version).toBeGreaterThan(1);
  });
});
