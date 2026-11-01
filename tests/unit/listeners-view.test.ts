/**
 * Listeners 화면의 값 — 브라우저 없이 계약을 지킨다.
 */
import { describe, expect, it } from 'vitest';

import { socketOf, viewOfListeners } from '../../src/web/listeners-view.js';

describe('리스너 목록', () => {
  it('커밋됐지만 아직 안 열린 소켓을 join 으로 표시한다', () => {
    const view = viewOfListeners(
      [{ key: 'front', protocol: 'http', bind: '0.0.0.0', port: 999 }],
      { added: ['tcp://0.0.0.0:999'] },
    );
    expect(socketOf(view.rows[0]!)).toBe('tcp://0.0.0.0:999');
    expect(view.rows).toEqual([
      {
        key: 'front', protocol: 'http', bind: '0.0.0.0', port: 999,
        enabled: true, socket: 'tcp://0.0.0.0:999', mark: 'join', sourceAllow: [],
      },
    ]);
  });

  it('출발지 제한을 행에 싣는다 — 화면이 「출발지 N개만」을 그린다 (2026-10-29)', () => {
    const view = viewOfListeners([
      { key: 'cf', protocol: 'http', bind: '0.0.0.0', port: 443, sourceAllow: ['173.245.48.0/20', '2400:cb00::/32'] },
      { key: 'open', protocol: 'tcp', bind: '0.0.0.0', port: 9000 },
    ]);
    expect(view.rows.map((r) => [r.key, r.sourceAllow.length])).toEqual([['cf', 2], ['open', 0]]);
  });

  it('**head 에서 빠진 소켓은 행을 만들지 않는다** — 목록은 head 의 리스너만 (2026-11-01)', () => {
    // 전에는 삭제한 리스너의 소켓을 `tcp://…` 이름의 「적용하면 닫힘」 행으로 그렸다. 리스너가 아닌 행이 섞였다.
    const view = viewOfListeners(
      [{ key: 'keep', protocol: 'http', bind: '127.0.0.1', port: 80 }],
      { added: [] },
    );
    expect(view.rows.map((r) => [r.key, r.mark])).toEqual([['keep', 'stay']]);
  });

  it('**꺼진 리스너는 「서빙 중」 이 아니다** — 적용하면 열지 않는다', () => {
    const view = viewOfListeners([
      { key: 'off', protocol: 'https', bind: '0.0.0.0', port: 443, enabled: false, httpRedirect: { port: 80 } },
    ], { added: ['tcp://0.0.0.0:443'] });
    expect(view.rows.map((r) => r.mark)).toEqual(['off']);
  });

  it('대기 열이 없으면 목록은 지금 모델 그대로다', () => {
    const view = viewOfListeners([
      { key: 'b', protocol: 'udp', bind: '0.0.0.0', port: 53, enabled: false },
      { key: 'a', protocol: 'tcp', bind: '127.0.0.1', port: 22 },
    ]);
    expect(view.rows.map((r) => r.key)).toEqual(['a', 'b']);
    expect(view.rows.map((r) => r.mark)).toEqual(['stay', 'off']);
    expect(view.rows[1]?.enabled).toBe(false);
  });
});



/**
 * HTTPS 리다이렉트 소켓이 목록에 보인다 (2026-11-01). 리스너가 아니라서 전에는 어디에도 안 보였다 — 그 소켓만 새로
 * 열리는 변경도 「서빙 중」 으로 그렸다.
 */
describe('리다이렉트 소켓', () => {
  const https = {
    key: 'bi', protocol: 'https', bind: '10.253.65.250', port: 443, enabled: true, httpRedirect: { port: 80 },
  };

  it('HTTPS 행에 리다이렉트 소켓을 붙인다', () => {
    const [row] = viewOfListeners([https]).rows;
    expect(row?.redirect).toEqual({ port: 80, socket: 'tcp://10.253.65.250:80' });
  });

  it('리다이렉트 소켓만 새로 열려도 「적용하면 열림」 이다', () => {
    const [row] = viewOfListeners([https], { added: ['tcp://10.253.65.250:80'] }).rows;
    expect(row?.mark).toBe('join');
  });

  it('http 리스너에는 붙이지 않는다', () => {
    const [row] = viewOfListeners([{ key: 'h', protocol: 'http', bind: '0.0.0.0', port: 80, httpRedirect: { port: 81 } }]).rows;
    expect(row?.redirect).toBeUndefined();
  });
});
