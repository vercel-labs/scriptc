# Agent Guide

Guidance for agents (and humans) working on this repository. These conventions apply repo-wide; the docs site under `docs/` additionally has its own conventions in `docs/AGENTS.md`.

## Build and test

```bash
pnpm install && pnpm -r build   # build the workspace
pnpm test:sandbox              # full gate: ~4m custom image, ~9m cold managed fallback
```

Use focused local tests while iterating, then use `pnpm test:sandbox` whenever a
full validation gate is required. It loads Sandbox configuration from the
shell and `.env.local`, runs portable coverage across disposable Linux
Sandboxes, and retains the Darwin-native contracts on macOS. Linux hosts run
their supported native-clang contracts locally; other hosts retain those
checks in the Sandboxes. Both lanes green is the bar before shipping any
change.

`VERCEL_OIDC_TOKEN` is the preferred credential. `VERCEL_TOKEN` remains
supported with explicit `VERCEL_TEAM_ID` and `VERCEL_PROJECT_ID`. The custom
`SCRIPTC_SANDBOX_IMAGE` is optional: without it, the gate starts from
`vercel/sandbox/universal` and installs the repository-pinned Node, pnpm, and
LLVM toolchain plus workspace dependencies before building. Team/project
selection never comes from the image reference. The legacy VCR image command
uses `VERCEL_TOKEN` or the existing Vercel CLI login for authentication; OIDC
claims can still provide its team/project scope.

Only when Vercel Sandbox credentials are unavailable, run the slower local
fallback:

```bash
SCRIPTC_TEST_WORKERS=4 pnpm test                 # plain lane
SCRIPTC_TEST_WORKERS=4 SCRIPTC_SAN=1 pnpm test  # sanitized lane
```

`SCRIPTC_TEST_WORKERS` caps the vitest worker pool so concurrent agents don't
contend for cores; full local suites also queue behind an advisory lock per
lane.

Corpus programs are differential tests against Node: every program runs under Node and as a compiled native binary, and stdout, stderr, and exit codes must match byte-for-byte. A new feature lands with corpus programs that pin its behavior both ways.

Test location follows scope:

- Co-locate white-box unit tests with implementation files under
  `packages/*/src`; name them after the source file (`cc.ts` → `cc.test.ts`).
- Put package-level API and integration tests in `packages/*/test`.
- Put cross-package differential, harness, and end-to-end tests in the root `tests/` tree.

Keep existing tests in place unless a change already touches their organization;
new tests should follow this convention.

## Where things live

- `packages/compiler` — the frontend (tsc API to IR), the typed IR with validator and serializer, and the LLVM and C backends.
- `packages/runtime` — the C runtime compiled into every scriptc binary.
- `packages/cli` — `scriptc build | run | coverage`.
- `tests/` — the differential corpus, diagnostics snapshots, and the harness.
- `docs/` — the documentation site (standalone pnpm workspace); see `docs/AGENTS.md`.
- `scripts/` — repo tooling, including the release version stamp.

## Releases

Releases are maintainer-run; see [RELEASING.md](./RELEASING.md).
