#!/usr/bin/env node
/**
 * 뮤테이션 스윕 — **손으로 고르지 않는다**
 *
 * 지금까지 뮤테이션을 쓸 때마다 내가 고쳤던 자리를 내가 골라 넣었다. 그러면 **내가
 * 의심한 곳만** 검사한다. 스케줄러를 만든 이유와 같은 문제다 — 교차를 손으로 고르면
 * 내가 상상한 교차만 본다.
 *
 * 여기서는 규칙으로 생성한다. 살아남은 뮤턴트가 곧 **검사되지 않은 행동**이고, 다음
 * 버그가 날 자리다.
 *
 *   node scripts/mutate.mjs [--limit N] [--file src/dp/agent.ts] [--seed N]
 *
 * 규칙은 의도적으로 좁다. 컴파일이 깨지는 변이는 시간만 먹는다 — 타입이 잡는 것은
 * 뮤테이션이 잴 값이 아니다.
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * **본체를 건드리지 않는다.**
 *
 * 처음엔 소스를 제자리에서 변이시키고 `finally` 에서 되돌렸다. 그런데 스윕이 도는 동안
 * 내가 `git add -A` 를 했고, **변이 두 개가 커밋에 섞여 들어갔다.** `finally` 는 그
 * 프로세스만 지키지 옆에서 일어나는 일은 못 막는다.
 *
 * 별도 worktree 에서 돈다. `node_modules` 만 심볼릭 링크로 빌려 쓴다. 이러면 본체는
 * 스윕이 무엇을 하든 그대로다 — 도중에 죽어도, 옆에서 커밋해도.
 */
function makeWorktree() {
  const dir = mkdtempSync(join(tmpdir(), 'barycenter-mutate-'));
  const tree = join(dir, 'tree');
  execFileSync('git', ['worktree', 'add', '--detach', '--quiet', tree, 'HEAD'], { cwd: REPO });
  symlinkSync(join(REPO, 'node_modules'), join(tree, 'node_modules'), 'dir');
  return { dir, tree };
}

function dropWorktree(w) {
  try {
    execFileSync('git', ['worktree', 'remove', '--force', w.tree], { cwd: REPO });
  } catch {
    // 이미 사라졌으면 그만이다.
  }
  rmSync(w.dir, { recursive: true, force: true });
}

const TARGETS = [
  'src/dp/agent.ts',
  'src/dp/apply.ts',
  'src/dp/driver.ts',
  'src/dp/operation.ts',
  'src/dp/materialize.ts',
];

/**
 * 변이 규칙.
 *
 * 각 규칙은 한 줄을 받아 바뀐 줄을 돌려준다(또는 `undefined`). **의미를 뒤집되 타입은
 * 지키는** 것만 넣는다.
 */
