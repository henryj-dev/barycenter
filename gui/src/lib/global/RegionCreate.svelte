<script lang="ts">
  /**
   * 전체 합산의 만들기 버튼 — **어느 지역에 만들지 먼저 고른다**(§1.1, 한 번에 한 지역). 고르면 그 지역으로 좁혀
   * 만들기 화면을 연다(`?region=`). 쓸 수 없는 지역(연락 없음 · 인증 거절 · 팔로워 · 불러오는 중)은 고를 수 없다.
   *
   *   {#snippet create()}<RegionCreate {agg} href="/traffic/backend/new" />{/snippet}
   */
  import { Button, Menu, type MenuItem } from '#lib/ui';
  import type { Aggregate } from './use-aggregate.svelte.ts';

  let { agg, href, label = '＋ 만들기', variant = 'primary' }: {
    agg: Aggregate;
    /** 지역 하나에서 여는 만들기 주소. */
    href: string;
    label?: string;
    variant?: 'primary' | 'secondary';
  } = $props();
  const items = $derived<MenuItem[]>(agg.entries.map((e) => ({
    label: e.writable ? e.name : `${e.name} — 지금은 못 써요`,
    href: agg.href(e.name, href),
    disabled: !e.writable,
  })));
</script>

<Menu {items} label="만들 지역 고르기" header={{ title: '어느 지역에 만들까요?', sub: '한 번에 한 지역에 만들어요.' }}>
  {#snippet trigger({ open, toggle })}
    <Button {variant} aria-haspopup="menu" aria-expanded={open} onclick={toggle}>{label}</Button>
  {/snippet}
</Menu>
