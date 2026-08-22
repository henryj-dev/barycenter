/** 검증 결과. 예외가 아니라 값으로 다룬다 — 저장 경로에서 오류를 모아 보고해야 하기 때문. */
export type Ok<T> = { ok: true; value: T };
export type Err = { ok: false; code: ErrCode; message: string };
export type Result<T> = Ok<T> | Err;

export type ErrCode =
  | 'invalid_host'
  | 'invalid_host_pattern'
  | 'invalid_header_name'
  | 'invalid_header_value'
  | 'invalid_hash_key'
  | 'invalid_bind_address'
  | 'invalid_path_prefix';

export const ok = <T>(value: T): Ok<T> => ({ ok: true, value });
export const err = (code: ErrCode, message: string): Err => ({ ok: false, code, message });
