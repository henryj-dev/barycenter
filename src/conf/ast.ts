/**
 * 타입 있는 conf AST — DESIGN.md §4.9
 *
 * 렌더러는 문자열 템플릿을 쓰지 않는다. **AST 노드 종류 자체가 화이트리스트**이고,
 * 이스케이프는 직렬화 한 곳에서만 일어난다. `raw` 노드는 없다 — 있으면 계약이 무너진다.
 */

export type ConfValue =
  | { kind: 'literal'; text: string }
  | { kind: 'number'; value: number }
  | { kind: 'variable'; name: string }
  | { kind: 'regex'; pattern: string };

export type ConfNode =
  | { kind: 'directive'; name: string; args: ConfValue[] }
  | { kind: 'block'; name: string; args: ConfValue[]; children: ConfNode[] }
  /** `map` 블록 안의 "키 값;" — 디렉티브 이름 자리에 사용자 값이 온다. */
  | { kind: 'entry'; key: ConfValue; value: ConfValue }
  /**
   * `*_by_lua_block { ... }` — 본문이 **nginx 값이 아니라 Lua 코드**다.
   *
   * `directive` 로는 못 낸다(세미콜론이 붙는다). `lit` 으로도 못 낸다(개행이 제어
   * 문자로 거부된다 — 그리고 그 거부는 옳다). 그래서 별도 종류로 둔다.
   *
   * **사용자 입력이 여기 들어오면 안 된다.** 본문은 렌더러가 쓴 상수여야 한다 —
   * 값이 아니라 코드라서 인용으로 무해화할 방법이 없다. `lua()` 가 그걸 강제한다.
   */
  | { kind: 'lua'; name: string; body: string };

const DIRECTIVE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const CONTROL = /[\u0000-\u001F\u007F]/;

/** 인용 없이 낼 수 있는 값인가. 인용이 필요한 문자가 하나라도 있으면 인용한다. */
const NEEDS_QUOTE = /[\s;{}"'#\\]/;

/**
 * 리터럴 값. 제어 문자는 **만들 수조차 없다** — 이스케이프로 무해화되지 않는 유일한 부류다.
 * 세미콜론·중괄호는 값으로서 합법이고, 직렬화가 인용해 디렉티브 경계를 깨지 못하게 만든다.
 */
export function lit(text: string): ConfValue {
  if (CONTROL.test(text)) {
    throw new Error(`conf 리터럴에 제어 문자를 쓸 수 없다: ${JSON.stringify(text)}`);
  }
  return { kind: 'literal', text };
}

export function num(value: number): ConfValue {
  if (!Number.isFinite(value)) throw new Error(`유한한 수가 아니다: ${value}`);
  return { kind: 'number', value };
}

export function variable(name: string): ConfValue {
  if (!VARIABLE_NAME.test(name)) throw new Error(`변수 이름이 아니다: ${JSON.stringify(name)}`);
  return { kind: 'variable', name };
}

/**
 * 정규식 값 (map 엔트리 등).
 *
 * 리터럴과 분리한 이유: 인용된 문자열 안에서 nginx 는 역슬래시를 이스케이프로 해석하므로
 * `"~*^.+\.example\.com$"` 의 `\.` 가 `.` 로 풀려 **임의 문자 매칭**이 된다. 정규식은
 * 인용하지 않고 그대로 낸다. 대신 conf 경계를 깰 수 있는 문자를 아예 금지한다.
 */
export function regex(pattern: string): ConfValue {
  if (CONTROL.test(pattern) || /[\s;{}"'#]/.test(pattern)) {
    throw new Error(`정규식에 쓸 수 없는 문자가 있다: ${JSON.stringify(pattern)}`);
  }
  // 인용하지 않으므로 후행 백슬래시가 **뒤의 세미콜론을 이스케이프한다.**
  // E37 로 확인: `~^a\ v;` 는 `invalid number of the map parameters` 로 거부된다.
  const trailing = /(\\*)$/.exec(pattern)![1]!.length;
  if (trailing % 2 === 1) {
    throw new Error(`정규식이 홀수 개의 백슬래시로 끝난다 — 구분자를 삼킨다: ${JSON.stringify(pattern)}`);
  }
  return { kind: 'regex', pattern };
}

export function directive(name: string, args: ConfValue[]): ConfNode {
  if (!DIRECTIVE_NAME.test(name)) throw new Error(`디렉티브 이름이 아니다: ${JSON.stringify(name)}`);
  return { kind: 'directive', name, args };
}

export function block(name: string, args: ConfValue[], children: ConfNode[]): ConfNode {
  if (!DIRECTIVE_NAME.test(name)) throw new Error(`블록 이름이 아니다: ${JSON.stringify(name)}`);
  return { kind: 'block', name, args, children };
}

/**
 * `map` 블록의 엔트리. 키가 디렉티브 이름 자리에 오지만, 키도 값도 전부 타입 있는
 * ConfValue 라서 인용·이스케이프 규칙이 똑같이 적용된다.
 */
export function entry(key: ConfValue, value: ConfValue): ConfNode {
  return { kind: 'entry', key, value };
}

function renderValue(v: ConfValue): string {
  switch (v.kind) {
    case 'number':
      return String(v.value);
    case 'variable':
      return `$${v.name}`;
    case 'regex':
      return v.pattern;
    case 'literal': {
      if (v.text.length > 0 && !NEEDS_QUOTE.test(v.text)) return v.text;
      return `"${v.text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
    }
  }
}

const INDENT = '    ';

/**
 * Lua 블록. **본문은 렌더러가 쓴 상수만** 받는다.
 *
 * 인용으로 무해화할 수 없는 자리라, 값이 흘러들 수 있는 경로를 아예 막는다 — 균형이
 * 안 맞는 중괄호는 nginx 의 블록 파싱을 깨뜨리므로 거기서 거른다.
 */
export function lua(name: string, body: string): ConfNode {
  if (!DIRECTIVE_NAME.test(name)) throw new Error(`블록 이름이 아니다: ${JSON.stringify(name)}`);
  let depth = 0;
  for (const ch of body) {
    if (ch === '{') depth += 1;
    else if (ch === '}') depth -= 1;
    if (depth < 0) break;
  }
  if (depth !== 0) {
    throw new Error(`Lua 블록의 중괄호가 안 맞는다 (${name}) — nginx 의 블록 파싱이 깨진다`);
  }
  return { kind: 'lua', name, body };
}

export function serialize(nodes: ConfNode[], depth = 0): string {
  const pad = INDENT.repeat(depth);
  let out = '';
  for (const node of nodes) {
    if (node.kind === 'entry') {
      out += `${pad}${renderValue(node.key)} ${renderValue(node.value)};\n`;
      continue;
    }
    if (node.kind === 'lua') {
      // 본문의 상대 들여쓰기는 유지하고 블록 깊이만 더한다.
      const lines = node.body.replace(/^\n+|\s+$/g, '').split('\n');
      const strip = Math.min(...lines.filter((l) => l.trim() !== '')
        .map((l) => l.length - l.trimStart().length));
      out += `${pad}${node.name} {\n`;
      for (const line of lines) {
        out += line.trim() === '' ? '\n' : `${pad}${INDENT}${line.slice(strip)}\n`;
      }
      out += `${pad}}\n`;
      continue;
    }
    const head = [node.name, ...node.args.map(renderValue)].join(' ');
    if (node.kind === 'directive') {
      out += `${pad}${head};\n`;
    } else {
      out += `${pad}${head} {\n`;
      out += serialize(node.children, depth + 1);
      out += `${pad}}\n`;
    }
  }
  return out;
}
