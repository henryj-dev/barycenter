/**
 * S14 백엔드 — 자기 이름을 답한다. HTTP·TCP·UDP 셋 다 같은 컨테이너에서.
 *
 * §12.0 이 요구하는 것이 **HTTP/TCP/UDP × A/AAAA/SRV** 이므로, 세 서브시스템을 한
 * 백엔드가 다 받아야 한 번의 DNS 변경으로 셋을 동시에 관측할 수 있다. 따로 띄우면
 * "http 만 바뀌었다" 가 백엔드 차이인지 서브시스템 차이인지 갈리지 않는다.
 */
import { createServer as createHttp } from 'node:http';
import { createServer as createTcp } from 'node:net';
import { createSocket } from 'node:dgram';

const NAME = process.env.S14_NAME ?? 'unknown';

createHttp((_req, res) => res.writeHead(200, { 'content-type': 'text/plain' }).end(NAME))
  .listen(8080, '::');

createTcp((sock) => { sock.end(NAME); }).listen(9090, '::');

// **오래 사는 연결** — 「기존 세션 거동」을 재려면 끊기지 않고 버티는 것이 필요하다.
// 0.5 초마다 한 줄씩 20 초. 도중에 DNS 에서 이 백엔드를 지우고, 줄이 계속 오는지 본다.
createTcp((sock) => {
  let n = 0;
  const t = setInterval(() => {
    n += 1;
    if (n > 40 || sock.destroyed) { clearInterval(t); sock.end(); return; }
    sock.write(`${NAME}-${n}\n`);
  }, 500);
  sock.on('close', () => clearInterval(t));
  sock.on('error', () => clearInterval(t));
}).listen(9092, '::');

const udp = createSocket({ type: 'udp6', ipv6Only: false });
udp.on('message', (_m, r) => { udp.send(NAME, r.port, r.address); });
udp.bind(9091);

process.stdout.write(`backend ${NAME} up\n`);
