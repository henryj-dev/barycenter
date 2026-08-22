/**
 * 검수 2026-08-22 · B-02 — **부트스트랩과 런타임이 같은 capability 를 쓴다**
 *
 * `barycenterd` 가 렌더 capability 를 **두 자리에서 따로** 만들고 있었다.
 * `writeBootstrap` 은 다섯 필드를 전부 넘겼고, 정작 `ConfigStore`·`ControlPlane` 이 쓰는
 * `main()` 쪽은 셋만 넘겼다.
 *
 *   writeBootstrap  { streamRealip, httpLua, streamLua, http2, sslConfCommand }
 *   main()          { streamRealip, httpLua, streamLua }
 *
 * 그래서 `caps.http2 === true` 가 절대 참이 아니었다 — **엔진이 지원해도 HTTP/2 가
 * 영원히 꺼진다.** 게다가 검증기는 `http2:true` 를 명시한 리스너를 `option_not_supported`
 * 로 거부하므로, 켜려고 하면 오히려 막혔다. `sslConfCommand` 가 없으니
 * `ssl_conf_command Ciphersuites` 도 안 나가고 **TLS1.3 암호군은 엔진 기본값**으로 남았다.
 *
 * 두 번 적었으니 한 번 갈렸다. 매핑을 한 자리로 모으고, **그 자리가 하나라는 것**을
 * 여기서 지킨다 — 값만 재면 누군가 다시 인라인해도 초록이다.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { parseEngineCapabilities } from '../../src/engine/capabilities.js';
import { renderCapsOf } from '../../src/engine/render-caps.js';
import type { EngineProbe } from '../../src/engine/probe.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');

const probeOf = (fixture: string): EngineProbe => ({
  ok: true,
  via: fixture,
  capabilities: parseEngineCapabilities(
    readFileSync(join(ROOT, 'tests/fixtures', fixture), 'utf8')),
});

describe('렌더 capability 매핑 (검수 B-02)', () => {
  it('부트스트랩과 런타임이 같은 capability 를 쓴다', () => {
    // 매핑을 만드는 자리가 **하나**여야 한다. 두 자리에 적으면 언젠가 갈린다 —
    // 실제로 갈렸고, 그 결과가 "HTTP/2 가 영원히 안 켜진다" 였다.
    const src = readFileSync(join(ROOT, 'src/bin/barycenterd.ts'), 'utf8');
    expect(src).not.toContain('streamRealip:');
    expect(src).toContain('renderCapsOf(');
  });

  it('엔진이 낼 수 있는 것을 하나도 빠뜨리지 않는다', () => {
    const probe = probeOf('nginx-V.openresty-alpine.txt');
    const caps = renderCapsOf(probe);
    const s = probe.ok ? probe.capabilities.supports : undefined;

    expect(caps).toEqual({
      streamRealip: s?.streamRealip,
      httpLua: s?.runtimeMembership.http,
      streamLua: s?.runtimeMembership.stream,
      http2: s?.http2,
      sslConfCommand: s?.sslConfCommand,
    });
    // 이 이미지는 http2 와 ssl_conf_command 를 낼 수 있다 — 그런데 런타임은
    // 그 사실을 못 받고 있었다.
    expect(caps.http2).toBe(true);
    expect(caps.sslConfCommand).toBe(true);
  });

  it('공식 nginx 이미지도 같은 매핑을 지난다', () => {
    const caps = renderCapsOf(probeOf('nginx-V.nginx-alpine.txt'));
    // stream_realip 은 있고 lua 는 없다 — E0 이 실측한 갈림이다.
    expect(caps.streamRealip).toBe(true);
    expect(caps.httpLua).toBe(false);
  });

  it('못 물어봤으면 보수적으로 간다', () => {
    // 모르는 것을 할 수 있다고 하지 않는다.
    expect(renderCapsOf({ ok: false, reason: '엔진이 없다' }))
      .toEqual({ streamRealip: false });
  });
});
