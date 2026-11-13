# Contributing to scriptc

## Setup

Use the Node.js version in [.node-version](./.node-version) and install pnpm. From the repository root, install dependencies and build the workspace:

```console
$ pnpm install && pnpm -r build
```

The workspace build compiles the TypeScript packages and checks the compatibility inventory. It does not rebuild packaged native artifacts and needs no local LLVM installation.

## Code quality

Run `pnpm lint` and `pnpm format:check` before submitting changes. `pnpm lint:fix` applies safe oxlint fixes; review the diff afterward. `pnpm format` applies oxfmt formatting. The commands cover owned JavaScript and TypeScript in packages, repository scripts, compatibility tooling, the test harness, and the root test configuration. CI runs the same checks without waiting for native builds.

Use `pnpm lint --format=agent` for compact diagnostics or `pnpm lint --format=json` for structured output. These use the same rules and exclusions as the ordinary check.

The root configurations exclude program fixtures, generated outputs, vendor code, and the standalone documentation workspace. Deliberately invalid or poorly formatted programs are test data. Formatting also preserves embedded source strings and import execution order. Native C and C++ use their existing conventions.

Keep the compiler's frontend/backend import boundary and the explicit TypeScript parser islands intact. Lint exceptions must explain the semantic reason and apply to the smallest useful scope; do not disable a correctness check just to clear a finding. The compiler's non-null assertions remain permitted where existing proofs establish the value, while redundant and unsafe optional-chain assertions are checked.

## Tests

The test corpus runs each program under Node.js and as a compiled native binary, then compares stdout, stderr, and exit codes byte-for-byte. Run focused tests while developing; use `pnpm test:sandbox` for the full validation gate. Both the plain and sanitized lanes must pass. The sanitized lane enables AddressSanitizer and the runtime reference-count audit.

The Sandbox gate loads configuration from the shell and `.env.local`, checks Vercel authentication and project access, and uploads the working tree to disposable Linux Sandboxes. On macOS, it also runs the Darwin-native contracts locally; Linux hosts run their supported native-clang contracts locally.

### Sandbox authentication

`VERCEL_OIDC_TOKEN` is preferred. To load a project-scoped token, link the checkout to its Vercel project with `vercel link`, then run `vercel env pull`. For access-token authentication, set `VERCEL_TOKEN`, `VERCEL_TEAM_ID`, and `VERCEL_PROJECT_ID`.

By default, the gate uses `vercel/sandbox/universal` and installs the repository-pinned Node.js, pnpm, LLVM, and workspace dependencies. To use an optional prebuilt image, build it with `pnpm test:sandbox:image` and set `SCRIPTC_SANDBOX_IMAGE` to its fully qualified VCR reference. Team and project selection never come from the image reference.

The legacy VCR command used by `pnpm test:sandbox:image` requires `VERCEL_TOKEN` or an existing Vercel CLI login for authentication. OIDC claims can still provide its team and project scope.

### Sandbox preparation limits

Each Sandbox builds the Linux LLVM helper and runtime pack from the uploaded worktree, because packaged native artifacts are not part of the workspace build. On a fresh `vercel/sandbox/universal` at 8 vCPUs that took 41 seconds for the helper and 6 minutes 10 seconds for the runtime pack on Nov 13, and a whole wave of shards preparing at once builds more slowly than one Sandbox alone. The two steps therefore use `SCRIPTC_SANDBOX_NATIVE_TIMEOUT` (default `20m`) instead of a test-command limit, and they fail when they print nothing for five minutes, the longest silent phase of the runtime pack (the PGO `speed` flavor) being 116 seconds. The same limit covers fetching the libnode pack described below.

A lane also needs `SCRIPTC_SANDBOX_TIMEOUT` to cover preparing the image and running the shard, and its clock starts when the Sandbox is created. Preparation runs in waves of eight, and every Sandbox then waits for the last wave before testing starts, so the first-created Sandbox spends about 30 minutes before its corpus step begins and an hour or more on that step. The default is therefore `150m`; lower it only for lanes that skip the corpus. One test command keeps a tighter 90-minute wall limit, so a command that keeps printing cannot run for the whole lane.

