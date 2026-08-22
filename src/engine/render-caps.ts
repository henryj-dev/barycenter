/**
 * 엔진 조회 결과 → 렌더 capability. **한 자리에서만 만든다** (검수 B-02)
 *
 * `barycenterd` 가 이 매핑을 **두 자리에 적고 있었다.** `writeBootstrap` 은 다섯 필드를
 * 전부 넘겼고, 정작 `ConfigStore`·`ControlPlane` 이 쓰는 `main()` 쪽은 셋만 넘겼다.
 *
 * 그래서 `caps.http2 === true` 가 절대 참이 아니었다 — **엔진이 지원해도 HTTP/2 가
 * 영원히 꺼진다.** 그리고 검증기는 `http2: true` 를 명시한 리스너를
 * `option_not_supported` 로 거부하므로, 켜려고 하면 오히려 막혔다. `sslConfCommand` 가
 * 없으니 TLS1.3 암호군도 엔진 기본값으로 남았다 — 암호군 정책의 절반이 무효였다.
 *
 * 이 저장소가 이미 아는 부류다: *"두 군데서 계산하면 언젠가 갈린다"*
 * (`membership.ts` 가 upstream 이름을 산출물에서 읽는 이유와 같다). 자리를 하나로 만든다.
 *
 * **못 물어봤으면 보수적으로 간다.** 모르는 것을 할 수 있다고 하지 않는다.
 */
import type { RenderCapabilities } from '../conf/render.js';
import type { EngineProbe } from './probe.js';

/** capability 를 모르면 없는 쪽으로 가정한다. */
const CONSERVATIVE: RenderCapabilities = { streamRealip: false };

export function renderCapsOf(probe: EngineProbe): RenderCapabilities {
  if (!probe.ok) return { ...CONSERVATIVE };
  const s = probe.capabilities.supports;
  return {
    streamRealip: s.streamRealip,
    // `runtimeMembership` 이 lua 모듈 유무를 평면별로 이미 접어 준다 — 여기서 다시
    // 계산하면 두 자리가 갈린다(이 파일이 있는 이유가 그것이다).
    httpLua: s.runtimeMembership.http,
    streamLua: s.runtimeMembership.stream,
    // §4.9 — 모듈과 버전을 함께 본다. 그 전 문법(`listen ... http2`)은 리스너 단위라
    // 지금 규칙(server 별)이 성립하지 않는다.
    http2: s.http2,
    // §4.6 — TLS1.3 ciphersuite 를 정하는 유일한 길이다.
    sslConfCommand: s.sslConfCommand,
  };
}
