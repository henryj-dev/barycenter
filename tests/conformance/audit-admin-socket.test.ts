/**
 * 검수 2026-08-22 · S-08b — **admin 표면에 인증이 없다**
 *
 * `/membership` 은 백엔드 슬롯을 다시 쓰고 `/acme` 는 챌린지를 적재한다. 둘 다 인증이
 * 없었다. 막는 것은 **루프백 바인딩 하나**뿐이었고, 그건 "밖에서 못 온다" 이지
 * "아무나 못 쓴다" 가 아니다.
 *
 * 이론이 아니다: compose 배포에서는 admin 이 컨테이너 netns 안이라 안 열려 있지만,
 * §11.3 이 권장하는 **v1 배포가 hostNetwork** 이고 거기서는 같은 호스트의 아무
 * 프로세스나 슬롯을 다시 쓸 수 있다.
 *
 * ── 왜 토큰이 아니라 소켓인가
 *
 * 검수는 이걸 "세대에 비밀을 구우면 digest 가 비밀의 함수가 되어 결정적 렌더와
 * 충돌한다" 로 적고 미뤄 뒀다. **그 충돌은 애초에 안 생긴다** — `render_digest` 는
 * `conf` 만의 함수이고 admin 조각은 `include admin/*.conf` 글롭으로 들어온다
 * (`render.ts` 가 왜 그렇게 했는지 적어 뒀다).
 *
 * 그런데 그걸 알아도 토큰은 답이 아니다. 비밀을 어딘가에 두면 그 자리가 새 표면이 된다.
 * **유닉스 도메인 소켓은 비밀이 없다** — 접근 통제를 OS 가 지고, conf 에는 경로
 * 리터럴만 남아 결정성이 그대로다. 비-root 전환(S-10b)이 끝났으므로 소켓 디렉토리를
 * 그 사용자 소유 `0700` 으로 둘 수 있다.
 *
 * ── TCP 를 남기지 않는다
 *
 * 폴백으로 두고 싶어지는데, **고를 수 있는 약한 선택지는 언젠가 골라진다.** PKCE 의
 * `plain` 을 안 연 것과 같은 판단이다. 포트가 사라지면 `adminPortConflicts`(S-08a)도
 * 함께 사라진다 — 검사할 것이 구조적으로 없어지는 쪽이 검사보다 낫다.
 */
import { describe, expect, it } from 'vitest';

import { httpAdminConf, streamAdminConf } from '../../src/control/membership.js';
import { markerConf } from '../../src/control/plane.js';

const SOCK = '/prefix/run/admin.sock';
const STREAM_SOCK = '/prefix/run/stream-admin.sock';

describe('admin 표면은 유닉스 소켓이다 (검수 S-08b)', () => {
  it('http admin 이 소켓으로 듣는다', () => {
    const conf = httpAdminConf('gen-1', '7', SOCK);
    expect(conf).toContain(`listen unix:${SOCK};`);
    // TCP 로 듣는 자리가 하나도 남으면 안 된다 — 남으면 그게 그대로 옛 표면이다.
    expect(conf).not.toMatch(/listen\s+127\.0\.0\.1:/);
  });

  it('stream admin 도 소켓으로 듣는다', () => {
    const conf = streamAdminConf('7', STREAM_SOCK);
    expect(conf).toContain(`listen unix:${STREAM_SOCK};`);
    expect(conf).not.toMatch(/listen\s+127\.0\.0\.1:/);
  });

  it('세대 마커도 소켓이다', () => {
    const conf = markerConf('gen-1', SOCK);
    expect(conf).toContain(`listen unix:${SOCK};`);
    expect(conf).not.toMatch(/listen\s+127\.0\.0\.1:/);
  });

  it('경로가 conf 로 가는 자유 문자열이 아니다', () => {
    /**
     * 검수 S-11 과 같은 부류다. 경로는 데몬이 prefix 에서 만들지만, 만드는 자리가
     * 하나가 아닐 수 있으므로 **여기서 막는다.** 세미콜론 하나면 디렉티브가 늘어난다.
     */
    expect(() => httpAdminConf('g', '1', '/p/a.sock;\nserver{listen 80;}'))
      .toThrow(/소켓 경로/);
    expect(() => streamAdminConf('1', '/p/a.sock"')).toThrow(/소켓 경로/);
    expect(() => markerConf('g', '/p/a.sock ')).toThrow(/소켓 경로/);
    // 절대 경로여야 한다 — 상대 경로는 nginx prefix 기준이라 어디에 생길지 갈린다.
    expect(() => httpAdminConf('g', '1', 'run/admin.sock')).toThrow(/소켓 경로/);
  });

  it('세대 리터럴은 그대로다 — 소켓으로 옮겨도 마커는 세대에 결박된다', () => {
    // S7 A4.3 이 실측한 것이다. dict 마커로는 "누가 응답했는가" 를 못 말한다.
    expect(httpAdminConf('gen-A', '7', SOCK)).toContain('return 200 "gen-A"');
    expect(markerConf('gen-B', SOCK)).toContain('return 200 "gen-B"');
  });
});

describe('admin 포트라는 개념이 사라졌다 (검수 S-08b)', () => {
  it('plane 이 adminPortConflicts 를 안 내보낸다', async () => {
    /**
     * 포트가 없으면 겨눌 포트도 없다. S-08a 는 "백엔드가 admin 포트를 겨누지 못하게
     * 한다" 였는데, 구조적으로 불가능해지는 쪽이 검사보다 낫다.
     */
    const plane = await import('../../src/control/plane.js');
    expect('adminPortConflicts' in plane).toBe(false);
  });
});
