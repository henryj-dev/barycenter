# Contributing

Thanks for looking. A few things about this repository are unusual enough that reading this
first will save you a round trip.

## What this repository considers true

The design is the contract. [`DESIGN.md`](./DESIGN.md) says what the model *is*;
[`TESTS.md`](./TESTS.md) holds the cases derived from it; [`STATUS.md`](./STATUS.md) says what
is actually true right now. All three are in Korean — the README and this file are in English
because they face outward. **Issues and pull requests are fine in either language.**

Two consequences worth knowing before you write code:

- **A behaviour change starts in `DESIGN.md`,** not in `src/`. If the design does not say what
  should happen, that is the first thing to settle — open an issue and say what you think it
  should be.
- **Green is not a claim; a reproduction is.** `./scripts/verify.sh` refuses to skip suites
  when Docker is missing — it fails instead, because a forged pass is worse than a red one.
  The same instinct applies to your change.

## Setup

```sh
node --version          # 24 — the version CI uses lives in .nvmrc (package.json allows >= 22)
npm ci
docker info             # required for everything except --quick
```

Then, once per clone:

```sh
./scripts/git-hooks/install.sh
```

This points `core.hooksPath` at the tracked `scripts/git-hooks/`. The hooks are hygiene, not a
boundary (`--no-verify` bypasses them) — but the gate that follows them is not, so skipping
them only moves the failure later. See the next section.

## Running the gate

```sh
npm run verify:quick    # types, surface, reachability, hooks, unit, conformance, model — no Docker
npm run verify          # all of the above plus build, store, golden, e2e, engine facts, spikes
npm run quickstart      # the procedure the README promises, end to end
```

`npm run verify` takes tens of minutes and stands up real nginx and real PostgreSQL. That is
the point: this project's claims are about what an engine actually does, and only the engine
can settle those. Run `--quick` while you work, and the full one before you push.

## The `Pinned-by:` rule

**A commit that changes `src/` must carry a `Pinned-by:` trailer in its message.** A
`commit-msg` hook asks for it at commit time and `scripts/pinned.mjs` enforces it in CI:

```
Pinned-by: tests/conformance/foo.test.ts -t "the case name"
Pinned-by: none — <why this change needs no artifact>
```

If the trailer names a test, the gate **checks out the parent tree and runs that test against
it, expecting it to fail.** A test that passes without your change pins nothing. A bare `none`
is rejected; the reason after the dash is the part that matters.

This exists because the rule used to live in prose, and prose rules got broken repeatedly. If
it blocks you and you believe it is wrong for your case, say so in the pull request — do not
quietly `--no-verify`, since CI checks every pushed commit, not just the tip.

## Commits and pull requests

- Conventional-ish prefixes, matching the existing log: `feat(scope):`, `fix(scope):`,
  `docs:`, `ci:`, `chore:`. Subjects are short and say what changed, not what you did.
- **Small commits, often.** CI cancels superseded runs on a branch, so the newest commit gets
  its verdict first; a tidy history is what makes that readable.
- Say what you measured. "Tests pass" is not evidence — which suite, and what did it print?
- If your change makes something in `STATUS.md` untrue, update `STATUS.md` in the same pull
  request.

## What CI will run on your pull request

| Workflow            | What it decides                                                             |
| ------------------- | --------------------------------------------------------------------------- |
| `verify`            | **The gate.** `verify.sh --quick`, the pin check over every pushed commit, the full suite, and the quickstart. |
| `dependency-review` | Blocks new dependencies with known high-severity advisories or a copyleft licence that Apache-2.0 distribution cannot carry. |
| `codeql`            | Static analysis of `src/` and of the workflows. Results land in the Security tab; it does not block merges. |

`nightly`, `scorecard`, and `release` do not run on pull requests.

## A note on the maintainer's workflow

[`AGENTS.md`](./AGENTS.md) describes a rule where coding agents are confined to git worktrees
and the main tree is read-only to them. That is about how this repository is maintained, and
it is enforced by local hooks only — **it does not apply to you.** Fork, branch, and open a
pull request as usual.

## Licence

By contributing you agree that your contribution is licensed under
[Apache-2.0](./LICENSE), the same as the rest of the project.
