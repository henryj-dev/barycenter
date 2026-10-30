<script lang="ts">
  /** 리스너 만들기 1 / 2 — 프로토콜 고르기 (시안). 둘째 단계가 프로토콜마다 주소다. */
  import Writable from '#lib/global/Writable.svelte';

  const choices = [
    { p: 'http', n: 'HTTP', d: '호스트·경로로 라우트를 나눈다. 평문.' },
    { p: 'https', n: 'HTTPS', d: '인증서와 TLS 정책이 필요하다. SNI 로 호스트를 가른다.' },
    { p: 'tcp', n: 'TCP', d: '바이트를 그대로 풀로 넘긴다.' },
    { p: 'udp', n: 'UDP', d: 'DNS·WireGuard·게임 프리셋.' },
    { p: 'tls_passthrough', n: 'TLS 패스스루', d: '복호화하지 않는다. SNI 만 보고 풀을 고른다.' },
  ];
</script>

<p class="d-note">1 / 2 · 프로토콜 고르기 — 또는 <a class="d-link" href="/traffic/listener/new/quick">빠른 프록시 만들기</a>(URL 하나로 한 번에)</p>
<Writable>
  <ul class="d-list">
    {#each choices as c (c.p)}
      <li><a href={`/traffic/listener/new/${c.p}`}>{c.n}</a><span class="d-note">{c.d}</span></li>
    {/each}
  </ul>
</Writable>
