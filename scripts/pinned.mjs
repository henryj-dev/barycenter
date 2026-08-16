#!/usr/bin/env node
/**
 * **재현물 게이트 — 규칙을 산문에서 기계로 옮긴다** (48차 처방 B)
 *
 * 39차에 "근거를 재는 규칙" 을, 40차에 "검증물은 커밋된 산출물이어야 한다" 를 세웠다.
 * **그런데 46차에 또 어겼다** — 런타임 수정 둘을 재현물 없이 커밋했고, 47차 검수가
 * 그것을 만들어 줬다. 그리고 45차의 계약 핀은 **재발급을 실행하지 않는 픽스처 통과**
 * 였다(48차 CE-48-A).
 *
 * **규칙이 산문이라서 안 지켜진다.** 그래서 게이트로 옮긴다.
 *
 *   node scripts/pinned.mjs <baseRef>
 *
 * `src/` 를 바꾼 커밋은 커밋 메시지에 **재현물 표식**을 적어야 한다:
 *
 *   Pinned-by: tests/conformance/foo.test.ts -t "이름"
 *   Pinned-by: none — <왜 없어도 되는지>
 *
 * 표식이 `none` 이 아니면 **그 테스트를 부모 트리(수정 전)에 대고 돌려 빨간지 확인**한다.
 * 초록이면 그 테스트는 아무것도 안 지키는 것이고, 게이트가 막는다.
 *
 * **이 게이트가 못 잡는 것**: 산문의 정확성("이주는 불가능하다" 같은 전칭 서술).
 * 그건 원래 검수로만 잡히는 축이고, 카운터와 분리한 현행 구조가 맞다 — 48차 판정이다.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();

const base = process.argv[2] ?? 'HEAD~1';
// **sha 로 고정한다.** worktree 안에서 `HEAD` 는 그 worktree 의 HEAD — 즉 **부모**다.
// 문자열 `'HEAD'` 를 넘기면 "지금 테스트를 얹는다" 가 아니라 **부모 테스트를 도로
// 얹는** 것이 되고, 게이트가 정당한 핀을 "안 지킨다" 고 오판한다.
// **게이트 자신의 세 번째 버그다** — 만들면서 둘, 49차가 넷, 그리고 이것.
const head = git('rev-parse', 'HEAD');

const touchedSrc = git('diff', '--name-only', `${base}..${head}`, '--', 'src/').length > 0;
if (!touchedSrc) {
  console.log('src 변경 없음 — 재현물 게이트를 건너뛴다.');
  process.exit(0);
}

const message = git('log', '-1', '--format=%B', head);
const marks = [...message.matchAll(/^Pinned-by:\s*(.+)$/gm)].map((m) => m[1].trim());

if (marks.length === 0) {
  console.error(
    'src 를 바꿨는데 `Pinned-by:` 가 없다.\n\n'
    + '  Pinned-by: tests/conformance/foo.test.ts -t "이름"   재현물이 있다\n'
    + '  Pinned-by: none — <근거>                              없어도 되는 이유를 적는다\n\n'
    + '40차 규칙: **검증물은 커밋된 산출물이어야 한다.** 46차에 그것을 어겼고 47차가\n'
    + '재현물을 대신 만들어 줬다. 규칙이 산문이라 안 지켜졌으므로 게이트로 옮겼다.',
  );
  process.exit(1);
}

/**
 * **본체를 건드리지 않는다** (49차 — 게이트 자신의 결함 넷 중 둘).
 *
 * 첫 판은 `git checkout base -- src/` 로 **작업 트리를 덮었다.** 49차 검수가 실측했다:
 *   · 미커밋 src 수정이 **소리 없이 사라진다** — `verify.sh` 가 기본으로 이걸 돌린다
 *   · 지운 파일이 **작업 트리와 인덱스에 부활**한다 (`checkout head` 는 못 지운다)
 *   · 새 파일이 안 지워져 "부모" 실행이 부모가 아니게 되고, **정당한 커밋을 오차단**한다
 *
 * **13차에 스윕이 정확히 이 사고를 냈다** — 본체를 제자리에서 변이시키다 커밋에 뮤턴트가
 * 섞였고, 그때 배운 것이 *"도구가 본체를 건드리는 한 사고는 반드시 난다"* 였다.
 * **그 교훈을 알면서 같은 모양을 만들었다.** 별도 worktree 로 옮긴다 — 스윕이 그랬듯이.
 */
