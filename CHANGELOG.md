# Changelog

All notable changes to barycenter are summarised here for people deciding whether to upgrade.
This is a human-written summary, not a git log; every entry links to the pull request or design
section that has the details.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Releases will use
[Semantic Versioning](https://semver.org/) tags (`vX.Y.Z`), cut by
[`.github/workflows/release.yml`](./.github/workflows/release.yml).

**Only pre-releases exist so far.** The API and database schema are not frozen
([DESIGN.md §9.1.1](./DESIGN.md)), so `0.x` and `-alpha` releases may still change shape. Each
release section lists every publicly known vulnerability it fixes.

## [Unreleased]

- **운영 › 백업·복원** (`/ops/backup`) is a new GUI screen: download the spec-only manifest of any
  revision, download a backup bundle, import a file (merge, or replace which deletes resources not in
  the file), and restore a backup (admin, step-up, type `복원` to confirm). Import and restore are
  **previewed first**: `POST /api/v1/config/import` accepts `{ manifest, mode, preview: true }` and
  returns `changes` (added / changed / removed per resource) and the plan `impact` without committing
  — it runs the same changeset and plan path and discards the changeset. Import and `POST /restore`
  accept `base_revision`; if head moved since the preview they answer `409 head_moved`. Results now
  include `changes`. CLI: `bary import <file> --preview`, `bary restore <file> --preview`. These paths
  stay region-only — global mode does not relay them (`LOCAL_ONLY_PATHS`), so one region's whole
  config never passes through the global view; the screen shows **이 지역에서 열기 ↗** there.
- Saving no longer throws away a change that lost a race. If someone else committed first (the plan is
  stale), another person changed the same changeset (412), or the server failed, the GUI keeps the
  changeset as a **draft** and says where to find it; only invalid content is discarded. The new screen
  **변경 › 초안** (`/change/drafts`) lists open and sealed changesets (`GET /api/v1/changesets`, relayed in
  global mode), shows what each would change, plans it, commits it, reopens or discards it. A draft whose
  base is no longer head gets **최신 head 로 다시 계획**: the same patch is planned again on the current head.
  **JSON 으로 고치기** has **초안으로 두기** to save a draft on purpose. `GET /changesets/:id` also carries the
  ETag in the body, because the global relay does not forward response headers. CLI:
  `bary changeset list [--state open|sealed]`, `bary get changesets`.
- New screen **운영 › 작업** (`/ops/operation`) lists recent operations from apply, rollback and re-render
  (`GET /api/v1/operations`, relayed), with phase, planes, who and when. An unfinished one can be cancelled
  with **작업 취소…** (confirmation required): reserved slots are released and the transition is closed as
  failed; the active generation and traffic do not change. The status screen's unfinished-transition banner
  links to it. `GET /operations/:id` now also returns `createdAt`, `updatedAt`, `createdBy` and `terminal`.
  CLI: `bary get operations`.
- TCP pools can now have a health check. The GUI already showed the editor for TCP pools, but saving
  was rejected because the validator (and a database CHECK) allowed health checks on HTTP pools only.
  The prober has always honoured the plan for TCP pools (mode, port, probe address, interval, timeout,
  rise, fall, and an HTTP health port per §4.3.1). Migration `037_pool_healthcheck_tcp` relaxes the
  CHECK to "not UDP" on PostgreSQL, MySQL/MariaDB and SQLite. UDP pools still cannot have one.
- Restarting `barycenterd` no longer logs one `prober.failed` / `api.internal`
  (`Cannot use a pool after calling end`) line from the old process. Shutdown now waits up to 5 s for the
  running probe sweep, ACME tick and in-flight API requests before it closes the database.
- The GUI is now type-checked: `cd gui && npm run check` runs `svelte-check`, and `verify.sh` runs it.
  The `#lib` alias and `.ts` imports were not wired for the checker (676 reported errors); 12 real type
  errors are fixed without changing behaviour.
- The GUI now shows several things the API already had:
  - **Drain progress** on the backend page: new connections blocked / fully drained / deadline
    passed, in-flight requests and sessions when the engine reports them, who started the drain,
    when, and the deadline. You can pick a deadline (5 min – 4 h) when you drain. The backends
    list marks drains whose deadline has passed. `GET /api/v1/backends/:id/drain-status` now also
    returns `started_at`, `started_by` and `deadline_at`, and `GET /api/v1/backends/status` rows
    carry `drain { startedAt, startedBy, deadlineAt?, deadlineExceeded }` while draining.
  - **ACME challenges** in the certificate's ACME box: click an order to see each challenge's
    domain, type, and when it was placed and cleaned. Challenge bodies now include `placedAt` /
    `cleanedAt`; tokens are still never returned.
  - New screens: **운영 › 소켓** (every socket the config occupies, with shared sockets and
    wildcard overlaps marked), **운영 › 백엔드 출처** (discovery state of every pool), and
    **TLS › ACME 계정** (accounts, CA, registration, and which certificates use them).
  - Global mode relays drain status, ACME challenges and the all-pool discovery view.
- **Rerender and apply after upgrading** — these change the rendered nginx config (OpenResty).
  - Failed requests no longer leak the per-backend in-flight count. When nginx could not reach a
    backend, it made a 502/504 and jumped to the error page, which cleared `ngx.ctx`; the counter
    kept one in-flight request per failure. That skewed `least_conn`, tripped soft connection caps
    early and kept drains from ever reaching "quiesced". Pool traffic counters also missed those
    requests. The chosen peers now live in nginx variables, which survive the jump.
  - A listener's default action now forwards WebSocket upgrades (`Upgrade` / `Connection`) and
    pins `proxy_http_version 1.1`. Before, WebSockets only worked through routes with
    `websocket: true`. Requests that do not ask for an upgrade are sent as before.
  - Responses that came from a backend carry `X-Bary-Upstream-Status` (needs headers-more), and
    barycenter's own error page adds an `Upstream 502` line (JSON: `upstream_status`) when the
    error happened while talking to the backend. Errors barycenter made without a backend (no
    route, source denied) show neither. Since every response says `Server: barycenter`, a
    backend's own 500 used to look like barycenter's.

- Global mode now relays traffic statistics (`GET /api/v1/regions/<region>/traffic` and
  `/traffic/<kind>/<key>`). The paths were on the relay allow-list but had no global route, so the
  traffic graphs answered 404 in global mode. A test now checks that the relay allow-list and the
  global routes match one to one.
- Notification settings now live in the config database and are edited in the GUI under **관리 › 알림**
  (`/admin/notify`). Channels (webhook, Slack, mail) can be added, changed, disabled, deleted, filtered by event kind and
  minimum severity, and tested with **시험 전송**; common values (repeat interval, certificate warning days, check
  interval, queue size) are editable too. Changes apply at once on every node, without a restart. A delivery log records
  each send, test, and queue drop for 30 days (`BARY_NOTIFY_DELIVERY_RETENTION_DAYS`); secret values in failure reasons
  are masked. Webhook signing secrets and Slack webhook URLs go into the secret store as a new `opaque://` scheme and are
  never shown again. On first start the daemon copies the existing `BARY_NOTIFY_*` settings into the database; after
  that the database wins and differing environment values are logged as `notify.env_ignored`. API: `GET /api/v1/notify`,
  `PUT /api/v1/notify/settings`, `PUT|DELETE /api/v1/notify/channels/:name`, `POST /api/v1/notify/channels/:name/test`,
  `GET /api/v1/notify/deliveries` (all `admin`; secret writes and deletes need a fresh MFA step-up). CLI:
  `bary get notify`, `bary get notify/deliveries`. Migrations 035 (secret store `opaque` scheme) and 036 (notify tables)
  run on PostgreSQL, MySQL/MariaDB and SQLite. Notify settings are per region and are not relayed by the global view.
- The status screen has a **저장소** panel, and `GET /api/v1/system/storage` (read scope; relayed in
  global mode; `bary get system/storage`) reports it: the config and accounts database kinds and the
  config server version, the secret store driver (files or encrypted in the database, and whether a
  KEK is set — never its value), the retention window of each table (or "kept forever"), and the
  last database, generation and secret clean-up results. Clean-ups run only on the leader, so a
  follower says it has no result instead of reporting zero. No DSN, host or key material is returned.
- Pools with a backend source can be re-queried on demand: `POST /api/v1/pools/:id/discovery/refresh`,
  **지금 다시 찾기** in the pool's 「출처에서 받은 백엔드」 box, and `bary pool discovery-refresh <pool>`.
  It runs the same handling as the periodic round (events, metrics, membership projection), never
  creates a revision, and is audited as `discovery.refresh`. A source failure answers 502 with the pool
  state; the last good list stays in use.
- Global mode now relays three region endpoints the GUI already called, which answered 404 there:
  `GET pools/:id/discovery`, `GET address-sets/refresh-status` and `POST address-sets/:id/refresh`.
  A test now checks that every region API path in the GUI source is on the relay allow-list.
- Fields that could only be changed with **JSON 으로 고치기** or a raw patch now have form controls:
  listener rate-limit zone size (`zoneKb`), backend `softMaxConns` and `isBackup` (blocked for
  hash pools), SNI binding TLS version override, HSTS `preload` (requires max-age ≥ 1 year and
  include-subdomains), and per-source-rule request headers and path rewrite (the route form no
  longer blocks saving when a rule has them). Creating a listener can now set the real-IP source,
  PROXY protocol on TCP and passthrough, and the passthrough preread timeout. The route-group form
  takes a priority for every route it creates.
- New **엔진 설정** screen under 운영 (`/ops/engine`) edits the engine settings
  (`workerShutdownTimeoutS`, `membershipDictKb`, `acmeDictKb`) through a normal changeset. New read
  endpoint `GET /api/v1/engine`, relayed in global mode.
- Pool and backend overview pages now show **헬스 기록**: every time the health verdict flipped,
  newest first, with the previous and new state and what the prober reported, 20 at a time with
  **더 보기**. A pool lists its own backends and the ones it discovered. The data was already kept in
  `health_events` (30 days by default) but nothing read it. New read endpoints
  `GET /api/v1/backends/:id/health-history` and `GET /api/v1/pools/:id/health-history`
  (`?limit=` 1–200, `?before=` cursor), relayed in global mode; CLI
  `bary get backends/<id>/health-history` and `bary get pools/<id>/health-history`.
- **Traffic statistics.** On OpenResty, the engine now counts requests (connections for TCP/UDP),
  status classes (1xx–5xx), bytes in/out and time per listener, HTTP route, passthrough route,
  pool and backend, in a separate `lua_shared_dict` (`bary_http_traffic` · `bary_stream_traffic`,
  2m each). The daemon reads the counters every 10 s (`BARY_TRAFFIC_INTERVAL_MS`) and keeps the
  last hour in memory, per node. New read endpoints `GET /api/v1/traffic[?kind=]` and
  `GET /api/v1/traffic/:kind/:id` (also relayed in global mode) and `bary get traffic[/<kind>[/<name>]]`.
  The GUI shows **실시간 트래픽** charts on the traffic tab of listeners, routes and pools, the
  numbers on the backend overview, and **리스너별 트래픽** on the dashboard. Plain nginx answers
  `unsupported` and renders exactly as before. **Upgrading changes the rendered config on
  OpenResty**, so run **다시 렌더** (`POST /api/v1/apply/rerender`) and apply once to start counting.
- ACME orders can be retried or renewed by hand. `POST /api/v1/certificates/:id/acme/retry` clears the
  backoff of a failed order (and resets its attempt count), or opens a new order when the last one was
  abandoned. `POST /api/v1/certificates/:id/acme/renew` opens a new order even when the certificate is not
  due; it answers 409 `order_live` when an order is in progress. Both need `write`, run on the leader, are
  audited as `acme.order.retry` / `acme.order.renew`, and are relayed in global mode. The certificate
  overview shows **지금 다시 시도** and **지금 갱신…**, and the next retry time of a failed order
  (`nextAttemptAt` in `GET /api/v1/acme/orders`). The CLI has `bary certificate retry <name>` and
  `bary certificate renew <name>`.
- **Abandoned ACME orders now stay stopped.** Before, the next renewal tick opened a new order for the same
  certificate, so "abandoned" restarted the 8 attempts without anyone fixing the cause. Now no new order is
  opened while the last order is abandoned and the account and domains are unchanged; a manual retry or a
  changed intent starts again.
- When the CA marks an order `invalid`, the next attempt now places a **new CA order**. Before, retries
  polled the same invalid order until the order was abandoned. A re-placed challenge after a cleaned one
  is tracked again by the orphan scan.
- Pool and backend overview pages now show **정상이 아닌 이유** when something is wrong: for a pool,
  each backend that is not healthy or not receiving traffic, with its reason; for a backend, its own
  reasons. Health-check failures say which check ran, when it was last observed, and what the
  prober reported.
- Health-probe reasons now say what was probed and how to fix common failures, e.g.
  `GET http://10.0.0.5:8080/ (Host: app.example) 가 302 로 답했다 — 2xx 를 기대한다. 리다이렉트는 따라가지 않는다 — …`
  (was `302 다 (2xx 가 아니다)`). 3xx, 401/403 and 404 get a hint; connection errors and timeouts
  name the address.
- Resources can be renamed. A changeset patch accepts `{ "op": "rename", "kind", "key", "to" }`;
  the GUI shows **이름 바꾸기…** on every detail page, and the CLI has
  `bary rename <kind> <old> <new>`. Everything that refers to the resource follows the new name:
  ID-linked references, name references inside JSON (route source rules, `@address-set` lists,
  upstream CA bundles), and backend health and drain state. The plan lists the renames and compares
  against the renamed previous model, so a renamed listener is not shown as removed and added.
  Applying renders new nginx names, which makes a new generation; connections are not dropped.
- Resource names (backends, pools, listeners, routes, certificates, TLS policies, SNI bindings,
  address sets, ACME accounts) may now join segments with `:` and be up to 127 characters, for
  naming schemes such as `{host}:{service}[:{detail}][:{shard}]`
  (e.g. `web-01.dc1:shop:api:01`). Each segment still starts with a letter or
  digit and uses only letters, digits, `.`, `_` and `-`. Migration `034_key_segments` widens the
  database checks on PostgreSQL, SQLite and MySQL/MariaDB; existing names are unaffected.
- Names that barycenter derives itself now use `~` so they cannot collide with yours: the plain
  HTTP redirect socket of an HTTPS listener is `<listener>~http` (was `<listener>:http`) and a
  discovered backend is `disc~<pool>~<host>~<port>`. An HTTPS listener with both an HTTP redirect and a
  source allow-list renders a new nginx variable name, so the next apply makes a new generation.
- CLI: in `--source-rule`, the WebSocket flag is now `pool:<pool>,ws`. The old `pool:<pool>:ws`
  still works when the pool name has no `:`.
- The development line on `main` is versioned `0.1.0-dev` again; only tagged releases carry a
  release version.

## [0.1.0-alpha.1] - 2026-11-15

First pre-release. The release workflow builds the bundle from this tag and attaches build
provenance (`gh attestation verify <file> --repo henryj-dev/barycenter`).

### Upgrade impact

- The `Server` response header now reads `barycenter/<version>` (was `openresty/<version>`), and the
  version line is `0.1.0-alpha.1` (was `0.0.0`, then `0.1.0-dev`).
- The daemon applies database migrations at start-up; the newest are `031_route_path_prefixes.sql` and
  `032_route_source_rules.sql` (additive, no data rewrite).
- `deploy/install.sh` now installs `barycenterd.socket` (systemd socket activation) next to the
  service. Re-run the installer once so the API port is held by systemd across daemon restarts.
- The engine (nginx/OpenResty) runs as its own systemd unit, so restarting the daemon no longer
  stops traffic (#122, #123).
- Requests over a listener's rate limit (`limit_req`) or connection limit (`limit_conn`) now get
  **429 Too Many Requests** with `Retry-After: 1` and the engine error page, not nginx's default 503.
  If your monitoring counts 503 to detect rate limiting, count 429 instead; 503 now means only
  engine or backend trouble (DESIGN.md §4.10).
- The rendered config gains the `X-Served-By` slot (empty unless `BARY_SERVED_BY` is set), so the
  next apply after upgrading writes a new generation and reloads the engine once.

### Added

- **`X-Served-By` response header (opt-in).** Set `BARY_SERVED_BY=<alias>` (or `@hostname`) per node and
  every response carries `X-Served-By: <alias>`; engine error pages show it next to the request ID. Off by
  default. The value lives in a per-node generation fragment, so the rendered config and its digest stay
  identical across nodes (DESIGN.md §4.10). Changing the alias and re-applying (`apply/rerender`) now
  writes a new generation even when the rendered config is unchanged.

- **Routes**
  - One route can match several path prefixes (`pathPrefixes`) (#183).
  - Per-source rules on a route (`sourceRules`): different action (proxy, redirect, reject) by
    client address range or address set, matched on the visitor address or the raw connection
    address (#183, #184).
  - Route groups: create several routes for one host from one screen, one per path (#183).
  - Request header rewriting and path-prefix stripping on proxy routes (#109, #110).
- **Listeners**
  - Host-based HTTP/HTTPS listeners (virtual hosts) from the GUI and CLI
    (`listener create --hosts`, `listener update --hosts | --clear-hosts`).
  - Wildcard (`0.0.0.0`) and specific-address listeners can share a port; the specific address
    wins, and hosts on the wildcard listener still answer on that port (#150, #178).
  - Original client IP from an HTTP header (`realIpFromHeader`) for listeners behind a CDN (#71).
- **Pools:** health-check form in the GUI; `route create --source-rule` in the CLI (#184).
- **Accounts:** built-in human accounts with server sessions, invitations and admin TOTP (#84);
  SSO (OIDC) linking with per-provider just-in-time sign-up (#79).
- **Global mode:** `install.sh --mode global` installs a read-mostly global control plane that
  aggregates regions and relays writes (#74, #82).
- **CLI:** `bary proxy create --protocol https` creates an HTTPS listener with policy and
  certificate in one step (#116, #117).
- **Operations:** API socket activation and a short GUI reconnect grace, so the admin screens do
  not fail while the daemon restarts during a deploy (#182).

### Changed

- Certificate-only changes (issuing or renewing a certificate) are applied automatically when
  they do not change traffic, instead of waiting in the apply queue.
- The GUI moved to an app shell (sidebar, top bar, banners, standalone login) and shared detail
  tabs (#126, #129, #132, #138).
- Plans that were already superseded by a newer active revision leave the apply queue (#144).

### Fixed

- After a reload (HUP), one stale answer from an old nginx worker no longer discards an
  activation that was already observed (#185).
- Requests sent to a pool by a listener's default action now carry `X-Forwarded-For`; backends
  used to see every visitor as the nginx address (#163).
- Long listener keys no longer produce nginx variable names over the length limit, which blocked
  apply (#153).
- TLS pools that do not verify certificates default to a `tcp_connect` probe instead of failing
  with an empty pool (#156).
- Sockets that a reload cannot open are reported by the plan and rejected before apply (#159).
- The serving configuration is identified by the digest of the plan that produced it, so a
  re-render no longer stops after moving only membership (#166).
- The global GUI no longer reconnects to the live stream in a loop before a region is chosen
  (#169).
- Installs from an archive (not a git checkout) know their version from `.commit` (#172).
- Login no longer leaves the browser on the login screen (#135); fonts and favicon no longer trip
  the content security policy (#141).

### Security

- No publicly known vulnerabilities are fixed in this release (no published advisories).

- Account passwords are hashed with scrypt and a per-user salt; tokens and secrets are compared in
  constant time.
- Stored secrets use envelope encryption (AES-256-GCM) in PostgreSQL, with a pluggable key
  encryption key source and a rotation script (#19, #38, #41).
- Failed authentication is rate-limited with back-off and `429`.
- The control API can serve TLS; private keys never travel in plain text in patches.
- Every pull request runs CodeQL, gitleaks and OpenSSF Scorecard; property-based fuzzing covers
  the model decoder and the renderer (#187).

## Foundations (2026-08-11 – 2026-10)

Built before this changelog existed; see the [Roadmap](./README.md#roadmap) and
[`STATUS.md`](./STATUS.md) for detail.

- **v0.1** Typed model, sealed changesets, apply state machine with proven activation, data-plane
  agent, nginx renderer.
- **v0.2** Pools and load-balancing algorithms, TCP/UDP listeners, SNI pass-through.
- **v0.3** Lua membership plane (backends change without reload), health probes, draining.
- **v0.4** `bary` CLI with export/import and changeset steps.
- **v0.5** Web GUI with live updates over SSE.
- **v0.6** TLS termination, ACME http-01 and dns-01 with renewal, certificate rollback.
- **v0.7** Driver loader, reference kit, boot pins.

[Unreleased]: https://github.com/henryj-dev/barycenter/compare/v0.1.0-alpha.1...main
[0.1.0-alpha.1]: https://github.com/henryj-dev/barycenter/releases/tag/v0.1.0-alpha.1
