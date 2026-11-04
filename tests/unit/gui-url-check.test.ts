/**
 * GUI 대상 URL 칸의 확인 (#126 3단계, `gui/src/lib/forms/url-check.ts`).
 *
 * 화면은 해요체로 먼저 말한다. 그 판정은 patch 빌더(`proxyFromUrlPatch`)와 같아야 한다 — 화면이 「괜찮아요」 하고
 * 빌더가 거절하면 해라체 오류가 나오거나 저장이 안 된다. 그래서 같은 입력을 빌더에도 넣어 받는다 · 거절한다가 같은지 본다.
 */
import { describe, expect, it } from 'vitest';

import { urlCheck } from '../../gui/src/lib/forms/url-check.js';
import { proxyFromUrlPatch } from '../../src/web/edit.js';

const builds = (url: string): boolean => {
  try { proxyFromUrlPatch({ name: 'p', url, listener: 'web', hosts: ['a.test'] }); return true; } catch { return false; }
};

describe('urlCheck', () => {
  it.each([
    ['', /https:\/\/로 시작하는 URL을 입력해요/],
    ['ftp://x.test/', /http:\/\/ 또는 https:\/\/로 시작해요/],
    ['https://u:p@x.test/', /사용자 정보/],
    ['https://x.test/?a=1', /\?를 넣지 않아요/],
    ['https://x.test/#a', /#를 넣지 않아요/],
    ['https://x.test:70000/', /URL 형식이 아니에요/],
  ])('%j 는 해요체로 거절한다', (url, msg) => {
    expect(urlCheck(url)).toMatch(msg);
    expect(urlCheck(url)).toMatch(/요\./);
  });

  it.each(['https://api.example.com/', 'http://10.0.0.5:8080/', 'https://[::1]:8443/', 'HTTPS://X.test/'])('%s 는 받는다', (url) => {
    expect(urlCheck(url)).toBeUndefined();
  });

  it.each(['', 'ftp://x.test/', 'https://u:p@x.test/', 'https://x.test/?a=1', 'https://x.test/#a', 'https://x.test:70000/',
    'not a url', 'https://api.example.com/', 'http://10.0.0.5:8080/', 'https://[::1]:8443/'])('%j — 빌더와 판정이 같다', (url) => {
    expect(urlCheck(url) === undefined).toBe(builds(url));
  });
});
