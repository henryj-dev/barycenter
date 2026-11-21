/**
 * 운영 › 지표 (2026-11-21) — `/api/v1/metrics` 의 Prometheus 텍스트를 화면이 읽는 모양으로.
 *
 * **해석은 여기 한 곳이다.** 화면(Svelte)은 이 모듈이 낸 묶음을 그리기만 한다. 서버의 지표 이름을 바꾸면
 * 여기와 테스트가 함께 깨진다.
 *
 * 카운터는 라벨을 이름에 접어 넣는다(`src/obs/metrics.ts` 의 `count('bary_apply_total{phase="activated"}')`).
 * 그래서 `# TYPE` 줄의 이름에도 라벨이 붙어 온다 — 계열 이름은 `{` 앞까지다.
 */

export type MetricType = 'gauge' | 'counter' | 'untyped';
export type MetricSample = { labels: Record<string, string>; value: number };
export type MetricFamily = { name: string; type: MetricType; help?: string; samples: MetricSample[] };

/** 화면의 묶음. 순서가 화면 순서다. */
export const METRIC_AREAS = [
  { key: 'apply', label: '적용', prefixes: ['bary_apply_', 'bary_pending_apply', 'bary_unfinished_transitions', 'bary_config_head_revision', 'bary_membership_'] },
  { key: 'health', label: '헬스', prefixes: ['bary_backends_', 'bary_health_'] },
  { key: 'acme', label: 'ACME · 인증서', prefixes: ['bary_acme_', 'bary_certificate_'] },
  { key: 'discovery', label: '디스커버리', prefixes: ['bary_discovery_'] },
  { key: 'addressSets', label: '주소 집합', prefixes: ['bary_address_set_'] },
  { key: 'notify', label: '알림 · 메일', prefixes: ['bary_notify_', 'bary_mail_'] },
  { key: 'cluster', label: '클러스터 · 리더', prefixes: ['bary_cluster_', 'bary_leader', 'bary_activation_epoch_'] },
  { key: 'generations', label: '세대 · 저장', prefixes: ['bary_generation', 'bary_agent_state_'] },
  { key: 'auth', label: '인증', prefixes: ['bary_auth_', 'bary_api_plaintext_exposed'] },
  { key: 'process', label: '프로세스', prefixes: ['bary_uptime_', 'bary_process_', 'process_', 'nodejs_'] },
] as const;

export type MetricAreaKey = (typeof METRIC_AREAS)[number]['key'] | 'other';
export type MetricArea = { key: MetricAreaKey; label: string; families: MetricFamily[] };

/**
 * 카운터는 서버가 HELP 를 내지 않는다. 화면에 보일 한 줄 설명. 게이지는 서버의 HELP 를 그대로 쓴다.
 */
export const COUNTER_HELP: Readonly<Record<string, string>> = {
  bary_apply_total: '적용이 어느 단계에서 끝났는지 센다',
  bary_membership_apply_total: '멤버십(백엔드 목록)을 엔진에 넣은 횟수',
  bary_membership_project_total: '헬스 · 드레인을 멤버십에 반영한 횟수',
  bary_health_transition_total: '백엔드 판정이 바뀐 횟수',
  bary_acme_orders_total: 'ACME 주문이 상태를 옮긴 횟수',
  bary_acme_dns01_total: 'DNS-01 레코드를 놓거나 치운 횟수',
  bary_acme_publish_total: '발급한 인증서를 설정에 올린 결과',
  bary_acme_cleanup_total: '끝난 챌린지를 치운 결과',
  bary_discovery_change_total: '디스커버리가 백엔드 목록을 바꾼 횟수',
  bary_discovery_failure_total: '디스커버리 출처를 못 읽은 횟수(이유별)',
  bary_address_set_refresh_total: '주소 집합을 다시 받은 결과',
  bary_notify_total: '알림을 보낸 결과(통로 · 결과별)',
  bary_mail_total: '메일을 보낸 결과',
  bary_cluster_follow_total: '팔로워가 리더를 따라간 결과',
  bary_cluster_follow_audit_failed_total: '팔로워가 따라간 기록을 남기지 못한 횟수',
  bary_auth_failures_total: '인증 실패 횟수',
  bary_auth_limit_store_errors_total: '인증 제한 저장소 오류 횟수',
};

