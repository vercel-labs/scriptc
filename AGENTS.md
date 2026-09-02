# Agent Guide

This is the only agent guide for the repository. Its rules apply everywhere, including `docs/` and `internal/compatibility/`.

## Markdown style

Write prose paragraphs and list items as single source lines and let editors and renderers wrap them naturally. Do not hard-wrap Markdown at a fixed column; preserve separate lines only where Markdown syntax or intentional formatting requires them, such as headings, lists, tables, blockquotes, and code blocks.

## Build and test

```bash
pnpm install && pnpm -r build   # build the workspace
pnpm test:sandbox              # full gate: ~4m custom image, ~9m cold managed fallback
```

The ordinary workspace build does not rebuild packaged native artifacts.
When changing native assembly/object emission or runtime-pack selection,
install CMake, Ninja, and the pinned LLVM 22 development package, then run the
matching `@scriptc/llvm-<platform>` and `@scriptc/runtime-<platform>`
`build:native` scripts explicitly. The macOS full test suite also needs its
generated artifacts.

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

`SCRIPTC_TEST_WORKERS` caps the vitest worker pool so concurrent agents don't contend for cores; full local suites also queue behind an advisory lock per lane.

Corpus programs are differential tests against Node: every program runs under Node and as a compiled native binary, and stdout, stderr, and exit codes must match byte-for-byte. A new feature lands with corpus programs that pin its behavior both ways.

Test location follows scope:

- Co-locate white-box unit tests with implementation files under
  `packages/*/src`; name them after the source file (`cc.ts` → `cc.test.ts`).
- Put package-level API and integration tests in `packages/*/test`.
- Put cross-package differential, harness, and end-to-end tests in the root `tests/` tree.

Keep existing tests in place unless a change already touches their organization;
new tests should follow this convention.

## Where things live

- `packages/compiler` — the frontend (tsc API to IR), typed IR, validator, serializer, and LLVM and C backends.
- `packages/runtime` — the C runtime compiled into every scriptc binary.
- `packages/cli` — `scriptc build | run | coverage`.
- `internal/compatibility` — generated Node.js parity inventory, implementation-owned compatibility manifests, and engineering backlog.
- `tests/` — the differential corpus, diagnostics snapshots, and harness.
- `docs/` — the standalone Next.js App Router + MDX documentation workspace.
- `scripts/` — repository tooling, including the release version stamp.

## Node.js compatibility

The Node.js compatibility system is an implementation inventory and planning tool. Keep its claims narrower than the evidence. Do not change a status merely to make the public matrix look correct.

### Sources of truth

- `internal/compatibility/node-v24.json` pins the Node release, commit, official API inputs, and documentation URLs. The pinned Node API is the denominator.
- Node's official documentation defines the public API hierarchy and stability metadata. Consult Node source when the docs do not fully specify behavior.
- Running the pinned Node release is the behavior oracle for differential tests.
- Compiler source and `packages/compiler/surface-manifest.json`, augmented by `internal/compatibility/static-support.json`, define static-native support.
- `internal/compatibility/dynamic-support.json` defines dynamic-island modules, exports, members, explicit stubs, globals, and policies. It also generates the runtime builtin registry.
- Test evidence determines positive behavioral claims. Source manifests alone do not prove Node-compatible behavior.

Treat static-native and dynamic-island compatibility independently. Support in one tier says nothing about the other, and `--dynamic` does not turn an unsupported typed call into a supported static call.

### Status contract

- `supported` — broadly implemented. This requires test evidence.
- `partial` — a useful implemented subset. This requires test evidence, but evidence may cover an API family rather than every documented overload.
- `refused` — a named compiler diagnostic or explicit dynamic throwing or rejecting stub exists. Never infer this status from absence.
- `not-implemented` — no implementation claim. Its verification basis decides whether it is ready to implement or must first be investigated.
- `by-design` — intentionally outside a scriptc execution model. This requires an explicit implementation-owned architectural policy.
- `unreviewed` — no compatibility subsystem owns a reliable classification. Do not treat this as unsupported or as an implementation ticket.
- `not-applicable` — documentation, configuration, executable behavior, or an embedding model that does not map to the execution tier.

Chapter rows are generated summaries of their descendants, never independent support claims.

### Verification basis and backlog actions

Read a row's verification basis before acting:

- `test-backed` — mapped to implementation and relevant tests. Audit the exact overload or behavior before broadening a `partial` claim.
- `explicit-refusal` — source-verified refusal boundary.
- `verified-absence` — a runtime presence test confirms absence.
- `declared-gap` — an implementation-owned manifest explicitly declares the gap; it is ready for implementation.
- `registry-gap` — no implementation registry entry matched. Verify the gap before implementing: it may be an incomplete manifest or symbol match.
- `architectural-policy` — explicit intentional exclusion.
- `unreviewed`, `not-applicable`, and `derived` retain the meanings above.

`pnpm node-compat:backlog` emits tier-specific work. Its actions are:

