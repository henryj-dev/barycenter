<div align="center">

<h1>barycenter</h1>

### **A control plane for nginx — HTTP, TCP and UDP reverse proxying and load balancing, managed as a model instead of a pile of config files.**

A change goes through a changeset, gets planned, committed, rendered, published as an
immutable generation, and activated on real nginx — with the activation *proven*
before any coordinate moves.

<br/>

[![verify](https://github.com/henryj-dev/barycenter/actions/workflows/verify.yml/badge.svg)](https://github.com/henryj-dev/barycenter/actions/workflows/verify.yml)
[![codeql](https://github.com/henryj-dev/barycenter/actions/workflows/codeql.yml/badge.svg)](https://github.com/henryj-dev/barycenter/actions/workflows/codeql.yml)
[![scorecard](https://github.com/henryj-dev/barycenter/actions/workflows/scorecard.yml/badge.svg)](https://github.com/henryj-dev/barycenter/actions/workflows/scorecard.yml)

<br/>

![node](https://img.shields.io/badge/node-22%2B-5FA04E?logo=node.js&logoColor=white)
![typescript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)
![postgresql](https://img.shields.io/badge/PostgreSQL-required-336791?logo=postgresql&logoColor=white)
[![license](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

<br/>

> *A barycenter is the common center of mass that bodies in a system actually orbit —
> the point where the whole thing balances.*

</div>

---

## Contents

- [The problem](#the-problem)
- [What it does](#what-it-does)
- [Quick start](#quick-start)
- [How it fits together](#how-it-fits-together)
- [Design principles](#design-principles)
- [Extending it](#extending-it)
- [Stack](#stack)
- [Development](#development)
- [Status & limitations](#status--limitations)
- [Roadmap](#roadmap)
- [License](#license)

---

## The problem

The loose version of the claim — *"if it has a writable GUI, layer 4 is weak"* — is **false**,
and it's worth saying so plainly. Roxy-WI (Apache-2.0) and HAProxy OpenManager (AGPL) both give
you a writable UI over HAProxy with TCP pools, apply and rollback. Zoraxy (AGPL) pairs a
writable UI with TCP/UDP stream proxying.

The narrower claim is the one that holds:

> **No OSS tool offers a writable GUI *and* typed TCP/UDP pools *and* SNI pass-through *and*
> active health checks *and* semantic planning in one product.**

| | Writable GUI | API | CLI | TCP pool | UDP pool | SNI passthrough | Active health | Semantic plan |
|---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| **Nginx Proxy Manager** | ✅ | internal REST | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| **Traefik** | ❌ read-only | ✅ | ~ | ✅ | ✅ | ✅ HostSNI | ✅ TCP | ❌ |
| **HAProxy + Data Plane API** | ❌ (OSS) | ✅ transactional | ✅ | ✅ | Enterprise | ✅ | ✅ | ~ |
| **Roxy-WI / OpenManager** | ✅ | ~ | ~ | ✅ | ❌ | ~ | ✅ | ❌ |
| **Caddy** | ❌ | ✅ ETag/If-Match | ✅ | community L4 | community L4 | community L4 | ~ | ❌ |
| **APISIX** | ~ built-in dashboard | ✅ | ~ | ✅ | ✅ | ✅ | ✅ | ❌ |
| **Nginx UI** | ✅ | ~ | ~ | manual conf | manual conf | manual conf | ❌ | ❌ |
| **Zoraxy** | ✅ | ~ | ❌ | ~ | ~ | ~ | ~ | ❌ |
| **NGINX One / NIM** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ~ (commercial) |

`barycenter` aims at one specific spot: **a writable layer-4 control plane at single-VM scale
— more modelled and safer than Nginx Proxy Manager, smaller than APISIX or NGINX One.**

### What is *not* the moat

API/CLI symmetry and validate-then-rollback are **not** differentiators — the HAProxy Data
Plane API already has transactions and versioning, and Caddy's admin API already has
ETag/If-Match with keep-old-config-on-failure. Anything reproducible from a feature list is
not a moat. The bets that need execution quality instead:

1. **Semantic impact analysis** — `plan` shows *what this save does to which listener's
   sessions*, not just a config diff.
2. **Per-protocol drain observation** — per-peer upstream inflight, TCP connections, and UDP
   pseudo-sessions, surfaced while a backend drains. The moat is the *observation*: v0 does not
   promise to force existing sessions closed (see limitations).
3. **UDP presets** — DNS / WireGuard / game servers need specific
   `proxy_requests` · `proxy_responses` · `proxy_timeout` combinations. Getting them wrong
   fails silently, so validated presets are the value.
4. **Stable-ID GitOps** — export/import keyed on stable scope keys rather than UUIDs, so
   GUI-authored config can actually live in git.
5. **A migration path off Nginx Proxy Manager.**

---

## What it does

- **Domain-based HTTP(S) routing** with full TLS lifecycle management (ACME + uploaded certs).
- **Real TCP/UDP load balancing** — upstream pools, balancing algorithms, and a
  health probe that flips membership without a reload (HTTP GET body for HTTP
  pools, TCP connect for L4). Drain *observation* (inflight / sessions) is
  reported only from a real engine read; otherwise omitted. New traffic can be
  kept off a backend; existing sessions are not forced closed. Not just port forwarding.
- **SNI-based TLS pass-through** on layer 4 (via `ssl_preread`). A missing or unparseable SNI
  is rejected — not configurable — so a client that sends none can never land on an arbitrary
  backend. Only *unmatched* SNI has a configurable fallback.
- **Inbound and backend ports are independent.** `:999 → A:11` and `:888 → B:11` are just two
  listeners pointing at two pools.
- **The API is the only entry point.** The web UI and `bary` CLI are clients of it.
  They are not yet equal: the CLI can create the same resources the GUI writes
  and delete the kinds the GUI withdraws, including pools, stopping at commit.
  `bary get` reads the list endpoints that already exist, including health,
  operations, plans, and metrics. `bary recover` continues a broken transition.
  Changesets can be discarded or reopened. `bary backend drain` excludes a
  backend from membership; drain-status does not invent inflight counts.
  Equality is a v1.0 claim (`DESIGN.md` §1).
- **Nothing is applied blind.** Changes accumulate in a changeset, `plan` reports the impact,
  and apply runs a durable state machine — render → validate on the real data plane → publish →
  reload → verify, with automatic rollback and an explicit failure state when rollback itself fails.

---

## Quick start

Everything below runs from the repository root.

```sh
docker compose -f deploy/docker-compose.yml up -d --build   # PostgreSQL + data plane + demo backend

export BARY_URL=http://127.0.0.1:8088
export BARY_TOKEN=dev-token                    # dev only — see `npm run token`

npm ci && npm run build                        # builds the daemon and the CLI
node dist/bin/bary.js status                   # nothing published yet
node dist/bin/bary.js apply examples/hello.json

curl http://127.0.0.1:8999/                    # → hello from A:11

node dist/bin/bary.js apply examples/l4.json   # TCP :998 and UDP :997 alongside it
node dist/bin/bary.js rollback 1               # roll back to revision 1 — head still moves forward
```

Every listener needs its port published. The compose file maps the three the examples use;
add a line for each new one. Publishing arbitrary ports dynamically is its own problem (§11.3),
which is why the recommended v1 deployment is a dedicated VM with host networking.

`./scripts/quickstart.sh` runs exactly these steps and checks the result, so the instructions
above cannot rot silently.

### Installing on one machine

For that dedicated VM, `deploy/install.sh` does the whole thing on a single host — packages
(OpenResty, Node 22), a non-root service user holding `cap_net_bind_service`, the build, the
service unit, and — optionally — a local PostgreSQL reached over a unix socket, so no password
is written anywhere:

```sh
sudo deploy/install.sh --with-postgres                 # or --dsn postgres://…
sudo deploy/install.sh                                 # a terminal gets asked instead
```

Some of those settings are cheap to change later and one is not: `BARY_SECRET_BACKEND`
decides where certificate private keys live, and the two stores do not know about each other,
so switching after material is uploaded means uploading all of it again.
[`docs/runbook-install.md`](docs/runbook-install.md) is the list of what to decide before the
first run, what to back up on day one, and where to look when it first breaks;
[`docs/runbook-upgrade.md`](docs/runbook-upgrade.md) covers every run after that.

Run it bare on a terminal and it walks through the same settings and shows what it will do
before touching anything; every answer has a flag, and a flag given is never asked about, so
the identical script fits a config-management run. `--env BARY_ACME=1` (repeatable) carries
any other daemon setting into the environment file. Under a pipe it never prompts — it prints
the usage and exits, because a prompt no one can answer is a hang, not a question.

It ends by proving the thing it installed: it waits for `/readyz` — engine attached, driver
answering — and runs `bary status` against the token it just minted. Debian · Ubuntu · RHEL 9
derivatives · Amazon Linux 2023 · Alpine. `./tests/install/run.sh` runs the script inside a
real container of each, boots the service under systemd (OpenRC on Alpine), and asserts the
daemon answers — **including after a restart**, which is the only way to know the bootstrap
generation does not roll the active one back, and that `apply` can open port 80, which is the
only way to know the file capability landed.

What `apply` did, in order: opened a changeset on the current head, accumulated the patch,
**sealed** it into a plan (showing which sockets it would open — that is where a bind failure
would surface), committed it (reserving revision *and* a fresh activation epoch), rendered it,
materialized an immutable generation directory, published it by an atomic symlink swap, sent
one `SIGHUP`, **read the generation literal baked into that config back over HTTP to prove the
reload took effect**, and only then moved the plane coordinates.

If any of that fails, the coordinates do not move and `bary` exits non-zero with the reason.

---

## How it fits together

```text
  Web GUI ─┐
  CLI ─────┼─→ REST API ─→ Model + ConfigRevision (PostgreSQL) ─→ Reconciler (single leader)
  IaC ─────┘                                                        │            │
                                                       config path  │            │ membership path
                                                     (triggers reload)          (no reload)
                                                                    ▼            ▼
                                          ┌──────────── Data plane ──────────────────────┐
                                          │  DP Agent — sole writer of /etc/barycenter   │
                                          │  materialize · nginx -t · publish · SIGHUP   │
                                          │  worker registry · probes · ACK · rollback   │
                                          │           ▼                    ▼             │
                                          │  OpenResty http zone   OpenResty stream zone │
                                          │  (separate shared dicts — see §3.4)          │
                                          └──────────────────────────────────────────────┘
```

The control plane and the data plane are separate processes. **If the control plane dies,
traffic keeps flowing.** A bug in a management UI must never become a service outage.

That separation only prevents *control-plane* failures from becoming traffic failures.
**The data plane is a single point of failure in v1** — that is a stated operating constraint,
not a missing feature, and it comes with an RTO/RPO, cold-standby and failover runbook.

---

## Design principles

1. **The model is the source of truth; `nginx.conf` is an artifact.** The moment a human edits
   the rendered config, the model is lying.
2. **The API is the only entry point.** No internal shortcuts for the GUI.
3. **Validate, then publish atomically** — but only *publishing* is atomic. Reload, worker
   startup, traffic cutover, and rollback are not, and the design assumes that.
4. **The data plane agent is the only writer.** The control plane owns neither the config files
   nor the nginx process.
5. **There is more than one truth.** `desired` / `published` / `runtime` / `membership` are
   tracked separately, and config generations are fenced against membership updates by a
   `topology_epoch`. Collapsing them makes "applied" a lie; unfencing them sends traffic to
   backends that no longer exist.
6. **Anything the engine cannot observe is not promised by the API.** Observability is the
   ceiling on the schema.
7. **Organization-specific concerns go in drivers**, never in the core.
8. **Impossible combinations are rejected at save time** — types, then DB constraints and
   triggers, then a transaction-scoped validator.

---

## Extending it

Driver interfaces keep organization-specific concerns out of the core, so you never need to fork:

`DataplaneDriver` · `DNSProvider` (ACME DNS-01) · `BackendDiscovery` · `AuthProvider` ·
`SecretStore` · `AuditSink` / `Notifier`

`SecretStore` ships with two drivers. `BARY_SECRET_BACKEND=fs` (the default) writes certificate
material to the data plane host as plaintext files protected only by mode `0400`; `pg` stores it
in PostgreSQL under envelope encryption (a per-material AES-256-GCM key, itself wrapped by a KEK
that lives outside the database in `BARY_SECRET_KEK`), so a database dump alone yields nothing —
and losing that KEK means the material cannot be recovered. KMS and Vault drivers slot in behind
the same interface.

Each interface is frozen just before the release that first consumes it, not all at once.
Drivers ship as npm packages and are loaded at runtime from a pinned allowlist with integrity
and API-version checks — no recompilation or forking of the core, though they still have to be
provisioned into the image. The reference driver is `drivers/reference.mjs`. A third-party
repo checks its own entry with `node scripts/driver-compat.mjs <entry>` — the core is not
modified. At boot, `BARY_DRIVER_PINS` / `BARY_DRIVER_PINS_FILE` plus optional `BARY_DRIVER`
load that package for `GET /api/v1/status`. The apply path stays `LocalDataplaneDriver`.
See [§9 of the design doc](./DESIGN.md).

---

## Stack

TypeScript on Node.js · PostgreSQL · Vite + Svelte 5 for the operator screens
(SvelteKit eight routes, adapter-static) · nginx / OpenResty as the
data plane.

The daemon serves `gui/build` (or `BARY_GUI`) from the same origin as the API — CORS is
not opened. Build the page with `npm ci && npm run build` inside `gui/`. Without that
directory the API is unchanged: `GET /` still asks for a token.

Pinned engine for the test suites: `docker.io/openresty/openresty:alpine` (OpenResty 1.31.1.1). Override
with `BARY_ENGINE_IMAGE=… npm run test:engine` to check a candidate image — the suite reports
which capabilities it has rather than assuming a fixed module list, because no public image
ships both `stream_realip` and `ngx_stream_lua`.

---

## Development

Run all the checks with `./scripts/verify.sh` (or `--quick` to skip the Docker-backed suites).

| | | |
|---|---|---|
| `npm test` | 223 | renderer · string contracts · socket overlap · route compiler · engine capabilities |
| `npm run test:conformance` | 381 | counterexamples reproduced from 50 review rounds |
| `npm run test:model` | 13 | a scheduler *generates* interleavings and hits properties P0–P11 |
| `npm run test:store` | 19 | changeset → plan → commit on **real PostgreSQL** |
| `npm run test:golden` | 10 | rendered output must pass `nginx -t` **on the real engine** |
| `npm run test:e2e` | 35 | the whole chain on real nginx — HTTP, TCP, UDP and SNI pass-through |
| `npm run test:engine` | 65 | nginx/OpenResty behaviours the design takes for granted |
| `./tests/install/run.sh` | 5 | `deploy/install.sh` on real Debian · Ubuntu · Rocky · Amazon Linux · Alpine |
| `./spike/s1-s5/run.sh` | 8 | reload-free membership changes across HTTP/TCP/UDP |
| `./spike/s7/run.sh` | 9 | proving a reload actually took effect |
| `./spike/s8/run.sh` | 11 | rolling a certificate back to an earlier generation |
| `./spike/s11/run.sh` | 14 | epoch fencing under contention |
| `./spike/s19/run.sh` | 16 | rolling back by cloning the old material under a **new** epoch |

### What the spikes settled

- **Membership can change without a reload** — on HTTP, TCP *and* UDP, with the first request
  after the switch already going to the new peer, zero reloads, same master PID. This was the
  bet the whole design rested on. The pure-nginx fallback is now just a fallback.
- **`nginx -t` passing is not evidence that a reload took effect.** With a port held by another
  process, the config validates, the master survives, and nginx quietly keeps serving the *old*
  config. Detecting that reliably needs both a worker registry (success signal) and the error
  log watermark (failure signal) — registry alone takes a full timeout to say "no".
- **Binding certificates into the generation directory is what makes rollback real.** Running
  the old layout side by side reproduces the bug: the config rolls back, the certificate does not.
- **Reusing an epoch on rollback is an ABA hazard.** Splitting "which topology" from "which
  activation" and never reusing an activation number is what makes a late in-flight RPC from a
  deposed leader harmless.

- **Rollback is the one place the two hardest constraints collide — and how you clone decides it.**
  Certificates must live *inside* the generation (so a rollback restores them), but an activation
  epoch must never be reused (so a late RPC can't take effect) — and the epoch is *baked into* the
  generation. The design's answer is to clone the old material into a new generation and re-render
  a fresh epoch; S19 confirms both hold at once. It also shows the two plausible shortcuts each
  break in a way traffic won't reveal: `cp -r` carries the old epoch literal along, leaving workers
  reading a slot the control plane no longer writes to — **a generation deaf to health updates that
  still looks healthy** — and symlinking the certificates instead of copying them survives right up
  until GC reclaims the old generation, at which point the next reload fails.

---

## Status & limitations

**What works.** `docker compose up` gives you a control plane you can drive over REST: a change
goes through a changeset, gets planned, committed, rendered, published as an immutable generation,
and activated on real nginx — with the activation *proven* before any coordinate moves. The
[Quick start](#quick-start) ends with `curl` reaching a backend.

HTTP, HTTPS, TCP, UDP and SNI pass-through render. A Lua membership plane updates backends without
a reload. A TCP health probe publishes flips on SSE. ACME http-01 and uploaded certificates
terminate TLS. Operator screens exist for impact, listeners, pools, routes, certificates, status,
the rendered conf and the audit log. Adding or removing a backend, opening a pool (with its first
backend — empty pools are rejected), opening or closing an HTTP, TCP or UDP listener, or adding or
removing an HTTP host route (proxy to a pool; websocket off) goes through a changeset and stops at
commit. Apply is a separate action on the impact screen.

**What doesn't yet.** Drain *progress numbers* are omitted when the engine has no per-peer inflight
gauge (S2). The CLI can create listeners, pools, HTTP and pass-through routes, backends, TLS
policies, certificates and SNI bindings (commit, not apply), and delete the same kinds including
certificates and TLS policies. Leader election exists — a PostgreSQL advisory lock issues strictly
monotonic fencing tokens, and a non-leader serves reads but answers `503 not_leader` to writes —
but **failover is not automatic**: each data plane carries its own nginx, so extra instances are
cold standbys, and moving traffic is still DNS or an upstream L4's job (§11.4).

**Not frozen.** It runs, and it is a draft. The API and DB schema are not frozen (§9.1.1) —
they get fixed *with* the implementation, and the implementation is not finished.

The design lives in [`DESIGN.md`](./DESIGN.md) and the test
cases derived from it in [`TESTS.md`](./TESTS.md) (both written in Korean). What is true *now* is
in [`STATUS.md`](./STATUS.md). The review-round diary is in
[`docs/archive/STATUS-log.md`](./docs/archive/STATUS-log.md).

### Known limitations of the nginx data plane

These are inherited from nginx and will be documented rather than hidden:

- **UDP upstreams do not support the PROXY protocol**
  ([nginx#1061](https://github.com/nginx/nginx/issues/1061)), so backends cannot see the real
  client IP. The UI blocks the combination outright rather than letting you save something that
  silently won't work. (This applies to the PROXY-header path specifically; exotic alternatives
  like transparent source binding exist and are out of scope for v1.)
- **TCP upstreams only get PROXY protocol v1**, and **HTTP upstreams get none at all** — the
  HTTP proxy module has no directive to emit a PROXY header in the first place. v2 is exposed
  only when a driver reports the capability.
- **Chaining the PROXY protocol needs `stream_realip`, and no public image has both that and
  OpenResty's Lua.** Official nginx images ship `stream_realip` but no `ngx_stream_lua`;
  OpenResty images ship the reverse. So the required-module list is treated as a *capability*
  instead: without `stream_realip`, accepting a PROXY header *and* sending one downstream is
  rejected at save time (the backend would silently receive this proxy's address rather than
  the client's), while source-IP hashing transparently switches to `$proxy_protocol_addr`,
  which stays correct. Measured, not assumed — see `tests/engine` E28/E29.
- **nginx OSS has no active health checks** (that is a commercial module). The control plane
  probes backends itself (status code first, narrowed per pool via `healthCheck`); OpenResty's `balancer_by_lua` is used so that health changes don't
  trigger a config reload. Note that this replaces the native balancer rather than editing an
  upstream list — weighting and consistent hashing come from `lua-resty-balancer`, while
  `least_conn`, which stream and http OSS both provide natively, degrades to a per-worker
  approximation. It is therefore **excluded from the v0 algorithm set** pending spike results.
- **Draining removes a backend from new traffic; it does not close existing ones.** Established
  TCP connections and UDP pseudo-sessions stay put until they end on their own or hit their
  deadline. Forced termination is a separate capability, not a v0 promise.
- UDP "sessions" are approximated from the client IP/port pair. `proxy_responses` is a
  session-termination hint, not a response cap, and has to match the protocol.
- With Encrypted Client Hello, the inner SNI is hidden but the outer `public_name` remains, so
  pass-through still works — it just collapses to public-name granularity and can no longer
  route per inner origin.

---

## Roadmap

| | | |
|---|---|---|
| **v0.0** | Architecture spike, S1–S20 | S8 · S11 · S12 (block) and S1 · S7 · S13 · S16 · S17 · S18 · S19 passed. S14 is 7/8 and stays out of the gate. S20 keeps h3 out of the model. S2 now observes both planes |
| **v0.1** | Typed model, sealed changesets, apply state machine, DP agent, renderer | ← **done** |
| **v0.2** | Pools, LB algorithms, UDP profiles, SNI pass-through, socket-overlap, route compiler | ← **done** |
| **v0.3** | Membership plane, health probe | ← **done.** Drain inflight is served on both planes; inflight and sessions are still one counter (S2) |
| **v0.4** | `bary` CLI: export/import and changeset steps | ← **done.** Resource create matches GUI writes. Delete matches GUI withdraw |
| **v0.5** | Web GUI: Kit routes including login, SSE, HTTP/TCP/UDP/HTTPS/passthrough writes, cert upload, SNI bind | ← **done.** No polling |
| **v0.6** | TLS terminate, ACME http-01, cert rollback, HTTPS GUI, material upload, SNI bind | ← **done.** Order GET, dns-01, EAB, Retry-After, renewal tick |
| **v0.7** | Driver loader, reference kit, boot pins | ← **done.** `BackendDiscovery` consumer is membership slots; not frozen on the v0.1 surface |
| **v1.0** | Roles, backup/restore, SPOF runbook, OpenAPI/DDL freeze, OIDC ID Token + Authorization Code | ← **slice open.** RTO/RPO are v1 operating policy (ADR-SPOF), not a lab SLA |

---

## License

Apache-2.0. See [LICENSE](./LICENSE).
