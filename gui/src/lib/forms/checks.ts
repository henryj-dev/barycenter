/**
 * 만들기 폼의 칸 검사 (#126). 입력 바로 아래에 문구를 보이려고 화면에서 먼저 본다.
 *
 * **최종 판정은 서버다.** 여기 규칙은 저장소의 제약과 같은 것만 둔다(키 문법은
 * `012_key_syntax.sql`). 출발지 대역은 `parseSourceAllow` 를 그대로 쓴다 — 두 벌로 두지 않는다.
 * 빈 칸은 오류가 아니다. 비어 있으면 「만들기」 버튼만 잠근다.
 */
import { parseSourceAllow } from '@web/edit';

const KEY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;

export const KEY_HELP = '영문·숫자로 시작하고 영문, 숫자, 점(.), 밑줄(_), 하이픈(-)만 쓸 수 있어요. 63자까지예요. 만든 뒤에는 바꿀 수 없어요.';

/** 시안 `validate` 의 이름 오류. */
export const KEY_ERROR = '이름은 영문·숫자로 시작하고 영문, 숫자, 점(.), 밑줄(_), 하이픈(-)만 쓸 수 있어요. 63자까지예요.';

/** 이름(키). 맞으면 undefined. */
export const keyError = (v: string): string | undefined => {
  const t = v.trim();
  if (t === '' || KEY.test(t)) return undefined;
  return KEY_ERROR;
};

/** 포트 1–65535. 맞으면 undefined. */
export const portError = (v: string | number): string | undefined => {
  const t = String(v).trim();
  if (t === '') return undefined;
  const n = Number(t);
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? undefined : '포트는 1–65535 사이여야 해요.';
};

/** 가중치 — 해독기와 같은 범위(1 부터). nginx 가 `weight=0` 을 거절한다. 트래픽을 멈추는 자리는 드레인이다. */
export const weightError = (v: string): string | undefined => {
  const t = v.trim();
  if (t === '') return undefined;
  const n = Number(t);
  return Number.isInteger(n) && n >= 1 && n <= 1_000_000 ? undefined : '가중치는 1 이상의 정수예요. 트래픽을 끊으려면 드레인을 써요.';
};

/** 칸이 채워졌고 오류가 없는가. */
export const filled = (v: string | number, err?: (v: string) => string | undefined): boolean => {
  const t = String(v).trim();
  return t !== '' && (err === undefined || err(t) === undefined);
};

/** 쉼표 · 공백 · 줄바꿈으로 끊은 목록(호스트 · SNI). */
export const words = (text: string): string[] => text.split(/[\s,]+/).map((s) => s.trim()).filter((s) => s !== '');

/** 출발지 제한 한 줄. `ListInput` 의 `check` 로 쓴다. */
export const sourceAllowLine = (line: string): string | undefined => {
  try {
    parseSourceAllow(line);
    return undefined;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
};

/** 바인드 주소 도움말 — 시안 문구. */
export const bindHelp = (bind: string): string =>
  (bind.trim() === '0.0.0.0' ? '▲ 모든 인터페이스에 열려요. 필요한 주소만 입력해요.' : '이 주소로 들어오는 연결만 받아요.');

// 바인드 선택지는 `src/web/bind.ts` 에 산다 — 서버 테스트도 같은 것을 잰다.
export { CUSTOM_BIND, bindError, bindOptions, type BindFacts } from '@web/bind';

/** 호스트 이름 한 줄(정확 · 맨 앞 `*.` 와일드카드). `ListInput` 의 `check` 로 쓴다. 최종 판정은 서버다. */
const HOST = /^(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
export const hostLine = (line: string): string | undefined =>
  (HOST.test(line.toLowerCase()) ? undefined : '호스트 이름이 아니에요. 예: app.example.com · *.example.com');

/** 리스너 칸 오류 — 시안 `validate('listeners')` 문구 그대로. */
export const LISTENER_ERR = {
  host: '주소를 입력해요.',
  port: '포트는 1–65535 사이여야 해요.',
  src: '잘못된 대역이 있어요. 표시된 행을 고쳐요.',
  proxySrc: 'PROXY protocol과 출발지 제한은 함께 쓸 수 없어요.',
  trusted: '신뢰 대역을 하나 이상 입력해요.',
  number: '숫자만 입력해요.',
} as const;

/** 출발지 제한 도움말 — 시안 `fieldsFor('listeners')` 의 `src` 칸 그대로. */
export const srcHelp = (http: boolean): string =>
  '연결한 상대(바로 앞 홉)를 기준으로 해요. Cloudflare 뒤라면 Cloudflare 집합을 선택해요.'
  + (http ? ' 목록 밖에서 오면 응답 없이 연결을 끊어요.' : '')
  + ' 이 제한은 누가 붙을 수 있나를 정해요. 출발지마다 어디로 보낼지는 라우트의 출발지별 동작에서 정해요.'
  + ' ACME http-01을 받는 :80 리스너에 걸면 인증서 발급이 막혀요.';

/** 시안: :80 리스너에 출발지 제한을 걸면 도움말이 경고 색이다(`warn: v.port === '80' && src.length > 0`). */
export const srcWarn = (port: string, allow: string): boolean => port.trim() === '80' && allow.trim() !== '';
