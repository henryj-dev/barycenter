import type { Role } from './api';

/** 계정 화면들이 같이 쓰는 문구 — 같은 규칙을 화면마다 다르게 말하지 않게. 규칙 자체는 서버가 진다. */
/** 시안의 역할 이름(관리자 · 운영자 · 보기). 서버 값(admin · operator · auditor)은 바꾸지 않는다. */
export const ROLE_LABEL: Readonly<Record<Role, string>> = { admin: '관리자', operator: '운영자', auditor: '보기' };

export const PASSWORD_HELP = '8자 이상, 영소문자 · 영대문자 · 숫자 · 특수문자 중 3종류를 써요.';

/** 토큰 역할이 여는 범위 — 시안의 「범위」 칸(read · write · apply)을 우리 역할로 읽는다. 서버의 역할 → 스코프 표와 같다. */
export const ROLE_SCOPES: Readonly<Record<Role, string>> = { auditor: 'read', operator: 'read · write', admin: 'read · write · apply · admin' };

/** 토큰 이름 규칙 — 서버(`TOKEN_NAME`)와 같다. 화면은 미리 알리기만 하고 판정은 서버가 진다. */
export const TOKEN_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;
export const TOKEN_NAME_HELP = '이름은 영문·숫자로 시작하고 영문, 숫자, 점(.), 밑줄(_), 하이픈(-)만 쓸 수 있어요. 63자까지예요.';
