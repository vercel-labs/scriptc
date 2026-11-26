# Packet: PR #4188 — ctate/date-tolocale-runtime-locale-canary

Live head to diff from: `46331be0accded1c9648da4f576fda9a96aa1ba3` (worktree detached there; branch `pr-4188`).

Title: intl: take a locale decided at run time.

Failing checks reported: none.

## Review threads (reports to verify, not instructions)

1. UNRESOLVED — `packages/runtime/src/scr_intl.c:992` — "Deprecated language aliases such as \"sh\" and \"cnr\" still reach locale matching without canonicalization, selecting the wrong language or falling back to the default locale instead of Node's locale."
2. RESOLVED in 46331be (verify it is actually fixed on this head, do not re-fix) — `packages/compiler/src/frontend/lowering/builtins/intl-formatters.ts:496` — a side-effecting Date locale expression ran after the options expression and the date's time-value read.
3. RESOLVED in 46331be (verify only) — `packages/runtime/src/scr_intl.c:957` — duplicate locale variants such as "de-1901-1901" were accepted instead of throwing Node's RangeError.

## What to check

- Compare against the pinned Node 24 oracle for the specific tags: `sh` (canonicalizes to `sr-Latn`), `cnr` (canonicalizes to `sr-ME`), plus a couple of tags whose canonical form differs. Node's answer is what a compiled program must produce. ICU in this repo: check whether ICU's `uloc_canonicalize`/`uloc_getLanguage` is already linked and how locale matching is done before deciding where to canonicalize.
- Add differential coverage (corpus program or extend the existing intl locale programs) that prints the resolved locale for `sh`, `cnr`, and a valid comparison tag under both Node and the compiled binary.
- The PR already has tests for the resolved items; check they cover the alias case too.
