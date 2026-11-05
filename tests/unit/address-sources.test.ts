/**
 * 주소 집합 출처 — 어댑터 다섯 · 레지스트리 · 주기 설정 (2026-11-05).
 *
 * 가짜 응답(fetch 주입)으로 잰다: 거르기(services · regions · family) · 반쪽 목록 거절 · 대역이 아닌 값 거절 ·
 * 상태코드 · http 거절 · 레지스트리(모르는 이름) · 주기 설정(없으면 꺼짐 · 반만 설정 거부).
 */
import { describe, expect, it } from 'vitest';

import {
  AWS_IP_RANGES, CLOUDFLARE_V4, CLOUDFLARE_V6, FASTLY_PUBLIC_IPS, GCP_CLOUD_JSON,
  awsSource, cloudflareSource, fastlySource, gcpSource, urlSource,
} from '../../src/control/address-sources/providers.js';
import { addressSource, addressSourceScheduleFromEnv } from '../../src/control/address-sources/registry.js';
import type { FetchLike } from '../../src/control/sources/fetch.js';

const by = (map: Record<string, Response | (() => Response)>, seen: string[] = []): FetchLike => async (url, init) => {
  seen.push(`${url} ${init.redirect ?? ''}`);
  const r = map[url];
  if (r === undefined) return new Response('', { status: 404 });
  return typeof r === 'function' ? r() : r.clone();
};
const json = (v: unknown): Response => new Response(JSON.stringify(v));

describe('cloudflare', () => {
  it('v4 와 v6 을 둘 다 받는다. family 면 한쪽만 묻는다', async () => {
    const seen: string[] = [];
    const f = by({ [CLOUDFLARE_V4]: new Response('173.245.48.0/20\n103.21.244.0/22\n'), [CLOUDFLARE_V6]: new Response('2400:cb00::/32\n') }, seen);
    expect(await cloudflareSource({ fetch: f }).fetch({})).toEqual({ ok: true, cidrs: ['173.245.48.0/20', '103.21.244.0/22', '2400:cb00::/32'] });
    expect(seen).toEqual([`${CLOUDFLARE_V4} error`, `${CLOUDFLARE_V6} error`]);
    expect(await cloudflareSource({ fetch: f }).fetch({ family: 'ipv6' })).toEqual({ ok: true, cidrs: ['2400:cb00::/32'] });
  });

  it('**하나라도 실패하거나 비면 실패다** — 반쪽 목록으로 바꾸지 않는다', async () => {
    const half = by({ [CLOUDFLARE_V4]: new Response('1.1.1.0/24'), [CLOUDFLARE_V6]: new Response('', { status: 503 }) });
    expect(await cloudflareSource({ fetch: half }).fetch({})).toMatchObject({ ok: false, reason: 'unavailable' });
    const empty = by({ [CLOUDFLARE_V4]: new Response('1.1.1.0/24'), [CLOUDFLARE_V6]: new Response('\n') });
    expect(await cloudflareSource({ fetch: empty }).fetch({})).toMatchObject({ ok: false, reason: 'invalid' });
  });

  it('대역이 아닌 줄이 있으면 그 답 전체가 실패다', async () => {
    const f = by({ [CLOUDFLARE_V4]: new Response('1.1.1.0/24\n<html>'), [CLOUDFLARE_V6]: new Response('2400:cb00::/32') });
    expect(await cloudflareSource({ fetch: f }).fetch({})).toMatchObject({ ok: false, reason: 'invalid' });
  });
});

describe('aws', () => {
  const doc = {
    prefixes: [
      { ip_prefix: '13.32.0.0/15', region: 'GLOBAL', service: 'CLOUDFRONT' },
      { ip_prefix: '13.32.0.0/15', region: 'GLOBAL', service: 'AMAZON' },
      { ip_prefix: '3.34.0.0/15', region: 'ap-northeast-2', service: 'EC2' },
    ],
    ipv6_prefixes: [{ ipv6_prefix: '2600:9000::/28', region: 'GLOBAL', service: 'CLOUDFRONT' }],
  };
  it('services · regions · family 로 거르고 중복을 접는다', async () => {
    const s = awsSource({ fetch: by({ [AWS_IP_RANGES]: json(doc) }) });
    expect(await s.fetch({ services: ['cloudfront'] })).toEqual({ ok: true, cidrs: ['13.32.0.0/15', '2600:9000::/28'] });
    expect(await s.fetch({ regions: ['ap-northeast-2'] })).toEqual({ ok: true, cidrs: ['3.34.0.0/15'] });
    expect(await s.fetch({ family: 'ipv4' })).toEqual({ ok: true, cidrs: ['13.32.0.0/15', '3.34.0.0/15'] });
  });
  it('거른 뒤 비면 실패다(거르기를 틀리게 적었다)', async () => {
    const s = awsSource({ fetch: by({ [AWS_IP_RANGES]: json(doc) }) });
    expect(await s.fetch({ services: ['NOPE'] })).toMatchObject({ ok: false, reason: 'invalid' });
  });
  it('모양이 틀리면 invalid · JSON 이 아니면 invalid', async () => {
    expect(await awsSource({ fetch: by({ [AWS_IP_RANGES]: json({}) }) }).fetch({})).toMatchObject({ ok: false, reason: 'invalid' });
    expect(await awsSource({ fetch: by({ [AWS_IP_RANGES]: new Response('<html>') }) }).fetch({})).toMatchObject({ ok: false, reason: 'invalid' });
  });
});

