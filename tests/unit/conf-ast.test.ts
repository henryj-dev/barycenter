/**
 * §4.9 — 렌더러는 문자열 템플릿이 아니라 타입 있는 conf AST 를 만든다.
 * AST 노드 종류 자체가 화이트리스트이고, 이스케이프는 직렬화 단계에서만 일어난다.
 *
 * R2 / R3 — 같은 모델은 항상 같은 바이트를 만든다.
 */
import { describe, expect, it } from 'vitest';
import { block, directive, lit, num, regex, serialize, variable } from '../../src/conf/ast.js';

describe('직렬화', () => {
  it('디렉티브를 렌더한다', () => {
    expect(serialize([directive('worker_processes', [lit('auto')])])).toBe('worker_processes auto;\n');
  });

  it('블록을 들여쓴다', () => {
    const out = serialize([
      block('stream', [], [block('server', [], [directive('listen', [num(999)])])]),
    ]);
    expect(out).toBe('stream {\n    server {\n        listen 999;\n    }\n}\n');
  });

  it('변수는 이스케이프되지 않는다', () => {
    expect(serialize([directive('proxy_pass', [variable('tls_backend')])])).toBe(
      'proxy_pass $tls_backend;\n',
    );
  });

  it('공백·특수문자가 있는 리터럴은 인용한다', () => {
    expect(serialize([directive('return', [num(200), lit('hello world')])])).toBe(
      'return 200 "hello world";\n',
    );
  });

  it('인용부호와 역슬래시를 이스케이프한다', () => {
    expect(serialize([directive('return', [num(200), lit('a"b\\c')])])).toBe(
      'return 200 "a\\"b\\\\c";\n',
    );
  });
});

describe('AST 는 raw 문자열 주입을 허용하지 않는다 — X1', () => {
  it('리터럴에 개행이 들어오면 만들 수 없다', () => {
    expect(() => lit('a\nserver_name evil')).toThrow();
    expect(() => lit('a\r\nb')).toThrow();
  });

  it('리터럴에 NUL 이 들어오면 만들 수 없다', () => {
    expect(() => lit('a\0b')).toThrow();
  });

  it('세미콜론·중괄호가 있어도 인용으로 무해화된다', () => {
    // 값으로서는 합법이다. 인용되어 디렉티브 경계를 깨지 못하는 것이 계약이다.
    expect(serialize([directive('return', [num(200), lit('"; } server { #')])])).toBe(
      'return 200 "\\"; } server { #";\n',
    );
  });

  it('디렉티브 이름은 화이트리스트 문자만 허용한다', () => {
    expect(() => directive('return; }evil', [])).toThrow();
    expect(() => block('http {} evil', [], [])).toThrow();
  });

  it('변수 이름은 화이트리스트 문자만 허용한다', () => {
    expect(() => variable('host; }')).toThrow();
    expect(() => variable('')).toThrow();
  });
});

describe('결정성 — R2 / R3', () => {
  const build = () =>
    block('stream', [], [
      block('upstream', [lit('pool_a')], [
        directive('server', [lit('10.0.0.11:11')]),
        directive('server', [lit('10.0.0.12:11')]),
      ]),
    ]);

  it('같은 AST 는 같은 바이트를 만든다', () => {
    expect(serialize([build()])).toBe(serialize([build()]));
  });

  it('빈 블록도 안정적으로 렌더된다', () => {
    expect(serialize([block('events', [], [])])).toBe('events {\n}\n');
  });
});

describe('정규식 노드 — 인용하지 않으므로 경계를 지켜야 한다 (E37)', () => {
  it('후행 백슬래시를 거부한다 — 뒤의 세미콜론을 이스케이프해 버린다', () => {
    expect(() => regex('~^a\\')).toThrow();
    expect(() => regex('~^abc\\\\\\')).toThrow();
  });

  it('짝수 개의 후행 백슬래시는 허용한다 — 리터럴 백슬래시다', () => {
    expect(() => regex('~^abc\\\\')).not.toThrow();
  });

  it('중간의 이스케이프는 정상이다', () => {
    expect(() => regex('~*^[^.]+\\.example\\.com$')).not.toThrow();
  });
});