function makeWorktree(ref) {
  const dir = mkdtempSync(join(tmpdir(), 'barycenter-pinned-'));
  const tree = join(dir, 'tree');
  execFileSync('git', ['worktree', 'add', '--detach', '--quiet', tree, ref], { stdio: 'pipe' });
  symlinkSync(join(process.cwd(), 'node_modules'), join(tree, 'node_modules'), 'dir');
  return { dir, tree };
}

function dropWorktree(w) {
  try {
    execFileSync('git', ['worktree', 'remove', '--force', w.tree], { stdio: 'pipe' });
  } catch {
    // 이미 사라졌으면 그만이다.
  }
  rmSync(w.dir, { recursive: true, force: true });
}

let failed = 0;
for (const mark of marks) {
  if (mark.startsWith('none')) {
    // **근거를 요구한다** (49차 ⓐ). 맨 `none` 도 통과했다 — 문서가 요구하는 형식조차
    // 기계가 안 봤다. 근거의 질은 여전히 사람이 봐야 한다.
    if (!/^none\s+[—-]\s+\S/.test(mark)) {
      console.error(`FAIL  ${mark} — \`none\` 뒤에 근거를 적어라 (\`none — <근거>\`).`);
      failed = 1;
      continue;
    }
    console.log(`건너뜀 — ${mark}`);
    continue;
  }
  const m = /^(\S+)(?:\s+-t\s+"(.+)")?$/.exec(mark);
  const argv = m === null ? [mark] : [m[1], ...(m[2] === undefined ? [] : ['-t', m[2]])];

  // **부모 트리 전체**를 별도 worktree 에 세우고, 지금의 테스트만 얹는다.
  // 파일 삭제·추가도 그대로 반영된다 — `checkout -- src/` 가 못 하던 것이다.
  const w = makeWorktree(base);
  try {
    execFileSync('git', ['checkout', head, '--', 'tests/'], { cwd: w.tree, stdio: 'pipe' });
    let red = false;
    try {
      const out = execFileSync('npx', ['vitest', 'run', ...argv], {
        cwd: w.tree, encoding: 'utf8',
      });
      if (/No test files found|Tests +0 passed/.test(out)) {
        console.error(`FAIL  ${mark} — 고른 테스트가 0 건이다. 표식이 틀렸다.`);
        failed = 1;
        continue;
      }
    } catch (e) {
      const text = `${e.stdout ?? ''}${e.stderr ?? ''}`;
      if (/No test files found|Tests +0 (passed|failed)/.test(text)) {
        console.error(`FAIL  ${mark} — 고른 테스트가 0 건이다. 표식이 틀렸다.`);
        failed = 1;
        continue;
      }
      red = true;
    }
    if (red) {
      console.log(`ok    ${mark} — 수정 전에 빨갛다`);
    } else {
      console.error(`FAIL  ${mark} — **수정 전에도 초록이다. 아무것도 안 지킨다.**`);
      failed = 1;
    }
  } finally {
    dropWorktree(w);
  }
}

// **못 잡는 것을 적어 둔다** (49차 E1·ⓔ). 새 심볼을 만들고 그 심볼만 만지는 테스트를
// 핀으로 걸면 부모에서 **무조건** 빨갛다 — 검출력 0 인 핀이 통과한다. 그리고 표식이
// 그 수정과 무관해도 빨갛기만 하면 통과한다. **기계는 "빨간가" 만 알고 "무엇을 지키는가"
// 는 모른다** — 그 축은 검수가 본다.
process.exit(failed);
