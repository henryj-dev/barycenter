<script lang="ts">
  /**
   * 엔진 설정 (2026-11-20) — 모델 `engine` 의 세 칸: 워커 종료 대기 · 멤버십 공유 메모리 · ACME 공유 메모리.
   *
   * 읽기는 `GET /api/v1/engine`(전역이면 고른 지역으로 중계된다), 쓰기는 다른 리소스처럼 changeset 의 `put engine` 이다 —
   * 저장은 커밋이고, 적용은 적용 대기 화면에서 한다. 칸을 비우면 렌더러의 기본값이다.
   * 쓸 수 없으면(팔로워 · 연락 없음 · 전체 합산) `SettingsFrame` 이 읽기 구획을 그린다. 전체 합산이면 읽을 지역이 없다 — 고르라고 한다.
   */
  import { getContext } from 'svelte';
  import { ENGINE_LIMITS, engineBody, engineErrors, engineFormOf, type EngineForm } from '@web/engine-settings';
  import { FieldMessage, FormRow, FormSection, Skeleton, TextInput } from '#lib/ui';
  import { after } from '#lib/after';
  import WriteNote from '#lib/global/WriteNote.svelte';
  import SettingsFrame, { sameBody } from '#lib/detail/SettingsFrame.svelte';
  import type { ViewSection } from '#lib/detail/view-secs';
  import type { Scope } from '#lib/global/scope.svelte.ts';
  import type { createDesk } from '#lib/desk.svelte.ts';

  const desk = getContext<ReturnType<typeof createDesk>>('desk');
  const scope = getContext<Scope | undefined>('scope');
  const aggregate = $derived(scope?.mode === 'global' && scope.region === undefined);
  const L = ENGINE_LIMITS;

  let settings = $state<Record<string, unknown> | undefined>();
  let failed = $state(false);
  let f = $state<EngineForm>({ shutdown: '', membership: '', acme: '' });
  let init = $state<EngineForm>({ shutdown: '', membership: '', acme: '' });
  // head 가 바뀌면 다시 읽는다. 입력 중이면(바꾼 칸이 있으면) 칸은 덮지 않는다.
  $effect(() => {
    void desk.head;
    if (!desk.live || aggregate) return;
    void desk.engineSettings().then((s) => {
      failed = s === undefined;
      if (s === undefined) return;
      const next = engineFormOf(s);
      const editing = !sameBody(f, init);
      settings = s;
      init = next;
      if (!editing) f = { ...next };
    });
  });

  const errors = $derived(engineErrors(f));
  const invalid = $derived(Object.keys(errors).length > 0);
  const dirty = $derived(!sameBody(engineBody(f), engineBody(init)));
  const save = (): void => {
    void desk.putEngine(engineBody(f)).then((ok) => {
      if (ok) init = { ...f };
      after('/ops/engine', '엔진 설정을 커밋했어요')(ok);
    });
  };
  const shown = (v: string, def: string): string => (v.trim() === '' ? def : v.trim());
  const view = $derived<ViewSection[]>([{ t: '엔진', f: [
    { l: '워커 종료 대기', v: f.shutdown.trim() === '' ? '무한 (기본)' : `${f.shutdown.trim()} s`, mono: true },
    { l: '멤버십 공유 메모리', v: `${shown(f.membership, `${L.membershipDictKb.def} (기본)`)} KB`, mono: true },
    { l: 'ACME 공유 메모리', v: `${shown(f.acme, `${L.acmeDictKb.def} (기본)`)} KB`, mono: true },
  ] }]);
</script>

{#if aggregate}
  <WriteNote />
{:else if failed}
  <FieldMessage tone="error">엔진 설정을 읽지 못했어요. 연결을 확인하고 다시 열어요.</FieldMessage>
{:else if settings === undefined}
  <Skeleton height="160px" />
{:else}
  <SettingsFrame {view} {dirty} {invalid} pending={false} onsave={save} onrevert={() => { f = { ...init }; }}>
    <FormSection title="워커">
      <FormRow label="워커 종료 대기" for="en-shutdown" error={errors.shutdown}
        help={`reload 뒤 옛 워커를 기다리는 시간이에요(${L.workerShutdownTimeoutS.min}–${L.workerShutdownTimeoutS.max}초). 비우면 무한이에요. ▲ 시간이 지나면 진행 중인 요청이 응답 없이 끊겨요.`}>
        <TextInput id="en-shutdown" bind:value={f.shutdown} invalid={errors.shutdown !== undefined} inputmode="numeric" placeholder="무한" width="160px" unit="s" />
      </FormRow>
    </FormSection>
    <FormSection title="공유 메모리">
      <FormRow label="멤버십" for="en-membership" error={errors.membership}
        help={`백엔드 슬롯 · 라운드로빈 · 진행 중 연결 수를 세는 곳이에요(${L.membershipDictKb.min}–${L.membershipDictKb.max} KB). 비우면 ${L.membershipDictKb.def} KB 예요. ▲ 차면 그 풀의 요청이 끊겨요. 백엔드가 많으면 늘려요.`}>
        <TextInput id="en-membership" bind:value={f.membership} invalid={errors.membership !== undefined} inputmode="numeric" placeholder={String(L.membershipDictKb.def)} width="160px" unit="KB" />
      </FormRow>
      <FormRow label="ACME" for="en-acme" error={errors.acme}
        help={`HTTP-01 토큰을 두는 곳이에요(${L.acmeDictKb.min}–${L.acmeDictKb.max} KB). 비우면 ${L.acmeDictKb.def} KB 예요.`}>
        <TextInput id="en-acme" bind:value={f.acme} invalid={errors.acme !== undefined} inputmode="numeric" placeholder={String(L.acmeDictKb.def)} width="160px" unit="KB" />
      </FormRow>
    </FormSection>
  </SettingsFrame>
{/if}
