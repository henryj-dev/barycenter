import type { Role } from './api';

/** 계정 화면들이 같이 쓰는 문구 — 같은 규칙을 화면마다 다르게 말하지 않게. 규칙 자체는 서버가 진다. */
/** 시안의 역할 이름(관리자 · 운영자 · 보기). 서버 값(admin · operator · auditor)은 바꾸지 않는다. */
export const ROLE_LABEL: Readonly<Record<Role, string>> = { admin: '관리자', operator: '운영자', auditor: '보기' };

export const PASSWORD_HELP = '8자 이상, 영소문자 · 영대문자 · 숫자 · 특수문자 중 3종류를 써요.';
