# Agent Guide

This is the only agent guide for the repository. Its rules apply everywhere, including `docs/` and `internal/compatibility/`.

## Markdown style

Write prose paragraphs and list items as single source lines and let editors and renderers wrap them naturally. Do not hard-wrap Markdown at a fixed column; preserve separate lines only where Markdown syntax or intentional formatting requires them, such as headings, lists, tables, blockquotes, and code blocks. The Limitations page partials under `docs/content/limitations/` are the exception: they keep one sentence per line (see Limitations page partials).

Use the `technical-writer` skill (`.agents/skills/technical-writer/SKILL.md`) when you write or edit prose for this repo, including docs pages, READMEs, changelog entries, commit messages, PR descriptions, and issues.

## Build and test

Use `pnpm lint` and `pnpm format:check` for owned JS/TS; apply formatting with `pnpm format` and review any `pnpm lint:fix` changes. Preserve the exclusions in `.oxlintrc.jsonc` and `.oxfmtrc.jsonc`: program fixtures and deliberately invalid or formatting-sensitive inputs, generated outputs, vendor sources, and the standalone docs workspace are not part of the root tooling scope. Do not reformat embedded source strings or sort imports. Keep lint exceptions narrowly scoped and explain their semantic purpose. Compiler frontend/backend imports and the explicit TypeScript parser islands are enforced by oxlint.

```bash
pnpm install && pnpm -r build   # build the workspace
pnpm test:sandbox              # full gate: ~4m custom image, ~9m cold managed fallback
```

The ordinary workspace build does not rebuild packaged native artifacts. When changing native assembly/object emission or runtime-pack selection, install CMake, Ninja, the pinned LLVM 22 development package, and Zig 0.16.0, then run the matching `@scriptc/llvm-<platform>` and `@scriptc/runtime-<platform>` `build:native` scripts explicitly. The macOS full test suite also needs its generated artifacts.

Use focused local tests while iterating, then use `pnpm test:sandbox` whenever a
full validation gate is required. It loads Sandbox configuration from the
shell and `.env.local`, runs portable coverage across disposable Linux
Sandboxes, and retains the Darwin-native contracts on macOS. Linux hosts run
their supported native-clang contracts locally; other hosts retain those
checks in the Sandboxes. Both lanes green is the bar before shipping any
change.

`SCRIPTC_SANDBOX_NATIVE_REFERENCE` names a built checkout inside a prepared `SCRIPTC_SANDBOX_SNAPSHOT` or image: each lane copies that checkout's LLVM helper and runtime pack instead of rebuilding them when their source inputs are identical. Sandbox creation is rate limited per team in vCPUs per minute, so the runner retries a rate-limited creation with backoff. Larger Sandboxes (`SCRIPTC_SANDBOX_VCPUS` up to 32, with `SCRIPTC_TEST_WORKERS` at half the vCPUs) shorten the lanes most.

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

Name a new corpus program after what it tests, without a number: lowercase words joined by hyphens, such as `tests/corpus/intersection-restated-members.ts`, or a directory such as `tests/corpus/<name>/main.ts` for a multi-file program. Parallel changes kept taking the same next number; with names, two changes collide only when they add the same name, which git reports as a conflict. Leave existing numbered programs as they are: never rename or renumber them, and name a new program even when it extends a numbered family.

Record a new or remeasured program's CI cost (used to balance the test shards) in `tests/harness/corpus-costs/<program>.json`, not in `tests/harness/corpus-costs.json`; see the README there.

Before opening a PR that adds or changes corpus, diagnostic, or frontend fixtures, run `pnpm test:ts7 --baselines-only`. This fast completeness check uses the same fixture discovery as the parity suite; it does not type-check or replace behavioral parity. Generate missing preflight/order baselines, review their diagnostics and module order, and run the affected `order-parity.test.ts` batches before pushing. Keep existing baseline entries unchanged unless the corresponding behavior intentionally changes. The full `pnpm test:ts7` command also checks completeness before starting its sweep.

A change that must not cost good code anything, such as a compatibility fix that replaces a refusal, proves it with the zero-cost gate. The gate compiles the benchmark workloads, the self-hosted compiler, the self-hosting emitter fixtures, and the TypeScript corpus with two built checkouts. It requires byte-identical IR, LLVM, and release executables, and compile time within tolerance. `--allow=<regex>` names the change's pattern signature: programs whose sources match may differ, and the PR lists them. The gate classifies every other difference. A program is `runtime-only` when its IR and LLVM are identical and its executable differs only through runtime objects that differ between the two checkouts' runtime packs; the gate lists the changed runtime functions each such program links and the size change, and passes with a note, so a runtime C change does not fail the gate when no program's code changes. A program is `nondeterministic` when the baseline, building it again, differs from its own first build in the same artifacts; it also passes with a note. Any other difference is `differs` and fails the gate, which names the first differing function. `--strict` fails runtime-only and nondeterministic programs too, for a change that must leave every executable byte-identical. The gate also enforces the two-tier runtime separation: no executable may gain symbols from `DYNAMIC_TIER_PREFIXES` in `scripts/zero-cost-compare.mjs`, and fully typed benchmarks may link none; extend that list as dynamic-tier units land. `--quick` checks only the benchmarks; `--cachegrind` adds per-function instruction counts for executables that differ. Run it in a Sandbox with both checkouts prepared:

