<script lang="ts">
  /**
   * TLS 패스스루 리스너 만들기 — 복호화하지 않고 SNI 만 보고 풀을 고른다.
   *
   * 폴백은 둘이고 서로 다르다: **유효한 SNI 인데 맞는 라우트가 없을 때**(`pool`)와 **TLS 는 맞는데
   * SNI 가 없을 때**(`noSniPool`, S9). TLS 로 읽히지 않는 바이트(비-TLS · 깨진 ClientHello)에는 폴백이
   * 없다 — 언제나 끊는다. 스파이크가 그 통이 no-SNI 와 갈린다는 것을 실측했다. 그래서 칸을 만들지 않고
   * 도움말에 적는다.
   */
  import { getContext } from 'svelte';
  import { FormRow, FormSection, Select } from '#lib/ui';
  import { after } from '#lib/after';
  import type { createDesk } from '#lib/desk.svelte.ts';
  import CreateForm from './CreateForm.svelte';
  import ListenerBasics from './ListenerBasics.svelte';
  import SourceAllowSection from './SourceAllowSection.svelte';
  import { filled, keyError, portError } from './checks';

  const desk = getContext<ReturnType<typeof createDesk>>('desk');
  /** 빈 값 = 끊는다. */
  const choices = $derived([
    { value: '', label: '연결을 끊어요' },
    ...desk.pools.rows.filter((p) => p.protocolClass === 'tcp').map((p) => ({ value: p.key, hint: 'TCP 풀' })),
  ]);

  let key = $state('');
  let bind = $state('0.0.0.0');
  let port = $state('443');
  let pool = $state('');
  let noSniPool = $state('');
  let allow = $state('');

  const ready = $derived(filled(key, keyError) && filled(bind) && filled(port, portError));
  const submit = (): void => {
    void desk.insertPassthroughListener(key.trim(), {
      bind: bind.trim(),
      port: Number(port),
      ...(pool === '' ? {} : { pool }),
      ...(noSniPool === '' ? {} : { noSniPool }),
    }, allow).then(after);
  };
</script>

<CreateForm {ready} onsubmit={submit} cancelHref="/traffic/listener">
  <ListenerBasics protocol="TLS 패스스루" bind:key bind:bind bind:port />
  <FormSection title="동작">
    <FormRow label="SNI 매칭 없음" help="유효한 SNI 인데 맞는 라우트가 없을 때 보낼 곳이에요.">
      <Select label="SNI 매칭 없음 폴백" bind:value={pool} options={choices} width="100%" />
    </FormRow>
    <FormRow label="SNI 없음" help="TLS 는 맞는데 SNI 가 없을 때 보낼 곳이에요. TLS 로 읽히지 않는 바이트는 어느 쪽으로도 안 가요. 언제나 끊어요.">
      <Select label="SNI 없음 폴백" bind:value={noSniPool} options={choices} width="100%" />
    </FormRow>
  </FormSection>
  <SourceAllowSection bind:value={allow} {port} />
</CreateForm>
