-- S10 부하 프로브 — 두 conf 를 **번갈아** 때린다 (DESIGN.md §12.0)
--
-- ── 계측기를 두 번 고쳤다. 둘 다 기록해 둔다.
--
-- ① **`ngx.now()` 는 밀리초 해상도다.** 처음 실측에서 plain 과 strict 가 소수점까지
--    똑같이 나왔다(p50 0.0 · p99 1000.2µs). 두 conf 가 같아서가 아니라 표본이 0 아니면
--    1000 으로 뭉갠 것이다. 계측기가 재려는 차이보다 거칠면 그 결과는 "차이가 없다" 가
--    아니라 **"못 쟀다"** 다. → `clock_gettime(CLOCK_MONOTONIC)` 을 FFI 로 부른다.
--
-- ② **따로 돌리면 노이즈가 신호를 덮는다.** 컨테이너를 두 번 띄워 재니 100 라우트에서
--    **-45%** 가 나왔다 — strict 가 45% 빨라질 리는 없다. p99 는 스케줄링 지터에 민감해
--    실행마다 두 배씩 튄다. → 두 엔진을 **같은 컨테이너에 동시에** 띄우고 한 루프에서
--    번갈아 때린다. 그러면 지터가 양쪽에 똑같이 실린다.
--
-- **마지막 호스트를 때린다.** 정규식은 순차 평가라(§7.4) 첫 호스트만 재면 비용이 안
-- 보인다. `target.txt` 를 생성기가 그렇게 골라 준다.
local ffi = require("ffi")
ffi.cdef([[
  typedef long bary_time_t;
  typedef struct { bary_time_t tv_sec; long tv_nsec; } bary_timespec;
  int clock_gettime(int clk_id, bary_timespec *tp);
]])
local CLOCK_MONOTONIC = 1   -- Linux
local ts = ffi.new("bary_timespec[1]")
local function now_ns()
  ffi.C.clock_gettime(CLOCK_MONOTONIC, ts)
  return tonumber(ts[0].tv_sec) * 1e9 + tonumber(ts[0].tv_nsec)
end

local f = assert(io.open("/w/target.txt"))
local host = f:read("*l")
f:close()

local N = tonumber(os.getenv("BARY_S10_N") or "3000")
local ports = {
  plain = tonumber(os.getenv("BARY_S10_PLAIN") or "18100"),
  strict = tonumber(os.getenv("BARY_S10_STRICT") or "18200"),
}
local req = "GET / HTTP/1.1\r\nHost: " .. host .. "\r\nConnection: close\r\n\r\n"

local samples = { plain = {}, strict = {} }
local failed = 0
local body_of = { plain = nil, strict = nil }

local function hit(which, keep)
  local sock = ngx.socket.tcp()
  sock:settimeout(5000)
  if not sock:connect("127.0.0.1", ports[which]) then
    failed = failed + 1
    return
  end
  local t0 = now_ns()
  sock:send(req)
  local body = sock:receive("*a")
  local dt = now_ns() - t0
  if body then
    if keep then samples[which][#samples[which] + 1] = dt / 1000 end   -- µs
    body_of[which] = body
  else
    failed = failed + 1
  end
  sock:close()
end

-- **덥힌다.** 첫 수백 요청은 JIT 과 커넥션 캐시가 안 자리잡아 양쪽 모두 튄다.
for _ = 1, 200 do
  hit("plain", false)
  hit("strict", false)
end
-- 번갈아 때린다. 순서를 라운드마다 뒤집어 **앞뒤 자리 효과**도 없앤다.
for i = 1, N do
  if i % 2 == 0 then
    hit("plain", true)
    hit("strict", true)
  else
    hit("strict", true)
    hit("plain", true)
  end
end

local function q(list, p)
  if #list == 0 then return 0 end
  return list[math.max(1, math.floor(#list * p))]
end

--- **짝지은 차이.** 번갈아 때려도 p99 는 여전히 튄다 — 500 라우트 실측에서 -31% 가
--- 나왔다. 꼬리는 스케줄링·GC 처럼 **둘 중 하나에만** 걸리는 사건이 만들고, 그 사건은
--- 번갈아 때린다고 양쪽에 똑같이 실리지 않는다.
---
--- 같은 라운드의 두 표본은 수십 µs 안에 붙어 있으므로 **공통 지터가 거의 같다.**
--- 그 차이를 먼저 내고 나서 분포를 보면 공통분이 상쇄된다. 이게 이 스파이크가
--- 판정에 쓰는 값이다.
local deltas = {}
for i = 1, math.min(#samples.plain, #samples.strict) do
  deltas[i] = samples.strict[i] - samples.plain[i]
end
table.sort(deltas)
local paired_p50 = q(deltas, 0.50)
local paired_p99 = q(deltas, 0.99)

table.sort(samples.plain)
table.sort(samples.strict)

-- 두 엔진이 **정말 다르게 답하는지**도 낸다. 숫자만 재고 동작을 안 보면 "느려지긴
-- 했는데 원하는 순서가 맞나" 를 모른다. 백엔드는 같으므로 본문은 같고, 여기서는
-- 응답을 받았다는 것만 확인한다 — 순서 자체는 단위 테스트가 conf 로 잰다.
ngx.print(string.format(
  '---json---{"n":%d,"failed":%d,' ..
  '"plain_p50":%.1f,"plain_p99":%.1f,"strict_p50":%.1f,"strict_p99":%.1f,' ..
  '"paired_p50":%.1f,"paired_p99":%.1f,"answered":%d}',
  #samples.plain, failed,
  q(samples.plain, 0.50), q(samples.plain, 0.99),
  q(samples.strict, 0.50), q(samples.strict, 0.99),
  paired_p50, paired_p99,
  (body_of.plain ~= nil and body_of.strict ~= nil) and 1 or 0))
