/**
 * `deploy/install.sh` — 검수 2026-08-29(2)
 *
 * §11.3 의 v1 권장 배포 경로다. `tests/install/run.sh` 가 실물 컨테이너에서 "서비스가
 * 서는가" 를 재지만, **거기서 안 드러나는 것들**이 있다:
 *
 *   · 전환 창(파일이 잠깐 넓게 열리는 것) — 도는 결과만 보면 안 보인다
 *   · systemd 가 **모르는 키를 조용히 무시**하는 것 — 유닛은 뜨고 서비스도 산다
 *   · 오류 경로 — 성공 경로만 재는 하네스는 지나간다
 *
 * 그래서 여기서는 **스크립트의 텍스트와 오류 경로**를 잰다.
 *
 * ⚠️ **이 파일이 못 재는 것**을 적어 둔다: 파일 모드의 전환 창은 경합이라 밖에서
 * 결정적으로 못 만든다. 여기서 재는 것은 *"넓게 만들 수 없는 형태로 쓰는가"* 이지
 * *"창이 없다"* 가 아니다. systemd 키가 실제로 무시된다는 것은 `systemd-analyze verify`
 * 로 실측했고 그 기록은 `docs/audit-2026-08-29-install.md` 에 있다.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = join(root, 'deploy', 'install.sh');
const src = readFileSync(SCRIPT, 'utf8');

/** heredoc 안의 유닛 본문을 섹션별로 가른다. */
function unitSections(unit: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  let section = '';
  for (const line of unit.split('\n')) {
    const m = /^\[([A-Za-z]+)\]$/.exec(line.trim());
    if (m !== null) { section = m[1]!; out[section] ??= []; continue; }
    if (section !== '' && line.trim() !== '') out[section]!.push(line.trim());
  }
  return out;
}

/** `write_systemd_unit` 이 내는 유닛 본문. */
function systemdUnit(): string {
  const at = src.indexOf('write_systemd_unit()');
  expect(at).toBeGreaterThan(-1);
  const body = src.slice(at);
  const start = body.indexOf('<<EOF');
  const end = body.indexOf('\nEOF', start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return body.slice(start + '<<EOF'.length, end);
}

describe('systemd 유닛', () => {
  /**
   * **A.** `StartLimitIntervalSec` 은 `[Unit]` 옵션이다. `[Service]` 에 두면 systemd 가
   * *"Unknown key ... ignoring"* 으로 **조용히 버린다** — `systemd-analyze verify` 로
   * 실측했다. 그러면 주석이 막았다고 적은 실패(PG 가 늦게 뜨는 부팅에서 다섯 번 만에
   * 포기하고 `failed` 로 남는 것 — *"트래픽은 흐르는데 제어가 없는 그 상태"*)가 그대로
   * 산다. **유닛은 뜨고 서비스도 살기 때문에 설치 하네스가 못 잡는다.**
   */
  it('**재시도 상한 해제가 `[Unit]` 에 있다** — `[Service]` 에 두면 systemd 가 버린다', () => {
    const sections = unitSections(systemdUnit());
    const has = (s: string, key: string): boolean =>
      (sections[s] ?? []).some((l) => l.startsWith(`${key}=`));

    expect(has('Unit', 'StartLimitIntervalSec')).toBe(true);
    expect(has('Service', 'StartLimitIntervalSec')).toBe(false);
  });

  it('`Restart` 는 그대로 `[Service]` 에 있다 — 옮긴 것은 상한뿐이다', () => {
    const sections = unitSections(systemdUnit());
    expect((sections['Service'] ?? []).some((l) => l.startsWith('Restart='))).toBe(true);
    expect((sections['Service'] ?? []).some((l) => l.startsWith('RestartSec='))).toBe(true);
  });
});

describe('비밀 파일', () => {
  /**
   * **B.** `> "$FILE"` 은 **umask 로 만들어진다.** sudo 의 기본 umask 022 면 0644 이고,
   * `$PREFIX` 가 0755 라 그 순간 아무나 읽는다 — 뒤따르는 `chmod 0640` 은 **이미 열린
   * 뒤**다. 안에 든 것은 DSN(비밀번호가 든다)과 토큰 해시이고, `pg` 시크릿 백엔드를
   * 쓰면 `BARY_SECRET_KEK` 까지 들어간다.
   *
   * 창 자체는 경합이라 밖에서 결정적으로 못 만든다. 그래서 **좁은 umask 안에서 쓰는가**
   * 를 잰다 — 창을 못 만들게 하는 형태다.
   */
  it('**좁은 umask 안에서 쓴다** — chmod 는 이미 열린 뒤다', () => {
    for (const file of ['TOKENS_FILE', 'ENV_FILE']) {
      const at = src.indexOf(`> "$${file}"`);
      expect(at, `${file} 을 쓰는 자리가 있어야 한다`).toBeGreaterThan(-1);

      // **거리로 재지 않는다.** `ENV_FILE` 쓰기는 `env_line` 여러 줄 뒤에 오므로
      // "앞 N 자" 는 블록 길이에 딸린 값이 된다 — 줄이 하나 늘면 조용히 통과하거나
      // 조용히 깨진다. 대신 **서브셸이 아직 안 닫혔는지**를 본다.
      const before = src.slice(0, at);
      const opened = before.lastIndexOf('(umask 0');
      expect(opened, `${file} 쓰기 앞에 좁은 umask 서브셸이 있어야 한다`).toBeGreaterThan(-1);
      // 그 뒤로 서브셸을 닫는 줄이 있으면 이 쓰기는 그 밖이다.
      expect(before.slice(opened), `${file} 쓰기가 그 서브셸 안에 있어야 한다`)
        .not.toMatch(/^\)/m);
    }
  });
});

