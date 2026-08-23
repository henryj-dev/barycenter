-- S15 프로브 — 밸런서 품질 네 축 (DESIGN.md §12.0)
--
-- **엔진 안에서 잰다.** `ngx.crc32_short` 는 nginx 의 함수이고, 재매핑률을 밖에서
-- 재려면 그 함수를 다시 구현해야 한다 — 그러면 재는 것은 우리 구현이지 엔진이 아니다.
-- 밸런서가 실제로 쓰는 식을 그대로 여기서 돌린다.

local N_KEYS = 10000

--- 우리 밸런서의 해시 식. `render.ts` 의 `pickExpression` 과 **같은 줄**이어야 한다.
local function pick_hash(key, n)
  return (ngx.crc32_short(key) % n) + 1
end

--- 라운드로빈. dict 카운터를 흉내 낸다 (`d:incr("rr:...")`).
local function pick_rr(c, n)
  return (c % n) + 1
end

--- **키 분포를 둘 만든다.** 하나만 재면 결과가 해시의 성질인지 내 키 생성의 성질인지
--- 구분되지 않는다.
---
---   `subnet`  한 /16 안의 연속 주소. `source_ip_hash` 의 실제 모양이다 — 사내망·
---             단일 NAT·클라우드 서브넷에서 오는 트래픽이 정확히 이렇게 생겼다.
---   `spread`  옥텟 넷이 다 흩어진 주소. 인터넷에서 오는 모양에 가깝다.
---
--- 앞의 것이 쏠리고 뒤의 것이 안 쏠린다면 그건 해시의 결함이 아니라 **입력의 성질**이고,
--- 그때 할 말은 "해시를 바꿔라" 가 아니라 "서브넷 트래픽에서는 쏠린다" 다.
local function keys(n, kind)
  local out = {}
  if kind == "subnet" then
    -- LuaJIT 은 5.1 이라 `//` 가 없다. `math.floor` 를 쓴다.
    for i = 1, n do out[i] = string.format("10.1.%d.%d", math.floor(i / 256) % 256, i % 256) end
  else
    for i = 1, n do
      out[i] = string.format("%d.%d.%d.%d",
        (i * 167) % 223 + 1, (i * 61) % 251, (i * 199) % 253, (i * 97) % 254)
    end
  end
  return out
end

--- 최대 편차(%) — 평균에서 가장 많이 벗어난 통.
local function worst_dev(counts, n)
  local total = 0
  for i = 1, n do total = total + (counts[i] or 0) end
  local mean = total / n
  local worst = 0
  for i = 1, n do
    local d = math.abs((counts[i] or 0) - mean) / mean
    if d > worst then worst = d end
  end
  return worst * 100
end

local out = {}

-- ── 축 1: RR 공정성 ────────────────────────────────────────────────────
--
-- 합격 기준 **편차 < 5%**. dict `incr` 이 원자적이므로 이상적으로는 0 이어야 하고,
-- 0 이 아니면 나눗셈이 아니라 개수 문제다(요청 수가 peer 수의 배수가 아닐 때).
for _, n in ipairs({ 3, 7, 16 }) do
  local counts = {}
  for c = 1, 6000 do
    local i = pick_rr(c, n)
    counts[i] = (counts[i] or 0) + 1
  end
  out[#out + 1] = string.format('"rr_dev_%d":%.4f', n, worst_dev(counts, n))
end

-- ── 축 2: hash 분포 ────────────────────────────────────────────────────
--
-- 해시는 RR 처럼 균등하지 않다 — 균등해야 하는 것도 아니다(같은 키가 같은 곳으로
-- 가는 것이 목적이다). 그래도 **한쪽으로 쏠리면** 그건 결함이다.
local ks = keys(N_KEYS, "spread")
local ks_subnet = keys(N_KEYS, "subnet")
for _, kind in ipairs({ "spread", "subnet" }) do
  local set = kind == "spread" and ks or ks_subnet
  for _, n in ipairs({ 3, 7, 16 }) do
    local counts = {}
    for i = 1, N_KEYS do
      local idx = pick_hash(set[i], n)
      counts[idx] = (counts[idx] or 0) + 1
    end
    out[#out + 1] = string.format('"hash_dev_%s_%d":%.4f', kind, n, worst_dev(counts, n))
  end
end

-- ── 축 3: 재매핑률 ─────────────────────────────────────────────────────
--
-- **이 축이 이 스파이크의 이유다.** 정적 경로는 `hash ... consistent` 인데 멤버십
-- 평면은 `% n` 이라, 렌더러 주석이 *"목록이 바뀌면 거의 전부 재매핑된다"* 고 적어
-- 두었다. "거의 전부" 를 숫자로 바꾼다.
--
-- 이상적인 consistent hashing 은 peer 하나가 늘 때 **1/(n+1)** 만 옮긴다.
for _, n in ipairs({ 3, 7, 16 }) do
  local moved = 0
  for i = 1, N_KEYS do
    if pick_hash(ks[i], n) ~= pick_hash(ks[i], n + 1) then moved = moved + 1 end
  end
  out[#out + 1] = string.format('"remap_%d_to_%d":%.4f', n, n + 1, moved / N_KEYS * 100)
  out[#out + 1] = string.format('"remap_ideal_%d_to_%d":%.4f', n, n + 1, 1 / (n + 1) * 100)
end

-- ── 축 4: 고르는 비용 ──────────────────────────────────────────────────
--
-- 합격 기준은 "CPU/p99 오버헤드 < 10%" 인데, 그건 **엔진 전체** 대비다. 여기서 재는
-- 것은 그 안의 한 조각 — 고르는 식 자체의 시간이다. 이 값이 요청 처리 시간에 비해
-- 무시할 만하면(수십 나노초) 나머지 오버헤드는 이 식이 아니라 Lua 진입 비용이고,
-- 그건 S1 이 이미 통과시킨 구조다.
local function bench(fn, iters)
  local t0 = os.clock()
  local sink = 0
  for i = 1, iters do sink = sink + fn(i) end
  local t1 = os.clock()
  -- 최적화로 통째로 날아가지 않게 결과를 쓴다.
  if sink < 0 then error("unreachable") end
  return (t1 - t0) / iters * 1e9
end

local ITERS = 200000
out[#out + 1] = string.format('"ns_rr":%.2f', bench(function(i) return pick_rr(i, 8) end, ITERS))
out[#out + 1] = string.format('"ns_hash":%.2f',
  bench(function(i) return pick_hash(ks[(i % N_KEYS) + 1], 8) end, ITERS))

ngx.print("---json---{" .. table.concat(out, ",") .. "}")
