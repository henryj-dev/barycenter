/**
 * 세대를 **실물 `materializeGeneration` 으로** 만든다.
 *
 * 처음엔 manifest 를 셸에서 손으로 계산했는데, digest 규칙이 실물과 어긋나 preflight 가
 * 전부 거절했다 — 그러면 스윕이 "복구가 잘 된다" 는 잘못된 초록을 낸다. **아무 일도
 * 안 일어났으니까.** 계측 대상을 흉내로 만들면 그 흉내가 판정을 정한다.
 *
 *   node mkgen.mjs <prefix> <generation> [--print-digest]
 */
import { materializeGeneration } from '/app/dist/dp/materialize.js';

const [prefix, generation] = process.argv.slice(2);

const nginxConf = `error_log logs/error.log warn;
pid logs/nginx.pid;
events { worker_connections 64; }
http {
    access_log off;
    default_type text/plain;
    include admin/*.conf;
    server { listen 19991; location / { return 200 "${generation}"; } }
}
`;
const marker = `server {
    listen 127.0.0.1:19990;
    default_type text/plain;
    location = /generation { return 200 "${generation}"; }
    location = /healthz    { return 200 "ok"; }
}
`;

const manifest = materializeGeneration({
  prefix, generation,
  planes: ['http'],
  files: { 'nginx.conf': nginxConf, 'admin/marker.conf': marker },
});
process.stdout.write(manifest.digest);
