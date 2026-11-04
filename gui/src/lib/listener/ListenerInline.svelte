<script lang="ts">
  /**
   * 리스너 분할 상세의 인라인 수정 — 콘솔 시안 `isecs`(`INL.listeners`: host · port · pool · active · src).
   * 구획은 시안 `fieldsFor('listeners', v, false, 'form')` 의 제목 순서(기본 · 동작 · 접근 제한)이고 그 칸만 둔다.
   *   · 기본 — 바인드 주소 · 포트 · 활성화
   *   · 동작 — 기본 풀(HTTP 계열은 기본 동작이 「거절」 이면 칸이 없다 · TCP · UDP 는 늘 있다. 패스스루는 폴백이라 설정 탭)
   *   · 접근 제한 — 출발지 제한(대역 행)
   * 나머지 칸은 「상세 페이지 ↗」 의 설정 탭이다.
   *
   * 저장은 설정 탭과 같은 길이다 — head 의 그 리스너 위에 `editListenerPatch` 로 고친 칸만 덮어 `putResource`(commit).
   * 처음 값은 마운트할 때 읽는다(`ListSplit` 이 고른 키가 바뀌면 `{#key}` 로 새로 만든다).
   */
  import { getContext } from 'svelte';
  import { editListenerPatch, parseSourceAllow, type ListenerEdit } from '@web/edit';
  import { FormRow, FormSection, Select, Switch, TextInput } from '#lib/ui';
  import { after } from '#lib/after';
  import InlineEdit from '#lib/detail/InlineEdit.svelte';
  import BindField from '#lib/forms/BindField.svelte';
  import SourceRows from '#lib/forms/SourceRows.svelte';
  import { LISTENER_ERR, srcHelp } from '#lib/forms/checks';
  import type { createDesk } from '#lib/desk.svelte.ts';

  let { key, detailHref, pending }: { key: string; detailHref: string; pending: boolean } = $props();
  const desk = getContext<ReturnType<typeof createDesk>>('desk');
  // svelte-ignore state_referenced_locally
  const model = desk.listenerModels.find((l) => l['key'] === key);
  const protocol = typeof model?.['protocol'] === 'string' ? model['protocol'] : '';
  const isHttp = protocol === 'http' || protocol === 'https';
  const obj = (v: unknown): Record<string, unknown> | undefined => (typeof v === 'object' && v !== null && !Array.isArray(v) ? v as Record<string, unknown> : undefined);
  const da = isHttp ? obj(model?.['http'])?.['defaultAction'] : model?.['defaultPool'] === undefined ? undefined : { pool: model['defaultPool'] };
  const initPool = typeof obj(da)?.['pool'] === 'string' ? String(obj(da)!['pool']) : '';
  /** 시안: HTTP 계열은 기본 동작이 거절이면 「기본 풀」 칸이 없다. TCP · UDP 는 기본 풀이 기본 동작이다. 패스스루는 설정 탭. */
  const hasPool = (isHttp && initPool !== '') || protocol === 'tcp' || protocol === 'udp';
  /** 프록시 프로토콜로 원본 IP 를 받는 TCP · 패스스루는 출발지 제한을 못 쓴다(시안 `noSrc`). */
  const noSrc = !isHttp && model?.['acceptProxyProtocol'] !== undefined;

  const init = {
    bind: String(model?.['bind'] ?? ''), port: String(model?.['port'] ?? ''), enabled: model?.['enabled'] !== false, pool: initPool,
    allow: Array.isArray(model?.['sourceAllow']) ? (model['sourceAllow'] as string[]).join('\n') : '',
  };
  let bind = $state(init.bind);
  let port = $state(init.port);
  let enabled = $state(init.enabled);
  let pool = $state(init.pool);
  let allow = $state(init.allow);
  let allowBad = $state(false);
  let gen = $state(0);
  let saving = $state(false);

  const poolClass = isHttp ? 'http' : protocol;
  const pools = $derived(desk.pools.rows.filter((p) => p.protocolClass === poolClass).map((p) => ({ value: p.key })));
  const errors = $derived({
    bind: bind.trim() === '' ? LISTENER_ERR.host : undefined,
    port: /^\d+$/.test(port.trim()) && +port >= 1 && +port <= 65535 ? undefined : LISTENER_ERR.port,
    src: allowBad ? LISTENER_ERR.src : undefined,
  });
  const invalid = $derived(Object.values(errors).some((e) => e !== undefined));
  const dirty = $derived(bind !== init.bind || port !== init.port || enabled !== init.enabled || pool !== init.pool
    || allow.split('\n').map((l) => l.trim()).join('\n') !== init.allow);

  const save = (): void => {
    if (model === undefined) return;
    const edit: ListenerEdit = {
      bind: bind.trim(), port: Number(port), enabled, sourceAllow: parseSourceAllow(allow),
      ...(hasPool && pool !== '' ? { defaultAction: { pool } } : {}),
    };
    const [op] = editListenerPatch(model, edit);
    if (op === undefined) return;
    saving = true;
    void desk.putResource('listener', key, op.body).then((ok) => { saving = false; after()(ok); });
  };
  const revert = (): void => {
    bind = init.bind; port = init.port; enabled = init.enabled; pool = init.pool; allow = init.allow; gen += 1;
  };
</script>

{#if model !== undefined}
  <InlineEdit {dirty} {invalid} {pending} {saving} {detailHref} onsave={save} onrevert={revert}>
    <FormSection title="기본">
      <BindField id="li-bind" bind:bind />
      <FormRow label="포트" for="li-port" error={errors.port}>
        <TextInput id="li-port" bind:value={port} invalid={errors.port !== undefined} inputmode="numeric" />
      </FormRow>
      <FormRow label="활성화"><Switch bind:checked={enabled}>{enabled ? '켜짐' : '꺼짐'}</Switch></FormRow>
    </FormSection>
    {#if hasPool}
      <FormSection title="동작">
        <FormRow label="기본 풀"><Select label="기본 풀" bind:value={pool} options={pools} width="100%" /></FormRow>
      </FormSection>
    {/if}
    <FormSection title="접근 제한">
      <FormRow label="출발지 제한" error={errors.src} help={noSrc ? 'PROXY protocol을 쓰면 출발지 제한을 쓸 수 없어요.' : srcHelp(isHttp)}>
        {#key gen}<SourceRows label="출발지 제한" bind:value={allow} bind:invalid={allowBad} disabled={noSrc} />{/key}
      </FormRow>
    </FormSection>
  </InlineEdit>
{/if}
