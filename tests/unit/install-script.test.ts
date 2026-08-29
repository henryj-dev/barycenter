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
import { readFileSync } from 'node:fs';
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
