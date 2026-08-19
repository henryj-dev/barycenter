/**
 * CLI TLS 쓰기 — DESIGN.md §5.6 · §8.1
 *
 * 정책은 minVersion 만. 인증서는 자료 POST 뒤 참조 put. SNI 는 override 없음.
 * apply 는 안 한다.
 */
import { putCertificatePatch, putSniBindingPatch, putTlsPolicyPatch, type TlsVersion } from '../web/edit.js';

import { commitPatch, unwrap, type Http } from './flow.js';

export type TlsPolicyCreateInput = {
  name: string;
  minVersion?: string;
};

export function tlsPolicyCreatePatch(
  input: TlsPolicyCreateInput,
): ReturnType<typeof putTlsPolicyPatch> | undefined {
  if (input.name === '') return undefined;
  if (input.minVersion === undefined) return putTlsPolicyPatch(input.name, {});
  if (input.minVersion !== '1.2' && input.minVersion !== '1.3') return undefined;
  return putTlsPolicyPatch(input.name, { minVersion: input.minVersion as TlsVersion });
}

export async function tlsPolicyCreate(
  http: Http,
  input: TlsPolicyCreateInput,
): Promise<{ revision: string; planId: string }> {
  const patch = tlsPolicyCreatePatch(input);
  if (patch === undefined) throw new Error('TLS 정책은 minVersion 1.2|1.3 만');
  return commitPatch(http, patch);
}

export type CertificateCreateInput = {
  name: string;
  fullchain: string;
  privkey: string;
};

export function certificatePutPatch(
  name: string,
  refs: { materialRef: string; chainDigest: string; keyDigest: string },
): ReturnType<typeof putCertificatePatch> | undefined {
  if (name === '' || refs.materialRef === '' || refs.chainDigest === '' || refs.keyDigest === '') {
    return undefined;
  }
  return putCertificatePatch(name, refs);
}

export async function certificateCreate(
  http: Http,
  input: CertificateCreateInput,
): Promise<{ revision: string; planId: string }> {
  if (input.name === '' || input.fullchain === '' || input.privkey === '') {
    throw new Error('인증서 이름·fullchain·privkey 가 필요하다');
  }
  const uploaded = unwrap(
    await http('POST', '/api/v1/certificates/material', {
      name: input.name,
      fullchain: input.fullchain,
      privkey: input.privkey,
    }),
    'certificate material',
  ) as Record<string, unknown>;
  const materialRef = uploaded['ref'];
  const chainDigest = uploaded['chainDigest'];
  const keyDigest = uploaded['keyDigest'];
  if (typeof materialRef !== 'string' || typeof chainDigest !== 'string' || typeof keyDigest !== 'string') {
    throw new Error('자료 응답에 참조가 없다');
  }
  const patch = certificatePutPatch(input.name, { materialRef, chainDigest, keyDigest });
  if (patch === undefined) throw new Error('인증서 패치를 못 만들었다');
  return commitPatch(http, patch);
}

export type SniBindingCreateInput = {
  name: string;
  listener: string;
  hosts: string;
  certificate: string;
};

export function sniBindingCreatePatch(
  input: SniBindingCreateInput,
): ReturnType<typeof putSniBindingPatch> | undefined {
  const hosts = input.hosts.split(',').map((h) => h.trim()).filter((h) => h !== '');
  if (input.name === '' || input.listener === '' || input.certificate === '' || hosts.length === 0) {
    return undefined;
  }
  return putSniBindingPatch({
    key: input.name,
    listener: input.listener,
    hosts,
    certificate: input.certificate,
  });
}

export async function sniBindingCreate(
  http: Http,
  input: SniBindingCreateInput,
): Promise<{ revision: string; planId: string }> {
  const patch = sniBindingCreatePatch(input);
  if (patch === undefined) throw new Error('SNI 바인딩은 listener·hosts·certificate 가 필요하다');
  return commitPatch(http, patch);
}
