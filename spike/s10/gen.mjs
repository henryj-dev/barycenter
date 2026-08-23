// S10 스파이크 — 500 라우트 conf 를 **우리 렌더러로** 만든다 (DESIGN.md §12.0, §7.5)
//
// 손으로 conf 를 쓰면 재는 것이 nginx 의 성질이지 **우리 산출물**이 아니다. S9 에서
// 배운 것과 같다: 스파이크가 초록인데 제품이 틀릴 수 있다.
//
//   node spike/s10/gen.mjs <출력디렉토리> <라우트수> <strict:0|1>
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { render } from '../../dist/conf/render.js';

const [, , outDir, nRaw, strictRaw, portRaw] = process.argv;
const n = Number(nRaw ?? 500);
const strict = strictRaw === '1';
const PORT = Number(portRaw ?? 18100);
const BACKEND = 18101;

/**
 * **역전을 일부러 만든다.** 그래야 `strict_priority` 가 실제로 강등을 한다 — 역전이
 * 없으면 아무것도 안 내리고, 그러면 두 conf 가 같아져서 아무것도 안 잰 것이 된다.
 *
 * 절반은 정확일치, 절반은 그 정확일치를 덮는 와일드카드로 만들고 와일드카드에 더 높은
 * priority 를 준다. 그러면 연결 요소가 **쌍마다 하나씩** 생기고 전부 내려간다.
 */
const routes = [];
const hosts = [];
for (let i = 0; i < n / 2; i += 1) {
  const zone = `z${i}.test`;
  hosts.push(`h.${zone}`, `*.${zone}`);
  routes.push({
    key: `e${i}`, listener: 'web', hosts: [`h.${zone}`], priority: 10,
    action: { kind: 'proxy', pool: 'app', websocket: false },
  });
  routes.push({
    key: `w${i}`, listener: 'web', hosts: [`*.${zone}`], priority: 20,
    action: { kind: 'proxy', pool: 'app', websocket: false },
  });
}

const model = {
  listeners: [{
    key: 'web', protocol: 'http', bind: '0.0.0.0', port: PORT, enabled: true,
    http: { defaultAction: { pool: 'app' }, ...(strict ? { strictPriority: true } : {}) },
  }],
  httpRoutes: routes,
  passthroughRoutes: [],
  pools: [{ key: 'app', protocolClass: 'http', algorithm: 'round_robin' }],
  backends: [{ key: 'b', pool: 'app', host: '127.0.0.1', port: BACKEND, weight: 1 }],
  certificates: [], tlsPolicies: [], sniBindings: [],
};

mkdirSync(outDir, { recursive: true });
mkdirSync(join(outDir, 'logs'), { recursive: true });
writeFileSync(
  join(outDir, `nginx-${PORT}.conf`),
  `daemon off;\nworker_processes 1;\nerror_log logs/e${PORT}.log warn;\npid logs/n${PORT}.pid;\n${render(model).conf}`,
  'utf8',
);
// **마지막 호스트를 재도록** 한다. 정규식은 순차 평가라 앞의 것만 재면 비용이 안 보인다.
writeFileSync(join(outDir, 'target.txt'), `h.z${Math.floor(n / 2) - 1}.test\n`, 'utf8');
process.stdout.write(`${hosts.length} 호스트 · strict=${strict}\n`);
