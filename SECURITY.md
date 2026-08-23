# Security policy

## Status first

barycenter is a **draft**. The API and the database schema are not frozen (DESIGN.md §9.1.1),
and no version has been released. Treat it as software you are reading and experimenting with,
not as something to put in front of production traffic.

That said, a control plane that renders nginx configuration and holds credentials for a data
plane is a security-relevant thing to get wrong. Reports are welcome and will be treated
seriously.

## Reporting a vulnerability

**Please do not open a public issue for a suspected vulnerability.**

Use GitHub's private vulnerability reporting:
[**Report a vulnerability**](https://github.com/henryj-dev/barycenter/security/advisories/new)
(Security tab → Advisories → Report a vulnerability). It creates a private thread with the
maintainer and, if the report holds, becomes the advisory.

Useful things to include, in rough order of usefulness:

- What an attacker gets, and what access they need to start.
- A reproduction — a changeset, an API call sequence, a rendered `nginx.conf`, or a test.
  This repository's culture is that a claim without a reproduction is a hypothesis; a
  reproduction turns your report into something that can be fixed and then *kept* fixed.
- The commit you tested, and how you ran it (`docker compose -f deploy/docker-compose.yml up`,
  a manual daemon, something else).

**Expect a human, not a program.** This is a single-maintainer project. Acknowledgement should
take a few days; a fix takes as long as the fix takes, and you will be told which it is.

## Scope

In scope — things this project is responsible for:

- **Rendering.** Any input that escapes the model and lands in a generated `nginx.conf` as
  directives rather than as data. This is the highest-value class of bug in this repository.
- **The API surface.** Authentication and authorization on the control plane (`BARY_TOKEN`),
  the leadership/fencing path, the audit log, and anything that lets a caller commit or
  activate a generation they should not be able to.
- **Certificate and key handling.** Uploaded certificates, ACME account material, private keys
  at rest and in the rendered output.
- **The driver loader** (DESIGN.md §9.3) — loading a driver is loading code, and the boundary
  it claims should be the boundary it has.
- **The published artifacts** produced by the `release` workflow, and the workflows themselves.

Out of scope:

- **nginx and OpenResty themselves.** Report those upstream. Behaviour we inherit and document
  (see "Known limitations of the nginx data plane" in the README) is a documented limitation,
  not a vulnerability — though an argument that we document it *wrongly* is worth making.
- **The quickstart and `deploy/docker-compose.yml`.** They exist to make the thing run on a
  laptop in one command: `dev-token` is a literal in the compose file, PostgreSQL is
  unhardened, and nothing is behind TLS. That is deliberate and documented, not a finding.
  A way to reach a *hardened* deployment through them is a finding.
- Missing hardening headers, rate limits, or defence-in-depth on endpoints where you cannot
  demonstrate an actual consequence. Suggest those as issues instead — they may well be right,
  they are just not advisories.

## Known dependency advisories

`npm audit` is not silent. Here is what it reports and why it stands, so that the next person
does not re-derive it — or, worse, "fix" it by downgrading.

**Runtime dependencies: none.** The shipped daemon depends on `pg` alone (DESIGN.md §11.2 kept
it that way on purpose). `npm audit --omit=dev` reports zero.

**GUI build: three low, unfixed upstream.** `@sveltejs/kit` pulls `cookie@0.6.0`, and the
advisory covers `cookie <0.7.0`. The latest published kit (2.70.3, the version we are on) still
does; `npm audit fix --force` "resolves" it by proposing kit **0.0.30**, which is a downgrade of
two major versions and not a fix. Two things make this acceptable rather than merely tolerated:

- The GUI is built with `adapter-static`. There is **no server runtime in the artifact** — the
  cookie parser is not shipped. `gui/build` contains only the static bundle.
- The daemon serves that bundle from its own origin and does its own auth (Bearer / OIDC). It
  does not hand cookie parsing to kit.

If kit ships a release that moves off `cookie <0.7.0`, take it. Do not take the downgrade.

## Disclosure

Coordinated. Once there is a fix, or a decision that there will not be one, the advisory is
published with credit to the reporter unless you ask otherwise.
