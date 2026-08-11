# barycenter

**A control plane for nginx — HTTP, TCP, and UDP reverse proxying and load balancing, managed as a model instead of a pile of config files.**

> *A barycenter is the common center of mass that bodies in a system actually orbit — the point where the whole thing balances.*

> ⚠️ **Status: design phase. No implementation yet.**
> The full design lives in [`DESIGN.md`](./DESIGN.md), and the test cases derived from it in
> [`TESTS.md`](./TESTS.md) (both written in Korean).
> One group of tests already runs without any implementation — `./tests/engine/run.sh` checks
> the nginx/OpenResty behaviours the design takes for granted against the real engine image.
> It has been through two rounds of external review; every finding is folded in, and the
> rebuttals — including the two that were withdrawn on the second pass — are recorded in §15.
> **Implementation is gated on an architecture spike** (§12.0): the spike itself is a Go,
> freezing the type/API/DB schema is not. Interfaces, data model, and scope are still open to
> change. Feedback welcome.

---

## Why

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

## What it does

- **Domain-based HTTP(S) routing** with full TLS lifecycle management (ACME + uploaded certs).
- **Real TCP/UDP load balancing** — upstream pools, balancing algorithms, health probes that
  are configured independently of the data protocol, and observable connection draining.
  Not just port forwarding.
- **SNI-based TLS pass-through** on layer 4 (via `ssl_preread`), with separate, required
  fallbacks for no-SNI and unmatched SNI — a client that sends no SNI must never land on an
  arbitrary backend by default.
- **Inbound and backend ports are independent.** `:999 → A:11` and `:888 → B:11` are just two
  listeners pointing at two pools.
- **GUI, API, and CLI are equals.** The REST API is the only entry point; the web UI and `bary`
  CLI are both clients of it. Anything you can click, you can script.
- **Nothing is applied blind.** Changes accumulate in a changeset, `plan` reports the impact,
  and apply runs a durable state machine — render → validate on the real data plane → publish →
  reload → verify, with automatic rollback and an explicit failure state when rollback itself fails.

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

## Architecture

```
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

## Extending it

Driver interfaces keep organization-specific concerns out of the core, so you never need to fork:

`DataplaneDriver` · `DNSProvider` (ACME DNS-01) · `BackendDiscovery` · `AuthProvider` ·
`SecretStore` · `AuditSink` / `Notifier`

Each interface is frozen just before the release that first consumes it, not all at once.
Drivers ship as npm packages and are loaded at runtime from a pinned allowlist with integrity
and API-version checks — no recompilation or forking of the core, though they still have to be
provisioned into the image. See [§9 of the design doc](./DESIGN.md).

## Stack

TypeScript on Node.js · PostgreSQL · SvelteKit for the web UI · nginx / OpenResty as the data plane.

## Roadmap

| | | |
|---|---|---|
| **v0.0** | Architecture spike, S1–S15 — each with a pass threshold and a decision on failure | ← **gate: no schema is frozen before this passes** |
| **v0.1** | Typed model, `topology_epoch`, sealed changesets, apply state machine + crash table, DP agent, config AST renderer, minimal auth/audit | |
| **v0.2** | Pools, LB algorithms, UDP profiles, SNI pass-through, socket-overlap validator, route compiler | ← *proof of concept ends here* |
| **v0.3** | Membership plane — dual http/stream zones, epoch fencing, health prober, drain observation | |
| **v0.4** | `bary` CLI, transactional `export` / `import` | |
| **v0.5** | Web GUI — thin vertical slice (listeners, pools/drain, plan/impact) | |
| **v0.6** | ACME (http-01, dns-01), auto-renewal, generation-bound certificate rollback | |
| **v0.7** | Driver reference implementations, loader hardening, compatibility test kit | |
| **v1.0** | Full RBAC, backup/restore rehearsal, SPOF runbook, documentation | |

## Known limitations of the nginx data plane

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
  probes backends itself; OpenResty's `balancer_by_lua` is used so that health changes don't
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

## License

[Apache-2.0](./LICENSE)