- `verify-gap` — investigate a registry gap first; this is not yet an implementation ticket.
- `implement` — implement a declared or verified gap.
- `replace-refusal` — add support where an explicit refusal currently exists.
- `audit-partial` — identify and implement missing behavior in a tested subset, or tighten an overbroad mapping.
- `classify` — establish ownership and evidence for an unreviewed row.

Backlog priority is a heuristic based on Node stability: stable APIs are raised, release-candidate or unrated APIs remain normal, and experimental, deprecated, and legacy APIs are lowered. It is not a product roadmap.

Rows are not necessarily independent work items. One implementation can close a class, methods, overloads, aliases, and nested rows. Plan work by coherent API family and inspect the regenerated diff instead of creating one ticket per row.

Useful queue filters compose:

```bash
pnpm node-compat:backlog --action=implement --priority=high
pnpm node-compat:backlog --action=verify-gap --chapter=assert
pnpm node-compat:backlog --tier=dynamic --format=tsv
```

### Generated files

Never hand-edit these files:

- `packages/compiler/surface-manifest.json`
- `internal/compatibility/generated/node-v24-internal.json`
- `internal/compatibility/generated/node-v24-backlog.json`
- `docs/src/generated/node-v24-compatibility.json`
- `docs/src/generated/node-v24-compatibility-meta.json`
- `packages/runtime/src/scr_island_manifest.h`

Change compiler decision sources or the implementation-owned compatibility manifests, then regenerate. Use `pnpm manifest` when compiler decision tables change and `pnpm node-compat` whenever the Node pin, compatibility manifests, compiler surface manifest, or dynamic registry changes.

The public docs artifact must not expose repository test paths, internal source identifiers, engineering evidence bookkeeping, documentation/metadata headings, command-line or configuration-only entries, or rows that are N/A in both tiers. Those remain in the complete internal census under `internal/compatibility/generated/`.

### Landing compatibility work

For each API family:

1. Start from the backlog action and verification basis. Verify every `registry-gap` before assuming code is missing.
2. Read the pinned Node documentation, stability metadata, relevant Node source when needed, and existing scriptc implementation paths.
3. Decide static-native and dynamic-island scope separately.
4. Implement the smallest coherent behavior family. Preserve explicit refusals for unimplemented forms rather than silently diverging.
5. Add differential evidence that executes under Node and as a compiled binary. Cover stdout, stderr, exit status, success behavior, and important error shapes. Dynamic-island work needs island-executed differential fixtures; a load-only export check does not prove behavior.
6. Update the implementation-owned source or manifest. Positive `supported` and `partial` mappings must name existing test evidence.
7. Run `pnpm manifest` if compiler surface tables changed, then run `pnpm node-compat`. Never patch generated JSON or headers.
8. Inspect the internal ledger, public artifact, and backlog diff. Confirm the intended API family changed and unrelated rows did not.
9. Run focused tests, `pnpm node-compat:check`, and the full validation gate required for the change. If docs output changed, also run the docs gate.

Compatibility commands:

```bash
pnpm node-compat
pnpm node-compat:check
pnpm --filter @internal/compatibility check:upstream  # networked pinned-input check
```

## Documentation site

The docs site is a standalone pnpm workspace under `docs/`. It uses Next.js App Router + MDX, with one topic per `docs/src/app/<topic>/page.mdx`.

### Naming and content

- The project is **scriptc**, lowercase, everywhere: page titles, prose, and code samples.
- Name-bearing strings such as the site name, tagline, GitHub URL, and canonical origin `https://scriptc.dev` live in `docs/src/lib/site.ts`.
- Coverage numbers on a page may only be output from `scriptc coverage` for a specific program shown in the same block; never publish invented aggregate coverage statistics.
- Every shell command shown in a fence must have run successfully against the current build. Output blocks contain real output; trimming is acceptable, invention is not.
- Document limitations plainly on the limitations page rather than scattering them as fine print.

### MDX conventions

- Use literal HTML `<table>` markup in MDX, never Markdown pipe tables.
- Fence info strings contain the language and optionally a filename after a colon, for example `ts:src/main.ts`; no other fence metadata survives.
- Use `console` fences for shell sessions (`$ command` followed by output).
- Use `diff` fences for additions and removals.
- Use HTML `<dl>/<dt>/<dd>` for flag and subcommand references.

### Adding a docs page

1. Add `docs/src/app/<topic>/page.mdx`.
2. Add `docs/src/app/<topic>/layout.tsx` exporting `pageMetadata("<topic>")`.
3. Add the slug to `PAGE_TITLES` in `docs/src/lib/page-titles.ts`.
4. Add navigation in `docs/src/lib/docs-navigation.ts`; it also drives mobile navigation and the sitemap.

### Docs development and verification

Do not start duplicate docs dev servers. Reuse the existing server and its hot reload process when one is running. CI-style builds must use a separate dist directory so they do not corrupt the dev server's `.next` state:

```bash
cd docs
NEXT_DIST_DIR=.next-check pnpm check
```

`pnpm check` runs the compatibility drift check, TypeScript check, and production build. It is required before landing docs or compatibility output changes.

## Releases

Releases are maintainer-run; see [RELEASING.md](./RELEASING.md).