```bash
node scripts/zero-cost-gate.mjs --baseline=/vercel/sandbox/prev --candidate=. --allow='\barguments\b'
```

The whole gate takes 30 to 75 minutes on one 8-vCPU Sandbox, so shard it across Sandboxes. `--shard=i/n` splits the bench and corpus programs; the self-hosted compiler and the emitter fixtures run in shard 1, or alone with `--set=self`, and the candidate-source build overlaps the comparison builds on hosts with 40 GB or more. Each shard writes `--json`, and `node scripts/zero-cost-merge.mjs <shard.json>...` merges them into one verdict, recomputing the compile-time intervals over every shard. `--record-baseline-cache=<file>` builds only the baseline and records each program's artifact hashes; `--baseline-cache=<file>` then skips the baseline build of every program whose candidate artifacts hash the same, which halves the work for a change that leaves most programs identical. A record applies only to the built baseline checkout, toolchain, and paths it was made with, and is ignored otherwise; a program whose entry, relative imports, or optimization level changed since the record builds its baseline.

Test location follows scope:

- Co-locate white-box unit tests with implementation files under
  `packages/*/src`; name them after the source file (`cc.ts` → `cc.test.ts`).
- Put package-level API and integration tests in `packages/*/test`.
- Put cross-package differential, harness, and end-to-end tests in the root `tests/` tree.

Keep existing tests in place unless a change already touches their organization;
new tests should follow this convention.

## Numbered registries

Parallel changes must never pick the same number by hand. Each registry has one source of truth and a fast check:

- Diagnostic codes: claim a code by adding its row, in numeric order, to `DIAGNOSTIC_CODES` in `packages/compiler/src/diagnostics/codes.ts` before any site uses it. A shipped construct's code moves to `RETIRED_DIAGNOSTIC_CODES` and is never reused; codes that open work already uses are held in `RESERVED_DIAGNOSTIC_CODES`. `codes.test.ts` fails on a code without a row, a retired code in use, an unused row, or rows out of order, and two claims of one code are a merge conflict or a duplicate key.
- Dyn handle tags: add a new tag by name only to `SCR_DYNH_NEW_TAGS` in `packages/runtime/src/scr_dyn.h`, in name order; the enum numbers it. Pin a tag to an explicit value in `SCR_DYNH_TAGS` only when the LLVM backend needs its number. The header does not compile when two tags share a value, and `dyn-handle-tags.test.ts` names the problem.
- Runtime enums and flag bits the backend mirrors (`ScrDynKind`, `ScrMessageKind`, `ScrBytesElem`, `SCR_CLOSURE_KIND_*`, the `%ScrArr` spare flags) are checked against their C declarations by `packages/compiler/src/backend/llvm/runtime-registries.test.ts`. A new mirrored enum or flag set gets a check there, and C code names flag bits instead of writing their values.

Before taking a number in a pinned registry, run `node scripts/registry-claims.mjs`: it lists the diagnostic codes and pinned handle tags that open pull requests claim and reports collisions; `--check` reports only collisions with the current branch and exits 1 when there is one.

## Where things live

- `packages/compiler` — the frontend (tsc API to IR), typed IR, validator, serializer, and LLVM backend.
- `packages/runtime` — the C runtime distributed as precompiled runtime packs.
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
- Test evidence determines positive behavioral claims. Source manifests alone do not prove Node-compatible behavior.

Compatibility describes native compilation. There is no runtime JavaScript engine tier.

### Status contract

- `supported` — broadly implemented. This requires test evidence.
- `partial` — a useful implemented subset. This requires test evidence, but evidence may cover an API family rather than every documented overload.
- `refused` — a named compiler diagnostic exists. Never infer this status from absence.
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

