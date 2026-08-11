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
  | { kind: 'entry'; key: ConfValue; value: ConfValue };

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

export function serialize(nodes: ConfNode[], depth = 0): string {
  const pad = INDENT.repeat(depth);
  let out = '';
  for (const node of nodes) {
    if (node.kind === 'entry') {
      out += `${pad}${renderValue(node.key)} ${renderValue(node.value)};\n`;
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