describe('gcp · fastly', () => {
  it('gcp — service · scope 로 거른다', async () => {
    const s = gcpSource({
      fetch: by({
        [GCP_CLOUD_JSON]: json({
          prefixes: [
            { ipv4Prefix: '34.64.0.0/11', service: 'Google Cloud', scope: 'asia-northeast3' },
            { ipv6Prefix: '2600:1900:4110::/44', service: 'Google Cloud', scope: 'asia-northeast3' },
            { ipv4Prefix: '35.185.0.0/17', service: 'Google Cloud', scope: 'us-east1' },
          ],
        }),
      }),
    });
    expect(await s.fetch({ regions: ['asia-northeast3'] })).toEqual({ ok: true, cidrs: ['34.64.0.0/11', '2600:1900:4110::/44'] });
  });
  it('fastly — addresses · ipv6_addresses', async () => {
    const s = fastlySource({ fetch: by({ [FASTLY_PUBLIC_IPS]: json({ addresses: ['23.235.32.0/20'], ipv6_addresses: ['2a04:4e40::/32'] }) }) });
    expect(await s.fetch({})).toEqual({ ok: true, cidrs: ['23.235.32.0/20', '2a04:4e40::/32'] });
  });
});

describe('url', () => {
  it('한 줄에 하나 — # 뒤는 주석', async () => {
    const s = urlSource({ fetch: by({ 'https://lists.example/ips.txt': new Response('# 사무실\n203.0.113.0/24 # 서울\n\n198.51.100.7\n') }) });
    expect(await s.fetch({ url: 'https://lists.example/ips.txt' })).toEqual({ ok: true, cidrs: ['203.0.113.0/24', '198.51.100.7'] });
  });
  it('jsonPath — 배열은 펼친다', async () => {
    const s = urlSource({ fetch: by({ 'https://lists.example/ips.json': json({ data: { ranges: [{ cidr: '10.0.0.0/8' }, { cidr: '192.0.2.0/24' }] } }) }) });
    expect(await s.fetch({ url: 'https://lists.example/ips.json', jsonPath: 'data.ranges.cidr' }))
      .toEqual({ ok: true, cidrs: ['10.0.0.0/8', '192.0.2.0/24'] });
    expect(await s.fetch({ url: 'https://lists.example/ips.json', jsonPath: 'data.nope' })).toMatchObject({ ok: false, reason: 'invalid' });
  });
  it('http 주소에는 묻지 않는다 · 404 는 not-found', async () => {
    const seen: string[] = [];
    const s = urlSource({ fetch: by({}, seen) });
    expect(await s.fetch({ url: 'http://lists.example/ips.txt' })).toMatchObject({ ok: false, reason: 'insecure' });
    expect(seen).toEqual([]);
    expect(await s.fetch({ url: 'https://lists.example/none' })).toMatchObject({ ok: false, reason: 'not-found' });
  });
});

describe('레지스트리 · 주기 설정', () => {
  it('모르는 이름은 던진다 · 옛 cloudflare 는 그 이름 그대로다', () => {
    expect(() => addressSource('akamai')).toThrow(/모르는 주소 집합 출처/);
    expect(addressSource('cloudflare').kind).toBe('cloudflare');
  });
  it('주기가 없으면 꺼진다 — 지금과 같다', () => {
    expect(addressSourceScheduleFromEnv({})).toEqual({ autoApply: true });
    expect(addressSourceScheduleFromEnv({ BARY_ADDRESS_SOURCE_INTERVAL_MS: '3600000', BARY_ADDRESS_SOURCE_AUTOAPPLY: '0' }))
      .toEqual({ intervalMs: 3_600_000, autoApply: false });
  });
  it('반만 설정 · 틀린 값은 기동을 거부한다', () => {
    expect(() => addressSourceScheduleFromEnv({ BARY_ADDRESS_SOURCE_AUTOAPPLY: '0' })).toThrow(/INTERVAL_MS/);
    expect(() => addressSourceScheduleFromEnv({ BARY_ADDRESS_SOURCE_INTERVAL_MS: '1000' })).toThrow(/60000/);
    expect(() => addressSourceScheduleFromEnv({ BARY_ADDRESS_SOURCE_INTERVAL_MS: '60000', BARY_ADDRESS_SOURCE_AUTOAPPLY: 'yes' })).toThrow(/0 이나 1/);
  });
});