const RULES = [
  { name: '조건을 항상 참으로', apply: (l) => {
    const m = /^(\s*)if \((.+)\) \{$/.exec(l);
    if (m === null || m[2] === 'true' || m[2] === 'false') return undefined;
    return `${m[1]}if (true) {`;
  } },
  { name: '조건을 항상 거짓으로', apply: (l) => {
    const m = /^(\s*)if \((.+)\) \{$/.exec(l);
    if (m === null || m[2] === 'true' || m[2] === 'false') return undefined;
    return `${m[1]}if (false) {`;
  } },
  { name: '한 줄 if 를 없앤다', apply: (l) => {
    const m = /^(\s*)if \((.+)\) (return|throw|delete|await) (.+);$/.exec(l);
    if (m === null) return undefined;
    return `${m[1]}void 0;`;
  } },
  { name: '< 를 <= 로', apply: (l) => (l.includes(' < ') ? l.replace(' < ', ' <= ') : undefined) },
  { name: '> 를 >= 로', apply: (l) => (l.includes(' > ') ? l.replace(' > ', ' >= ') : undefined) },
  { name: '=== 를 !== 로', apply: (l) => (l.includes(' === ') ? l.replace(' === ', ' !== ') : undefined) },
  { name: '&& 를 || 로', apply: (l) => (l.includes(' && ') ? l.replace(' && ', ' || ') : undefined) },
  { name: 'delete 를 지운다', apply: (l) => {
    const m = /^(\s*)delete (.+);$/.exec(l);
    return m === null ? undefined : `${m[1]}void ${m[2]};`;
  } },
  { name: 'await 호출을 지운다', apply: (l) => {
    const m = /^(\s*)await (this\.[A-Za-z.#]+\(.*\));$/.exec(l);
    return m === null ? undefined : `${m[1]}void 0;`;
  } },
];

/** 주석·빈 줄·import 는 건드리지 않는다. */
const skippable = (line) => {
  const t = line.trim();
  return t.length === 0
    || t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')
    || t.startsWith('import ') || t.startsWith('export type')
    || t.startsWith('describe(') || t.startsWith('it(');
};

function generate(files) {
  const out = [];
  for (const file of files) {
    const lines = readFileSync(resolve(REPO, file), 'utf8').split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (line === undefined || skippable(line)) continue;
      for (const rule of RULES) {
        const mutated = rule.apply(line);
        if (mutated === undefined || mutated === line) continue;
        out.push({ file, line: i, rule: rule.name, from: line.trim(), to: mutated.trim() });
      }
    }
  }
  return out;
}

/** 시드 고정 셔플 — 어느 부분만 돌려도 재현된다. */
function shuffle(items, seed) {
  let state = seed >>> 0 || 1;
  const rand = () => {
    state ^= state << 13; state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5; state >>>= 0;
    return state / 0x1_0000_0000;
  };
  const a = [...items];
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = argv.indexOf(name);
  return i < 0 ? fallback : argv[i + 1];
};
const limit = Number(opt('--limit', '80'));
const seed = Number(opt('--seed', '20260815'));
const only = opt('--file', undefined);

const files = only === undefined ? TARGETS : [only];
const all = shuffle(generate(files), seed);
const chosen = all.slice(0, limit);

/**
 * **진행을 파일로도 쓴다.** node 는 파이프로 나갈 때 stdout 을 버퍼링해서, 배경으로
 * 돌리면 끝날 때까지 한 줄도 안 보인다. 수십 분짜리 스윕에서 그건 못 쓴다.
 */
const LOG = resolve(REPO, '.omc/mutation-sweep.log');
const say = (line) => {
  console.log(line);
  try {
    appendFileSync(LOG, `${line}\n`);
  } catch {
    // 로그를 못 써도 스윕은 계속한다.
  }
};

writeFileSync(LOG, '');
say(`뮤턴트 ${all.length} 개 생성 · ${chosen.length} 개 실행 (seed ${seed})`);
say('');

const survivors = [];
let killed = 0;
let broken = 0;

const work = makeWorktree();
process.on('exit', () => dropWorktree(work));
process.on('SIGINT', () => process.exit(130));
process.on('SIGTERM', () => process.exit(143));

for (const [n, m] of chosen.entries()) {
  const path = resolve(work.tree, m.file);
  const original = readFileSync(path, 'utf8');
  const lines = original.split('\n');
  lines[m.line] = RULES.find((r) => r.name === m.rule).apply(lines[m.line]);
  writeFileSync(path, lines.join('\n'));
  let verdict;
  try {
    execFileSync('npx', ['vitest', 'run', 'tests/unit', 'tests/conformance', 'tests/model'],
      { cwd: work.tree, stdio: 'pipe', timeout: 300_000 });
    verdict = '살았다';
    survivors.push(m);
  } catch (e) {
    const text = `${e.stdout ?? ''}${e.stderr ?? ''}`;
    // 타입이 깨진 것은 뮤테이션이 아니다 — 세지 않는다.
    verdict = /error TS|SyntaxError|Transform failed/.test(text) ? '컴파일 깨짐' : '죽었다';
    if (verdict === '죽었다') killed += 1;
    else broken += 1;
  } finally {
    writeFileSync(path, original);
  }
  const mark = verdict === '살았다' ? '  ← 살아남았다' : '';
  say(`[${n + 1}/${chosen.length}] ${verdict}  ${m.file}:${m.line + 1} (${m.rule})${mark}`);
  if (verdict === '살았다') say(`        ${m.from}\n     →  ${m.to}`);
}

say('');
say('═══════════════════════════════════════════════════════════════');
say(` 죽었다 ${killed} · 살았다 ${survivors.length} · 컴파일 깨짐 ${broken}`);
const scored = killed + survivors.length;
if (scored > 0) {
  say(` 점수 ${((killed / scored) * 100).toFixed(1)}% — 살아남은 것이 검사되지 않은 행동이다`);
}
if (survivors.length > 0) {
  say('');
  say(' 살아남은 것:');
  for (const s of survivors) {
    say(`   ${s.file}:${s.line + 1}  ${s.rule}`);
    say(`     ${s.from}`);
  }
}
