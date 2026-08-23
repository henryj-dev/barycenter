/**
 * S2 축소의 **진짜 구멍** — stream 평면에는 관측 창구가 없었다 (2026-08-23).
 *
 * 문서는 오래 *"드레인 숫자는 엔진이 안 주면 안 싣는다"* 로 적혀 있었고, 그게 마치
 * 엔진 전체가 못 주는 것처럼 읽혔다. 코드를 다시 재 보니 아니었다:
 *
 *   · `balancer_by_lua` 의 `d:incr("in:" .. peer, 1, 0)` 은 **두 평면이 공유한다** —
 *     `upstreamBlock` 이 dict 이름을 인자로 받으므로 http 도 stream 도 똑같이 올린다.
 *   · `log_by_lua_block` 의 감소도 **양쪽 다** 있다 (`render.ts` 두 자리).
 *   · 그런데 **묻는 창구는 http 에만** 있었다. `httpAdminConf` 에는
 *     `location = /membership/inflight` 가 있고, `streamAdminConf` 에는 `write|read` 뿐이다.
 *
 * 즉 **숫자는 이미 세고 있는데 아무도 못 읽는 상태**였다. 이 저장소가 반복해서 잡는
 * *"필드는 있는데 아무도 안 읽는다"* 의 stream 판이다. TCP·UDP 백엔드를 드레인하면
 * `drain_condition` 이 영원히 `no_new_traffic` 에 머물고 `quiesced` 가 절대 안 나온다 —
 * **세션이 다 빠졌는데도** 그렇다.
 *
 * http zone 과 stream zone 은 서로 안 보이므로(E14 · E25 · §3.4) http admin 으로 대신
 * 물을 수도 없다. 각 평면이 자기 창구를 가져야 한다.
 */
import { describe, expect, it } from 'vitest';

import { httpAdminConf, streamAdminConf } from '../../src/control/membership.js';
import { parsePeerObservation, observeStreamPeer } from '../../src/control/drain.js';

describe('stream 평면 inflight 관측 (S2)', () => {
  const socket = '/prefix/run/stream-admin.sock';

  it('stream admin 이 inflight 를 묻는 창구를 낸다', () => {
    const conf = streamAdminConf('E7', socket);
    // http 쪽과 **같은 값을 세는 같은 키**를 읽어야 한다.
    expect(conf).toContain('in:');
    expect(conf).toContain('inflight');
  });

  it('http 창구와 같은 모양으로 답한다 — 읽는 쪽이 평면을 안 가른다', () => {
    // 두 평면의 답이 다르면 `parsePeerObservation` 이 둘로 갈라지고, 그 순간
    // "어느 평면이냐" 가 드레인 판정 곳곳에 새어 나온다.
    expect(httpAdminConf('g', 'E7', socket)).toContain('active_sessions');
    expect(streamAdminConf('E7', socket)).toContain('active_sessions');
  });

  it('관측을 파싱해 숫자를 낸다', async () => {
    const talk = async (payload: string): Promise<string> => {
      expect(payload).toContain('inflight');
      expect(payload).toContain('10.0.0.7:12');
      return '{"inflight":3,"active_sessions":3}';
    };
    const raw = await observeStreamPeer(talk, '10.0.0.7:12');
    expect(parsePeerObservation(raw)).toEqual({ inflight: 3, sessions: 3 });
  });

  it('키가 없으면 숫자를 안 짓는다 — `{}` 는 관측 없음이다', async () => {
    const talk = async (): Promise<string> => '{}';
    expect(parsePeerObservation(await observeStreamPeer(talk, 'a:1'))).toBeUndefined();
  });

  it('admin 이 안 답하거나 쓰레기를 주면 undefined — 0 을 기본값으로 두지 않는다', async () => {
    const boom = async (): Promise<string> => { throw new Error('ECONNREFUSED'); };
    expect(await observeStreamPeer(boom, 'a:1')).toBeUndefined();

    const junk = async (): Promise<string> => 'bad header\n';
    expect(parsePeerObservation(await observeStreamPeer(junk, 'a:1'))).toBeUndefined();
  });

  it('peer 를 헤더가 아니라 다음 줄로 보낸다 — 헤더 문법을 안 넓힌다', async () => {
    /**
     * stream admin 의 헤더는 `^(%S+)%s+(%S+)$` 로 **정확히 두 토큰**이다. peer 를 거기
     * 끼워 넣으면 그 정규식을 넓혀야 하고, 그러면 `write`·`read` 의 파싱도 함께 헐거워진다.
     * 본문 줄로 보내면 기존 문법이 그대로 산다 — `write` 가 이미 쓰는 모양이다.
     */
    let sent = '';
    const talk = async (payload: string): Promise<string> => { sent = payload; return '{}'; };
    await observeStreamPeer(talk, '10.0.0.7:12');
    const [head, body] = sent.split('\n');
    expect(head?.split(/\s+/)).toHaveLength(2);
    expect(body).toBe('10.0.0.7:12');
  });
});