The native bootstrap that builds the compiler with the compiler gets its own Sandbox per lane, as CI gives it its own `bootstrap` jobs, and that Sandbox carries a 24 GB swapfile like those jobs. Beside the corpus workers it competes for the same memory and is killed in its seed build, because the sanitized emitter alone peaks near 13 GB and then has clang compile the result. The two extra Sandboxes run while the shards test, so they do not lengthen a run.

The Node island tests require a libnode pack rather than skipping in the lanes, which run with `CI=1`. A Sandbox from a prepared snapshot can name the pack it already carries in `SCRIPTC_LIBNODE`; otherwise the runner fetches the pinned development pack that CI falls back to into `/tmp/scriptc-libnode-pack` and exports it to every lane.

### Local fallback

When Vercel Sandbox credentials are unavailable, run `SCRIPTC_TEST_WORKERS=4 pnpm test`, then `SCRIPTC_TEST_WORKERS=4 SCRIPTC_SAN=1 pnpm test`. The worker limit avoids oversubscribing the host. Full local suites queue behind an advisory lock per lane.

See the [test harness guide](./tests/harness/README.md) for focused checks, platform lanes, and test caches.

## Native artifacts

When changing native assembly or object emission, runtime-pack selection, or the C runtime, rebuild the relevant native artifacts explicitly. Install CMake, Ninja, the pinned LLVM 22 development package, and Zig 0.16.0 on the target host. Run the matching `@scriptc/llvm-<platform>` and `@scriptc/runtime-<platform>` packages' `build:native` scripts. The macOS full test suite also needs those generated artifacts.

## Runtime headers

`packages/runtime/src/scr_runtime.h` includes the per-module runtime headers (`scr_string.h`, `scr_dyn.h`, `scr_http.h`, and so on) in dependency order and holds no declarations itself. Add a new declaration to the header of the runtime unit that defines it: `scr_<unit>.h` for `scr_<unit>.c`, or the header whose first comment names that unit. The comment at the top of `scr_runtime.h` lists the ordering rules. To move hunks from a branch that still edits the single-file `scr_runtime.h`, run `node scripts/runtime-header-hunks.mjs <diff>`. It prints a patch for the module headers.

## Documentation

The docs site is a standalone pnpm workspace under `docs/`. Install its dependencies with `pnpm --dir docs install` and start it with `pnpm --dir docs dev`. Reuse an existing dev server when one is running.

Content lives in `docs/content/docs`. Keep shared layout and runtime behavior in `@vercel/geistdocs`; local adapters belong under `docs/src`. Follow the authoring conventions in [AGENTS.md](./AGENTS.md).

The Limitations page is split into partials under `docs/content/limitations/`, one file per labeled bullet and one per section's other text. Edit the partial for the bullet or section you change; [AGENTS.md](./AGENTS.md#limitations-page-partials) describes the layout and how to move edits from a branch that still edits the single-file page.

Before landing docs or compatibility output changes, run `NEXT_DIST_DIR=.next-check pnpm --dir docs check`. The separate output directory keeps the production build from corrupting a running dev server's `.next` state. This gate checks compatibility drift, TypeScript, the production build, and HTTP routes.

## Writing with AI coding agents

If an AI coding agent writes any of your contribution's prose, it must use the [`technical-writer` skill](.agents/skills/technical-writer/SKILL.md). That covers docs pages, READMEs, changelog entries, commit messages, PR descriptions, and issues. The skill sets the voice and editorial standards for this repo and asks agents to check technical claims against the source. Agents that read this repo's `AGENTS.md` pick up the requirement automatically.

## Releases

Releases are maintainer-run. See [RELEASING.md](./RELEASING.md).