describe('오류 경로', () => {
  /**
   * **C.** `env_line` 의 거절 메세지가 `$ENV_FILE` 을 넣는데, 이 함수는 **인자 파싱
   * 중에** `extra_env_add` 를 거쳐 불린다 — 그때 `ENV_FILE` 은 아직 없다. `set -u` 라
   * 안내 대신 **셸 오류**가 난다. 가드의 오류 경로 자체가 깨져 있는 것이다.
   */
  it('**작은따옴표를 안내로 거절한다** — unbound variable 이 아니라', () => {
    let out = '';
    try {
      execFileSync('sh', [SCRIPT, '--env', "BARY_X=a'b"], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      const err = e as { stdout?: string; stderr?: string };
      out = `${err.stdout ?? ''}${err.stderr ?? ''}`;
    }
    expect(out).not.toMatch(/unbound variable/);
    expect(out).toMatch(/작은따옴표/);
  });
});

/**
 * 스크립트에서 셸 함수 **본문을 그대로** 꺼낸다.
 *
 * 재구현하지 않는 것이 요점이다 — 규칙을 테스트가 다시 적으면 그 사본이 원본과
 * 갈라지는 날 테스트는 초록인 채로 아무것도 안 지킨다.
 */
function shFunction(name: string): string {
  const at = src.indexOf(`${name}() {`);
  expect(at).toBeGreaterThan(-1);
  const end = src.indexOf('\n}\n', at);
  expect(end).toBeGreaterThan(at);
  return src.slice(at, end + 3);
}

/** `MANAGED_ENV_KEYS` 의 값 — 정규화까지 지난 것을 스크립트에서 그대로 얻는다. */
function managedKeys(): string[] {
  const out = execFileSync('sh', ['-c',
    `${src.slice(src.indexOf('MANAGED_ENV_KEYS="'), src.indexOf('\nREPO='))}\nprintf '%s' "$MANAGED_ENV_KEYS"`,
  ], { encoding: 'utf8' });
  return out.trim().split(/\s+/).filter((k) => k !== '');
}

describe('관리 키 가드', () => {
  /**
   * **F.** 대조가 `case " $MANAGED_ENV_KEYS " in *" $k "*` 라 구분자가 공백인데,
   * 목록이 **두 줄**이었다. 줄바꿈에 닿는 두 키(`BARY_ENGINE_BIN`·`BARY_GUI`)는 앞이나
   * 뒤가 공백이 아니라 패턴에 안 걸렸고, `--env BARY_GUI=...` 가 그대로 통과했다 —
   * env 파일에 같은 키가 두 줄 들어가는 것, 이 가드가 막으려던 바로 그 상태다.
   *
   * **목록을 여기 베껴 적지 않는다.** 스크립트에서 읽어 전수로 돈다 — 키가 늘어
   * 줄이 또 갈리는 날 이 테스트가 그것까지 잡아야 한다.
   */
  it('**관리 키를 하나도 빠짐없이 거절한다** — 목록의 줄바꿈에 닿는 것까지', () => {
    const keys = managedKeys();
    expect(keys.length).toBeGreaterThan(5);
    for (const key of keys) {
      let out = '';
      try {
        execFileSync('sh', [SCRIPT, '--env', `${key}=x`, '--dsn', 'postgres://a'], {
          encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (e) {
        const err = e as { stdout?: string; stderr?: string };
        out = `${err.stdout ?? ''}${err.stderr ?? ''}`;
      }
      expect(out, `${key} 가 --env 로 통과했다`).toMatch(/이 스크립트가 정하는 값이다/);
    }
  });
});

describe('재실행 = 업데이트', () => {
  /** `carry_env_lines` 를 스크립트에서 꺼내 실제로 돌린다. */
  function carry(file: string, extraKeys = ''): string[] {
    const out = execFileSync('sh', ['-c',
      `${src.slice(src.indexOf('MANAGED_ENV_KEYS="'), src.indexOf('\nREPO='))}
       EXTRA_ENV_KEYS='${extraKeys}'
       ${shFunction('carry_env_lines')}
       carry_env_lines "$1"`,
      'sh', file,
    ], { encoding: 'utf8' });
    return out.split('\n').filter((l) => l !== '');
  }

  /**
   * **base64 처럼 생긴 값을 안 쓴다.** 진짜 KEK 은 32 바이트 base64 인데, 그 모양을
   * 픽스처에 두면 gitleaks 의 `generic-api-key` 가 문다 — 실제로 물렸다(#33). 예외를
   * 다는 쪽은 나쁘다: 넓게 뚫어 둔 예외가 나중에 진짜를 삼킨다(`.gitleaks.toml` 머리말).
   *
   * 그리고 여기서 재는 것은 **줄이 옮겨지는가**이지 그 값이 열쇠로 쓸모 있는가가
   * 아니다 — `carry_env_lines` 는 값을 안 본다. 읽는 사람에게 "이건 열쇠가 아니다" 가
   * 한눈에 보이는 쪽이 낫다.
   */
  const KEK_LINE = "BARY_SECRET_KEK='이것은-열쇠가-아니라-옮겨지는지-보는-줄'";

  const ENV_SAMPLE = [
    "BARY_DSN='postgres:///bary'",
    "BARY_GUI='/opt/barycenter/gui/build'",
    KEK_LINE,
    "BARY_PROBE_INTERVAL_MS='3000'",
    '# 손으로 적은 주석',
    '',
    'NOT_BARY=1',
  ].join('\n');

  /**
   * **예측 가능한 임시 파일 이름을 안 쓴다** (CodeQL `js/insecure-temporary-file`).
   *
   * `join(tmpdir(), name)` 은 공용 디렉터리의 **미리 알 수 있는 경로**다. 그 이름으로
   * 심링크를 먼저 걸어 두면 이 테스트의 쓰기가 남의 파일로 간다. `mkdtempSync` 는
   * 0700 디렉터리를 원자적으로 만들어 그 창을 없앤다 — `scripts/surface.mjs` 가 이미
   * 같은 이유로 그것을 쓴다.
   *
   * 테스트라고 예외를 두지 않는 이유: 이 저장소의 CI 에서 도는 코드이고, 여기서
   * 봐준 습관이 프로덕션 코드로 옮겨 간다.
   */
  function withEnvFile(body: (file: string) => void): void {
    const dir = mkdtempSync(join(tmpdir(), 'bary-env-'));
    try {
      const file = join(dir, 'env');
      writeFileSync(file, ENV_SAMPLE);
      body(file);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }

  /**
   * **G.** 이 한 줄이 이번 회차의 이유다. `BARY_SECRET_KEK` 은 `pg` 시크릿 백엔드의
   * KEK 이고, **잃으면 자료를 영영 못 연다** (STATUS §2). 재실행이 곧 업데이트 경로인데
   * 예전에는 env 파일을 통째로 다시 써서, `--env` 를 다시 안 주면 KEK 이 조용히
   * 사라졌다 — 그리고 그 사실은 인증서를 읽으려는 순간에야 드러난다.
   */
  it('**KEK 을 이어 간다** — 잃으면 자료를 영영 못 연다', () => {
    withEnvFile((f) => {
      expect(carry(f)).toContain(KEK_LINE);
    });
  });

  /** 관리 키는 스크립트가 다시 정한다 — 옛 값이 이기면 두 줄이 되거나 옛것이 산다. */
  it('관리 키는 안 이어 간다 — 그쪽은 스크립트가 정본이다', () => {
    withEnvFile((f) => {
      const kept = carry(f);
      expect(kept.some((l) => l.startsWith('BARY_DSN='))).toBe(false);
      expect(kept.some((l) => l.startsWith('BARY_GUI='))).toBe(false);
    });
  });

  /** 이번에 `--env` 로 다시 준 키는 새 값이 이긴다 — **두 줄이 되면 안 된다.** */
  it('이번에 다시 준 키는 안 이어 간다 — 같은 키가 두 줄이 되면 안 된다', () => {
    withEnvFile((f) => {
      const kept = carry(f, 'BARY_PROBE_INTERVAL_MS');
      expect(kept.some((l) => l.startsWith('BARY_PROBE_INTERVAL_MS='))).toBe(false);
      expect(kept).toContain(KEK_LINE);
    });
  });

  /** 주석·빈 줄·`BARY_` 가 아닌 것은 안 옮긴다 — 모르는 모양을 나르지 않는다. */
  it('주석과 모르는 모양은 안 옮긴다', () => {
    withEnvFile((f) => {
      const kept = carry(f);
      expect(kept.some((l) => l.startsWith('#'))).toBe(false);
      expect(kept.some((l) => l.startsWith('NOT_BARY'))).toBe(false);
    });
  });

  /**
   * **H.** 뒤집는 문이 실제로 있는가. 없으면 "이어 간다" 는 결정이 아니라 강요가 된다 —
   * 옛 키를 지우려는 운영자에게 남는 길이 파일을 손으로 고치는 것뿐이게 된다.
   */
  it('`--reset-env` 와 `--rotate-token` 이 사용법과 파서 양쪽에 있다', () => {
    for (const flag of ['--reset-env', '--rotate-token']) {
      expect(src, `${flag} 가 사용법에 없다`).toContain(`  ${flag}`);
      expect(src, `${flag} 를 파서가 모른다`).toMatch(
        new RegExp(`\\n\\s*${flag}\\)\\s+\\w+=1;`));
    }
  });
});
