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
