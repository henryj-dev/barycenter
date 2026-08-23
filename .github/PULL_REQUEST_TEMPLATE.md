<!--
Read CONTRIBUTING.md first if you have not. The two things that most often send a pull
request back are (1) a `src/` commit without a `Pinned-by:` trailer and (2) a claim with no
measurement behind it.
-->

## What changes, and why

<!-- One paragraph. If DESIGN.md already says what should happen, cite the section (§x.y). -->

## What proves it

<!--
Name the artifact, not the intention. Which suite, and what did it print?

  npm run verify        →
  <suite>               →

If the change touches `src/`, the commit carries:

  Pinned-by: tests/.../foo.test.ts -t "..."     ← run against the parent tree, it fails
  Pinned-by: none — <reason>
-->

## Checks

- [ ] `npm run verify` passed locally (or: `--quick` only, and here is why that is enough)
- [ ] Every `src/` commit carries a `Pinned-by:` trailer
- [ ] `DESIGN.md` / `STATUS.md` updated if this makes something in them untrue
- [ ] No new dependency, or: the new dependency is named above with a reason

## Anything you are unsure about

<!-- Better here than discovered in review. "I could not test X because Y" is a useful line. -->