`pnpm node-compat:backlog` emits native compilation work. Its actions are:

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
pnpm node-compat:backlog --tier=static --format=tsv
```

### Generated files

Never hand-edit these files:

- `packages/compiler/surface-manifest.json`
- `internal/compatibility/generated/node-v24-internal.json`
- `docs/src/generated/node-v24-compatibility.json`

Change compiler decision sources or the implementation-owned compatibility manifests, then regenerate. Use `pnpm manifest` when compiler decision tables change and `pnpm node-compat` whenever the Node pin, compatibility manifests, compiler surface manifest, changes. `pnpm node-compat --local` reclassifies the committed ledger without fetching Node's docs; it writes the same files as `pnpm node-compat` while the Node pin is unchanged.

Never resolve a merge conflict in these files by hand. Resolve the source conflicts, then run `node scripts/regen-generated.mjs`: it takes the merged-in branch's version of each conflicted generated file, regenerates all of them from the merged sources, and stages the ones that conflicted.

The public docs artifact must not expose repository test paths, internal source identifiers, engineering evidence bookkeeping, documentation/metadata headings, command-line or configuration-only entries, or rows that are N/A in the native tier. Those remain in the complete internal census under `internal/compatibility/generated/`.

### Landing compatibility work

For each API family:

1. Start from the backlog action and verification basis. Verify every `registry-gap` before assuming code is missing.
2. Read the pinned Node documentation, stability metadata, relevant Node source when needed, and existing scriptc implementation paths.
3. Define the native compilation scope.
4. Implement the smallest coherent behavior family. Preserve explicit refusals for unimplemented forms rather than silently diverging.
5. Add differential evidence that executes under Node and as a compiled binary. Cover stdout, stderr, exit status, success behavior, and important error shapes. A load-only export check does not prove behavior.
6. Update the implementation-owned source or manifest. Positive `supported` and `partial` mappings must name existing test evidence.
7. Run `pnpm manifest` if compiler surface tables changed, then run `pnpm node-compat`. Never patch generated JSON or headers.
8. Inspect the internal ledger and public artifact diff, and compare `pnpm node-compat:backlog` output before and after. Confirm the intended API family changed and unrelated rows did not.
9. Run focused tests, `pnpm node-compat:check`, and the full validation gate required for the change. If docs output changed, also run the docs gate.

Compatibility commands:

```bash
pnpm node-compat
pnpm node-compat:check
pnpm --filter @internal/compatibility check:upstream  # networked pinned-input check
```

## Documentation site

The docs site is a standalone pnpm workspace under `docs/`. It uses Next.js App Router and the public `@vercel/geistdocs` package with Labs branding. Content lives in `docs/content/docs`; local adapters under `docs/src` configure the package's layout, search, Markdown routes, and proxy. Keep shared runtime behavior in the package.

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

### Limitations page partials

`docs/content/docs/limitations.mdx` holds only the frontmatter, the headings, the anchor spans, and one `<include>` line per partial. The text lives in `docs/content/limitations/`:

- A labeled bullet (`- **Crypto:** ...`) is `docs/content/limitations/<section>/<label>.mdx`, for example `builtin-apis/crypto.mdx`. Edit that file to change the bullet.
- The other text of a section (paragraphs, code blocks, unlabeled lists) is `docs/content/limitations/<section>.mdx`; text before the first heading is `introduction.mdx`.
- `<section>` and `<label>` are the heading and label text in lowercase with each run of other characters replaced by `-`.
- Write one sentence per line; a bullet's continuation lines are indented two spaces. Markdown joins the lines, and edits to different sentences don't conflict. `pnpm lint` fails on a line that holds two sentences, and `node docs/scripts/limitations-partials.mjs fix` splits such lines.
- To add a bullet, add its file and an include line at its position in `limitations.mdx`, with a blank line on each side. Consecutive bullet includes render as one list.
- To add a section, add the heading to `limitations.mdx` and include the section's partial below it.

`node scripts/limitations-partials.mjs join` (from `docs/`) prints the page with its partials inlined. For a branch that still edits the single-file page, run `node scripts/limitations-partials.mjs merge <base> <theirs>`, where `<theirs>` is the branch's `limitations.mdx` and `<base>` is that file at the branch's merge base. It merges the branch's changes into the partials, or writes `docs/limitations.merged.mdx` with conflict markers to resolve and pass to `split`.

### Adding a docs page

1. Add `docs/content/docs/<topic>.mdx` with a `title` in YAML frontmatter. Geistdocs renders the page title, so do not duplicate it as a Markdown H1. `index.mdx` is served at `/docs`; other pages are served at `/docs/<topic>`.
2. Add the topic to `docs/content/docs/meta.json` to set sidebar order and groups.
3. Add the slug to `PAGE_TITLES` in `docs/src/lib/page-titles.ts` for the existing social image routes.
4. Add the page's href, title, and heading anchors to `docs/test/fixtures/migration-baseline.json` so the route tests cover it; pages added after the migration have no `legacy` URL.
5. Keep internal links on the canonical `/docs` paths. Redirect retired public URLs in `docs/next.config.mjs`.

### Docs development and verification

Do not start duplicate docs dev servers. Reuse the existing server and its hot reload process when one is running. CI-style builds must use a separate dist directory so they do not corrupt the dev server's `.next` state:

```bash
cd docs
NEXT_DIST_DIR=.next-check pnpm check
```

`pnpm check` generates the content source and route types, then runs the compatibility drift check, TypeScript check, production build, and HTTP route tests. It is required before landing docs or compatibility output changes. The route tests start and stop their own production server on an available local port and use `NEXT_DIST_DIR` when set. The site preserves the repository's `language:filename` fences through `docs/src/lib/remark-docs.ts`.

## Releases

Releases are maintainer-run; see [RELEASING.md](./RELEASING.md).