/** `name{a="1",b="x"}` 의 라벨. 값의 `\"` · `\\` · `\n` 을 푼다. */
function parseLabels(src: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([A-Za-z_][A-Za-z0-9_]*)="((?:[^"\\]|\\.)*)"/g;
  for (const m of src.matchAll(re)) {
    out[m[1]!] = m[2]!.replace(/\\(["\\n])/g, (_x, c: string) => (c === 'n' ? '\n' : c));
  }
  return out;
}

const baseOf = (name: string): string => {
  const i = name.indexOf('{');
  return i < 0 ? name : name.slice(0, i);
};

function parseValue(s: string): number | undefined {
  if (s === '+Inf') return Infinity;
  if (s === '-Inf') return -Infinity;
  if (s === 'NaN') return NaN;
  const v = Number(s);
  return Number.isFinite(v) ? v : undefined;
}

/** Prometheus 텍스트 형식(0.0.4)을 계열로. 모르는 줄은 건너뛴다 — 화면 하나 때문에 지표 전체가 안 보이지 않게. */
export function parseMetrics(text: string): MetricFamily[] {
  const fams = new Map<string, MetricFamily>();
  const fam = (name: string): MetricFamily => {
    let f = fams.get(name);
    if (f === undefined) {
      f = { name, type: 'untyped', samples: [] };
      fams.set(name, f);
    }
    return f;
  };
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '') continue;
    if (line.startsWith('#')) {
      const m = /^#\s+(HELP|TYPE)\s+(\S+)\s*(.*)$/.exec(line);
      if (m === null) continue;
      const f = fam(baseOf(m[2]!));
      if (m[1] === 'HELP') f.help = m[3]!;
      else if (m[3] === 'gauge' || m[3] === 'counter') f.type = m[3];
      continue;
    }
    const m = /^([A-Za-z_:][A-Za-z0-9_:]*)(\{.*\})?\s+(\S+)(?:\s+\d+)?$/.exec(line);
    if (m === null) continue;
    const value = parseValue(m[3]!);
    if (value === undefined) continue;
    fam(m[1]!).samples.push({ labels: m[2] === undefined ? {} : parseLabels(m[2].slice(1, -1)), value });
  }
  for (const f of fams.values()) {
    const help = COUNTER_HELP[f.name];
    if (f.help === undefined && help !== undefined) f.help = help;
  }
  return [...fams.values()].filter((f) => f.samples.length > 0);
}

/** 계열을 화면 묶음으로. 어느 묶음에도 안 맞으면 「그 밖」 이다. 빈 묶음은 내지 않는다. */
export function groupMetrics(families: readonly MetricFamily[]): MetricArea[] {
  const areaOf = (name: string): MetricAreaKey =>
    METRIC_AREAS.find((a) => a.prefixes.some((p) => name.startsWith(p)))?.key ?? 'other';
  const out: MetricArea[] = [
    ...METRIC_AREAS.map((a) => ({ key: a.key as MetricAreaKey, label: a.label, families: [] as MetricFamily[] })),
    { key: 'other', label: '그 밖', families: [] },
  ];
  for (const f of families) out.find((a) => a.key === areaOf(f.name))!.families.push(f);
  for (const a of out) a.families.sort((x, y) => (x.name < y.name ? -1 : 1));
  return out.filter((a) => a.families.length > 0);
}

/** 표본 하나를 시계열로 쌓을 때의 열쇠 — 이름과 라벨을 정렬해 붙인다. */
export function sampleKey(name: string, labels: Record<string, string>): string {
  const ls = Object.entries(labels).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}=${JSON.stringify(v)}`);
  return ls.length === 0 ? name : `${name}{${ls.join(',')}}`;
}

/** 라벨을 한 줄로 — 화면의 작은 글씨. 없으면 빈 글자. */
export function labelText(labels: Record<string, string>): string {
  return Object.entries(labels).map(([k, v]) => `${k}=${v}`).join(' · ');
}

/** 값을 사람이 읽는 글자로. 단위는 이름이 말한다(`_bytes` · `_seconds`). */
export function formatMetric(name: string, value: number): string {
  if (!Number.isFinite(value)) return String(value);
  if (name.endsWith('_bytes')) {
    const u = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
    let v = value;
    let i = 0;
    while (Math.abs(v) >= 1024 && i < u.length - 1) { v /= 1024; i += 1; }
    return `${i === 0 ? v.toFixed(0) : v.toFixed(1)} ${u[i]}`;
  }
  if (name.endsWith('_seconds')) {
    const a = Math.abs(value);
    if (a >= 86400) return `${(value / 86400).toFixed(1)}일`;
    if (a >= 3600) return `${(value / 3600).toFixed(1)}시간`;
    if (a >= 60) return `${(value / 60).toFixed(1)}분`;
    return `${value.toFixed(value % 1 === 0 ? 0 : 1)}초`;
  }
  return Number.isInteger(value) ? value.toLocaleString('en-US') : value.toFixed(3);
}

/**
 * 화면이 열려 있는 동안의 짧은 기록. 열쇠마다 마지막 `cap` 개만 남긴다. 읽은 시각을 함께 둔다 — 카운터의
 * 증가율(초당)을 셀 때 쓴다. 엔진이나 데몬이 다시 떠서 카운터가 줄면 그 칸은 증가율을 내지 않는다.
 */
export type MetricHistory = Map<string, { at: number; value: number }[]>;

export function pushHistory(history: MetricHistory, at: number, families: readonly MetricFamily[], cap = 60): void {
  for (const f of families) {
    for (const s of f.samples) {
      const k = sampleKey(f.name, s.labels);
      const list = history.get(k) ?? [];
      list.push({ at, value: s.value });
      if (list.length > cap) list.splice(0, list.length - cap);
      history.set(k, list);
    }
  }
}

/** 카운터의 마지막 두 표본 사이 초당 증가. 줄었거나(다시 뜸) 표본이 하나면 `undefined`. */
export function counterRate(points: readonly { at: number; value: number }[] | undefined): number | undefined {
  if (points === undefined || points.length < 2) return undefined;
  const a = points[points.length - 2]!;
  const b = points[points.length - 1]!;
  const dt = (b.at - a.at) / 1000;
  if (dt <= 0 || b.value < a.value) return undefined;
  return (b.value - a.value) / dt;
}
