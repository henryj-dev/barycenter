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

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();

const base = process.argv[2] ?? 'HEAD~1';
const head = 'HEAD';

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

let failed = 0;
for (const mark of marks) {
  if (mark.startsWith('none')) {
    console.log(`건너뜀 — ${mark}`);
    continue;
  }
  // 부모 트리로 src 를 되돌리고, 지금의 테스트를 그 위에 돌린다.
  //
  // **인자를 통째로 쪼개면 안 된다.** `-t "따옴표 있는 이름"` 을 `split(/\s+/)` 하면
  // 따옴표가 조각나 vitest 가 **아무 테스트도 안 고르고 초록으로 끝난다** — 게이트가
  // "지키는 게 없다" 고 오판한다. 만들자마자 그 오판을 했고, 손으로 돌려 보고 알았다.
  // **계측기를 만들 때마다 계측기 자신에게 결함이 있었다**(스윕·P8·P10·P11·census).
  const m = /^(\S+)(?:\s+-t\s+"(.+)")?$/.exec(mark);
  const argv = m === null ? [mark] : [m[1], ...(m[2] === undefined ? [] : ['-t', m[2]])];
  try {
    execFileSync('git', ['checkout', base, '--', 'src/'], { stdio: 'pipe' });
    let red = false;
    try {
      const out = execFileSync('npx', ['vitest', 'run', ...argv], { encoding: 'utf8' });
      // **초록이어도 "고른 게 없으면" 초록이 아니다.** 0 건 실행은 실패로 센다.
      if (/No test files found|Tests +0 passed/.test(out)) {
        console.error(`FAIL  ${mark} — 고른 테스트가 0 건이다. 표식이 틀렸다.`);
        failed = 1;
        continue;
      }
    } catch (e) {
      // **던졌다고 다 빨간 것이 아니다.** 없는 파일·오타난 표식도 던진다 — 그걸 "빨갛다"
      // 로 세면 **거짓 표식이 게이트를 통과한다.** 만들자마자 그 구멍을 냈고(두 번째
      // 버그다), 일부러 틀린 표식을 넣어 보고 알았다.
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
    execFileSync('git', ['checkout', head, '--', 'src/'], { stdio: 'pipe' });
  }
}
process.exit(failed);
