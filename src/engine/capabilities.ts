/**
 * 엔진 capability 탐지 — DESIGN.md §7.6 / §9.2
 *
 * 왜 "필수 모듈 목록"이 아니라 capability 인가.
 *
 * tests/engine E0 이 실증한 것: 우리가 필요한 두 모듈이 **서로 다른 이미지 계열에 나뉘어
 * 있다.** 어느 공개 이미지도 둘 다 갖고 있지 않다.
 *
 *   공식 nginx  : stream_realip ✅ / ngx_stream_lua ❌
 *   OpenResty   : stream_realip ❌ / ngx_stream_lua ✅
 *
 * 그래서 목록을 하드코딩하면 어떤 이미지를 골라도 "설계 위반" 상태가 된다. 대신 엔진이
 * 무엇을 할 수 있는지 읽고, 모델이 표현 가능한 것을 거기에 맞춰 좁힌다(§7.6). 커스텀
 * 이미지를 빌드하든, 스파이크 결과로 순수 nginx(대안 B)로 가든 같은 코드가 동작한다.
 */

export type EngineFlavor = 'nginx' | 'openresty' | 'unknown';

export type EngineCapabilities = {
  flavor: EngineFlavor;
  /** nginx **core** 버전. OpenResty 의 4자리 버전은 앞 3자리로 접는다. */
  version: string;
  /** `--with-*` 로 **정적** 컴파일된 것. */
  modules: ReadonlySet<string>;
  /**
   * `--add-dynamic-module` 로 빌드된 것. **빌드됐다고 로드된 것이 아니다** —
   * `load_module` 지시가 있어야 쓸 수 있다. 여기서는 "있을 수도 있다"까지만 안다.
   */
  dynamicModules: ReadonlySet<string>;
  supports: {
    stream: boolean;
    streamLua: boolean;
    /** 없으면 stream 에서 PROXY 헤더의 주소가 `$remote_addr` 를 덮지 못한다. */
    streamRealip: boolean;
    sniPassthrough: boolean;
    http2: boolean;
    /** upstream `server ... resolve` — 1.27.3 부터 OSS. §7.3 대안 B 의 전제. */
    dnsResolve: boolean;
    runtimeMembership: { http: boolean; stream: boolean };
  };
};

const parseVersion = (v: string): number[] =>
  v.split('.').map((p) => Number.parseInt(p, 10)).filter((n) => Number.isFinite(n));

/** a >= b */
function atLeast(a: string, b: string): boolean {
  if (a === '') return false;
  const x = parseVersion(a);
  const y = parseVersion(b);
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d > 0;
  }
  return true;
}

export function parseEngineCapabilities(nginxV: string): EngineCapabilities {
  const versionLine = /nginx version:\s*(\S+)/.exec(nginxV);
  const raw = versionLine?.[1] ?? '';
  const flavor: EngineFlavor = raw.startsWith('openresty/')
    ? 'openresty'
    : raw.startsWith('nginx/')
      ? 'nginx'
      : 'unknown';

  // OpenResty 는 `openresty/1.31.1.1` 처럼 4자리다. 앞 3자리가 nginx core 버전이다.
  const version = raw.includes('/') ? parseVersion(raw.split('/')[1]!).slice(0, 3).join('.') : '';

  const modules = new Set<string>();
  const dynamicModules = new Set<string>();
  // `--with-http_x_module=dynamic` 은 정적이 아니다. 먼저 걸러낸다.
  for (const m of nginxV.matchAll(/--with-([A-Za-z0-9_]+)(=dynamic)?/g)) {
    (m[2] === undefined ? modules : dynamicModules).add(m[1]!);
  }
  for (const m of nginxV.matchAll(/--add-module=\S*?([A-Za-z0-9_]+)-[0-9]/g)) modules.add(m[1]!);
  for (const m of nginxV.matchAll(/--add-dynamic-module=\S*?([A-Za-z0-9_]+)-[0-9]/g)) {
    dynamicModules.add(m[1]!);
  }

  const has = (name: string): boolean => modules.has(name);
  // OpenResty 는 --add-module=../ngx_lua-0.10.x / ../ngx_stream_lua-0.0.x 로 들어온다.
  const httpLua = /ngx_lua-|ngx_http_lua/.test(nginxV);
  const streamLua = /ngx_stream_lua/.test(nginxV);

  return {
    flavor,
    version,
    modules,
    dynamicModules,
    supports: {
      stream: has('stream'),
      streamLua,
      streamRealip: has('stream_realip_module'),
      sniPassthrough: has('stream_ssl_preread_module'),
      http2: has('http_v2_module') && atLeast(version, '1.25.1'),
      dnsResolve: atLeast(version, '1.27.3'),
      runtimeMembership: { http: httpLua, stream: streamLua },
    },
  };
}
