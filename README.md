# barycenter

**A control plane for nginx — HTTP, TCP, and UDP reverse proxying and load balancing, managed as a model instead of a pile of config files.**

> *A barycenter is the common center of mass that bodies in a system actually orbit — the point where the whole thing balances.*

> ⚠️ **Status: design phase. No implementation yet.**
> The full design lives in [`DESIGN.md`](./DESIGN.md) (written in Korean).
> Interfaces, data model, and scope are still open to change — feedback welcome.

---

## Why

The existing tools split along a frustrating line:

**If it has a GUI, its layer-4 support is weak. If layer 4 works properly, there is no GUI.**

| | GUI | API | CLI | TCP/UDP | Gap |
|---|:---:|:---:|:---:|:---:|---|
| **Nginx Proxy Manager** | ✅ | ~ | ❌ | ~ | Streams are port-to-host forwarding only — no upstream pools, no health checks, [no SNI routing](https://github.com/NginxProxyManager/nginx-proxy-manager/issues/4119) |
| **Traefik** | read-only | ✅ | ~ | ✅ | Dashboard cannot edit; config lives in files/labels/CRDs |
| **HAProxy + Data Plane API** | ❌ | ✅ | ✅ | TCP only | No UDP; GUI is commercial |
| **Caddy** | ❌ | ✅ | ✅ | plugin | No GUI |
| **APISIX** | ~ | ✅ | ~ | ✅ | Gateway-shaped, requires etcd — heavy for plain load balancing |
| **Nginx UI** | ✅ | ~ | ❌ | — | A config *file editor* — no model, so no validation, diffing, or rollback |

`barycenter` aims at the intersection: the usability of Nginx Proxy Manager, the API discipline of the HAProxy Data Plane API, and nginx's UDP support.

## What it does

- **Domain-based HTTP(S) routing** with full TLS lifecycle management (ACME + uploaded certs).
- **Real TCP/UDP load balancing** — upstream pools, balancing algorithms, health checks, and connection draining. Not just port forwarding.
- **SNI-based TLS pass-through** on layer 4 (via `ssl_preread`), so a single `:443` can fan out to backends that terminate their own TLS.
- **Inbound and backend ports are independent.** `:999 → A:11` and `:888 → B:11` are just two listeners pointing at two pools.
- **GUI, API, and CLI are equals.** The REST API is the only entry point; the web UI and `bary` CLI are both clients of it. Anything you can click, you can script.
- **Nothing is applied blind.** Every change renders to config, is validated with `nginx -t`, swapped atomically, and rolled back automatically if the reload fails. `plan` shows you the diff before you commit to it.

## Design principles

1. **The model is the source of truth; `nginx.conf` is an artifact.** The moment a human edits the rendered config, the model is lying.
2. **The API is the only entry point.** No internal shortcuts for the GUI.
3. **Validate, then apply atomically.** There should be no path where a bad setting takes the whole proxy down.
4. **Organization-specific concerns go in drivers**, never in the core.

## Architecture

```
  Web GUI ─┐
  CLI ─────┼──→  REST API  ──→  Model (DB)  ──→  Reconciler  ──→  [DataplaneDriver]
  IaC ─────┘                                     debounce           nginx / OpenResty
                                                 render             render → nginx -t
                                                 validate           → atomic swap → reload
                                                 rollback
```

The control plane and the data plane are separate processes. **If the control plane dies, traffic keeps flowing.** A bug in a management UI must never become a service outage.

## Extending it

Six driver interfaces keep organization-specific concerns out of the core, so you never need to fork:

`DataplaneDriver` · `DNSProvider` (ACME DNS-01) · `BackendDiscovery` · `AuthProvider` · `SecretStore` · `AuditSink` / `Notifier`

Drivers ship as npm packages and are loaded at runtime by name — no recompilation of the core. See [§9 of the design doc](./DESIGN.md).

## Stack

TypeScript on Node.js · PostgreSQL (SQLite for single-node) · SvelteKit for the web UI · nginx / OpenResty as the data plane.

## Roadmap

| | | |
|---|---|---|
| **v0.1** | Core model, REST API, nginx render/validate/swap/rollback | |
| **v0.2** | Upstream pools, LB algorithms, UDP, SNI pass-through | ← *proof of concept ends here* |
| **v0.3** | `bary` CLI, including `plan` / `apply` / `export` / `import` | |
| **v0.4** | Web GUI | |
| **v0.5** | ACME (http-01, dns-01), auto-renewal | |
| **v0.6** | Active health checks, dynamic upstreams without reload | |
| **v0.7** | Driver interfaces frozen, reference implementations | |
| **v1.0** | RBAC, audit log, backup/restore, documentation | |

## Known limitations of the nginx data plane

These are inherited from nginx and will be documented rather than hidden:

- **UDP does not support the PROXY protocol** ([nginx#1061](https://github.com/nginx/nginx/issues/1061)), so backends cannot see the real client IP. The UI blocks the combination outright rather than letting you save something that silently won't work.
- **nginx OSS has no active health checks** (that is an NGINX Plus feature). The control plane probes backends itself; OpenResty's `balancer_by_lua` is used so that health changes don't trigger a config reload.
- UDP "sessions" are approximated from the client IP/port pair. `proxy_responses` has to match the protocol.

## License

[Apache-2.0](./LICENSE)
