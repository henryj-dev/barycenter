<script lang="ts" module>
  /** 고를 수 있는 CA. 처음에는 스테이징으로 확인하고, 되면 운영으로 바꾼다. */
  export const CAS = [
    { value: 'https://acme-v02.api.letsencrypt.org/directory', label: "Let's Encrypt", hint: '운영' },
    { value: 'https://acme-staging-v02.api.letsencrypt.org/directory', label: "Let's Encrypt 스테이징", hint: '시험용 · 브라우저가 안 믿어요' },
  ] as const;
  export const caLabel = (url: string): string => CAS.find((c) => c.value === url)?.label ?? url;
  /** 스테이징 CA 인가 — 그 인증서는 브라우저가 안 믿는다. */
  export const isStaging = (url: string): boolean => url.includes('staging');
  /** 셀렉트의 「＋ 새 계정」 값. 계정 키 문법(영문 · 숫자로 시작)과 겹치지 않는다. */
  export const NEW_ACCOUNT = '__new';
</script>

<script lang="ts">
  /**
   * ACME 계정 칸 — 콘솔 시안 `fieldsFor('certs')` 의 「ACME 계정」 셀렉트(「이름 · 연락 이메일」 줄 + 「＋ 새 계정」).
   * 「＋ 새 계정」 을 고르면 바로 아래에 「계정 이름」 · 「연락 이메일」 줄이 붙는다(시안 `acct === '__new'`).
   * 인증서 만들기 드로어와 인증서 설정 탭이 같이 쓴다.
   *
   * **계정은 저장할 때 만든다** — 부르는 쪽이 `ensure()` 를 먼저 부른다. 계정 만들기는 설정이 아니라 바로 걸리는 일이다
   * (서버가 계정 키를 만든다, `desk.createAcmeAccount(`). CA 등록은 첫 주문 때 러너가 한다.
   * 시안에 없는 「CA」 줄을 「연락 이메일」 아래에 둔다 — 계정은 CA 하나에 묶이고(디렉터리 주소), 스테이징 · 운영을 골라야 한다.
   * 계정이 없으면 「＋ 새 계정」 만 있고 그것이 골라져 있다.
   */
  import { getContext, onMount } from 'svelte';
  import { FormRow, Select, TextInput } from '#lib/ui';
  import type { AcmeAccountRow, createDesk } from '#lib/desk.svelte.ts';
  import { keyError } from './checks';

  let { account = $bindable(), ready = $bindable(false), changed = $bindable(false), label = 'ACME 계정', prefer, disabled = false }: {
    /** 고른 계정 키. 「＋ 새 계정」 이면 `NEW_ACCOUNT`. */
    account?: string;
    /** 고른 것이 쓸 만한가(새 계정이면 이름 · 이메일이 맞는가) — 부르는 쪽의 「만들기」 · 「저장」 잠금. */
    ready?: boolean;
    /** 처음 값과 다른가(설정 탭의 「바뀐 값」). */
    changed?: boolean;
    label?: string;
    /** 처음 고를 때 이 CA 의 계정을 먼저 고른다. */
    prefer?: 'production' | 'staging';
    disabled?: boolean;
  } = $props();
  const desk = getContext<ReturnType<typeof createDesk>>('desk');

  let accounts = $state<AcmeAccountRow[] | undefined>();
  // svelte-ignore state_referenced_locally
  const first = account;
  let newKey = $state('');
  let newMail = $state('');
  // svelte-ignore state_referenced_locally
  let newCa = $state<string>(prefer === 'production' ? CAS[0].value : CAS[1].value);

  const mail = (a: AcmeAccountRow): string | undefined => a.contact.map((c) => c.replace(/^mailto:/, ''))[0];
  /** 시안: 「이름 · 연락 이메일」. CA 와 등록 여부는 흐린 꼬리(기존 정보). */
  const options = $derived([
    ...(accounts ?? []).map((a) => ({
      value: a.key, label: mail(a) === undefined ? a.key : `${a.key} · ${mail(a)}`,
      hint: [caLabel(a.directoryUrl), a.registered ? undefined : '첫 주문 때 등록'].filter((x) => x !== undefined).join(' · '),
    })),
    { value: NEW_ACCOUNT, label: '＋ 새 계정' },
  ]);
  const adding = $derived(account === NEW_ACCOUNT);
  const keyBad = $derived(newKey.trim() === '' || keyError(newKey) === undefined ? undefined
    : '이름은 영문·숫자로 시작하고 영문, 숫자, 점(.), 밑줄(_), 하이픈(-)만 쓸 수 있어요. 63자까지예요.');
  const mailOk = (v: string): boolean => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v.trim().replace(/^mailto:/, ''));
  const mailBad = $derived(newMail.trim() === '' || mailOk(newMail) ? undefined : 'name@example.com 형식으로 입력해요.');

  $effect(() => { ready = adding ? newKey.trim() !== '' && keyBad === undefined && mailOk(newMail) : account !== undefined; });
  $effect(() => { changed = account !== first; });

  onMount(async () => {
    accounts = await desk.acmeAccounts();
    if (account !== undefined) return;
    const list = accounts ?? [];
    const want = prefer === undefined ? undefined : list.find((a) => (prefer === 'staging') === isStaging(a.directoryUrl));
    account = (want ?? list[0])?.key ?? NEW_ACCOUNT;
  });

  /**
   * 저장 전에 부른다 — 「＋ 새 계정」 이면 계정을 만들고 그 키를, 아니면 고른 키를 돌려준다. 못 만들면 undefined
   * (서버가 거절한 말은 셸의 오류 배너가 보인다).
   */
  export const ensure = async (): Promise<string | undefined> => {
    if (!adding) return account;
    const key = newKey.trim();
    const ok = await desk.createAcmeAccount({ key, directoryUrl: newCa, contact: [`mailto:${newMail.trim().replace(/^mailto:/, '')}`] });
    if (!ok) return undefined;
    accounts = await desk.acmeAccounts();
    account = key;
    return key;
  };
</script>

<FormRow {label}>
  <Select {label} bind:value={account} {options} width="100%" mono={false} disabled={disabled || accounts === undefined} placeholder="계정을 골라요" />
</FormRow>
{#if adding}
  <FormRow label="계정 이름" for="acme-key" error={keyBad}>
    <TextInput id="acme-key" bind:value={newKey} invalid={keyBad !== undefined} autocomplete="off" />
  </FormRow>
  <FormRow label="연락 이메일" for="acme-mail" error={mailBad}>
    <TextInput id="acme-mail" type="email" bind:value={newMail} invalid={mailBad !== undefined} autocomplete="email" />
  </FormRow>
  <FormRow label="CA" help="처음에는 스테이징으로 확인해요. 운영 CA 는 실패가 잦으면 잠시 막아요(속도 제한).">
    <Select label="CA" bind:value={newCa} options={CAS} width="100%" mono={false} />
  </FormRow>
{/if}
