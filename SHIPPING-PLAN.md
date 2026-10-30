# Shipping plan: React on scriptc

Eleven PRs, one per theme, each with its tests, corpus programs, cost files, order baselines and docs, plus the already-open `--define` PR. They're listed in priority order. Details and measurements for every item are in `REACT-REPORT.md`; the "Part" numbers below point there, and the full per-part history is in commit `7f0f6c502` (Parts 1–36) and `/tmp/REACT-REPORT-full-2026-10-28.md` (Parts 1–44).

**Where the code is:** branch `lfades/react-node-ssr` in this worktree. Most of the earlier work is in one large commit, `4d60d90ea` ("Compile React's server renderer from its Flow sources and speed up its checked-dynamic paths", 217 files), and has to be split by file and hunk. Later work is in focused commits, and the latest sessions' work is in the snapshot commit `0ef856f5f`. Each item names its source. The commits only carry the raw changes: each PR gets its own, new commits.

**Size:** about 9,800 lines of source added (122 files) and 38 corpus programs, plus tests, baselines and cost files.

## Merge order

The grouping keeps changes to the same functions inside one PR. Four orderings remain, because a later PR builds on code an earlier one changes. Cut each of these PRs from `main` after its predecessor has merged, or rebase it then.

| Order | Why |
|---|---|
| 2 → 3 → 4 | Frontend lowering: shared functions in `lower-*.ts`, `generic-functions.ts`, and `loadProgram7` in `program.ts` |
| 5 → 6 → 9 | Runtime object model: shared functions in `scr_json.c`, `scr_js_object.c`, `js-ic.ts` |
| 7 → 10 | `retainSym`/`releaseSym` in `shapes.ts` |
| 8 → 11 | `loadPartition` in the native helper's `emit.cpp` |

PR 1 is independent. Across these chains, PRs can merge in any order.

## Tracking

Statuses: not started → in progress → ready for review → approved → committed → PR open → merged. Paste each PR's link when it's opened.

| PR | Branch | Based on | Status | Link |
|---|---|---|---|---|
| `--define` | `lfades/define-env` | `main` | open | |
| 1 Correctness fixes and leaks | `pr/01-correctness` | `main` | not started | |
| 2 React Node SSR compatibility | `pr/02-react-compat` | `main` | not started | |
| 3 Native Flow support | `pr/03-flow` | `pr/02-react-compat` until 2 merges | not started | |
| 4 npm-static type inference | `pr/04-npm-static-inference` | `pr/03-flow` until 3 merges | not started | |
| 5 Checked-object memory | `pr/05-checked-object-memory` | `main` | not started | |
| 6 Property access | `pr/06-property-access` | `pr/05-checked-object-memory` until 5 merges | not started | |
| 7 Dynamic operations in compiled code | `pr/07-dynamic-operations` | `main` (after 3 if lowering conflicts) | not started | |
| 8 Ownership analyses | `pr/08-ownership` | `main` | not started | |
| 9 Element capsules and the typed-app boundary | `pr/09-capsules-typed-boundary` | `pr/06-property-access` until 6 merges | not started | |
| 10 Tagged unions with numbers, scalar records | `pr/10-tagged-unions` | `pr/07-dynamic-operations` until 7 merges | not started | |
| 11 Profile-guided optimization | `pr/11-pgo` | `pr/08-ownership` until 8 merges | not started | |

## How we ship

**All work is committed** on `lfades/react-node-ssr`: the latest sessions' changes are in `0ef856f5f`.

**One worktree per PR.** Each PR has its own agent and its own working folder, backed by the same `.git` (no copies), so agents work in parallel without touching each other's files. This folder (`scriptc-react`) stays the source: `lfades/react-node-ssr` with all the work, left unchanged while shipping.

| Folder | Branch |
|---|---|
| `scriptc-react` | `lfades/react-node-ssr` (source, read-only while shipping) |
| `scriptc-pr-01` … `scriptc-pr-11` | `pr/01-correctness` … `pr/11-pgo` (see the tracking table) |

```console
$ git -C ~/all/vercel/scriptc-react worktree add ../scriptc-pr-01 -b pr/01-correctness origin/main
```

Each worktree needs its own `pnpm install` (fast: pnpm hard-links from a shared store) and build. When a PR doesn't change them, copy the slow native pieces (`packages/llvm-darwin-arm64/bin/`, the runtime pack artifacts) from the source worktree instead of rebuilding. Agents running tests at the same time should cap workers (`SCRIPTC_TEST_WORKERS=2`).

**Bringing changes in, unstaged.** The agent brings every change relevant to its PR into its worktree and leaves it unstaged. No commits until you've reviewed.
- whole files that belong to the PR: `git restore --source=lfades/react-node-ssr --worktree -- <path>` (`git checkout <branch> -- <path>` would also stage them);
- pieces of `4d60d90ea`, or files shared by several PRs: `git restore -p --source=lfades/react-node-ssr --worktree -- <file>`, choosing this PR's hunks;
- focused commits: `git cherry-pick -n <hash>`, then `git reset` to unstage.

**Chains** (2 → 3 → 4, 5 → 6 → 9, 7 → 10, 8 → 11): stack them. Cut the later PR's branch from the earlier one and open it with that branch as its base (`gh pr create --base pr/02-react-compat`). When the earlier PR merges, retarget the later one to `main` and rebase:

```console
$ git rebase --onto origin/main pr/02-react-compat pr/03-flow
```

Any conflicts are resolved once, at that point.

## Agent workflow (one agent per PR)

1. **Set up** the PR's worktree and branch (from `origin/main`, or from the predecessor's committed branch for a chained PR), `pnpm install`, build. Mark the PR "in progress".
2. **Bring in all the changes** listed in the PR's section, unstaged, as above. Nothing from other PRs.
3. **Add the missing tests.** Every **add** item in the PR's section, plus anything else the changes need: we optimized first and weren't complete with tests. Corpus programs are named after what they test, with cost files and order baselines.
4. **Run only the tests relevant to the changes:**
   - the co-located unit tests of every changed source file (`npx vitest run <file>.test.ts`) and the package tests that cover them;
   - the PR's corpus programs, existing and new, plain and sanitized (`npx vitest run tests/harness/differential.test.ts -t <program>`, then with `SCRIPTC_SAN=1`);
   - the snapshot and diagnostic tests the changes affect;
   - for compiler and runtime changes, React's HTML against Node (`/tmp/ft/cmp.mjs`) and instructions per render (`/tmp/ipr.sh`);
   - `pnpm lint` and `pnpm format:check`.
5. **Report back and stop.** What's in the PR (files, what each change does), the tests added, the tests run and their results, React's numbers where relevant, and open questions. Mark it "ready for review".
6. **After your review:** address the feedback, then make the branch's commits (repository style; one commit per logical change is fine). Mark it "committed". Opening the PR, with the full gates below, is a later step.

**Parallel waves.** A chained PR starts once its predecessor's branch is committed, and cuts its branch from it.

| Wave | PRs | Starts |
|---|---|---|
| 1 | 1, 2, 5, 7, 8 | right away, in parallel |
| 2 | 3 (after 2), 6 (after 5), 10 (after 7), 11 (after 8) | as each predecessor is committed |
| 3 | 4 (after 3), 9 (after 6) | as each predecessor is committed |

## For every PR

These are what a finished PR has. Steps 1–6 above cover all of them except the full gates, which run before the PR is opened.

- [ ] Its changes brought in from the source, nothing from other PRs.
- [ ] Corpus programs that pin the behavior against Node (named, not numbered), with cost files in `tests/harness/corpus-costs/<program>.json`.
- [ ] Order baselines: `pnpm test:ts7 --baselines-only`, then the affected `order-parity.test.ts` batches.
- [ ] `pnpm lint`, `pnpm format:check`.
- [ ] Docs and limitations partials where behavior is user-visible; the docs gate (`cd docs && NEXT_DIST_DIR=.next-check pnpm check`) when docs change.
- [ ] Before opening the PR: the full gate `pnpm test:sandbox` (both lanes), and the zero-cost gate for changes that must not affect other programs.
- [ ] React still renders identical HTML (`/tmp/ft/cmp.mjs`), with instructions per render recorded in the PR description.

## Not shipping

- `REACT-REPORT.md` and `SHIPPING-PLAN.md` (working notes). `pr-react-node-ssr.md` and `pr-define.md` are PR text drafts.
- The young generation for checked values (`f5bdb914d`, reverted by `5dd9c1a17`).
- Deferred reference counting (Parts 38–42, removed).
- The report-only commits (`8aa6141aa`, `73abf2be1`, `2bd7ff141`, `d1c5c8ec9`, `24cff8a62`, `1c9322981`, `0c1fb31bc`, `7f0f6c502`).

## Already open

- [ ] **`--define`** (`b96da637b`, branch `lfades/define-env`, text in `pr-define.md`): build with `process.env` values fixed, compiling only the branches they select. This branch is based on it.

---

## 1. Correctness fixes and leaks

Independent. Small; each fixes a real bug.

- [ ] **HTTP responses leaked their `end()` AsyncLocalStorage context** (Part 2, item 9; in `4d60d90ea`). `scr_http_proto_sweep` (`scr_http.c`) releases `end_als` once `close` has fired; it was 45 KB per request. Listener closures attached through untyped values get a traced box (`scr_dyn_listener_closure`, `scr_dyn_handle.c`).
- [ ] **Slots of emitter and event-target subclasses are traced** (Part 35; `9bb4e29f0`). Every subclass gets the synthetic `<listeners>` field, so stream → listener → closure → … cycles are collected.
- [ ] **Evolving `let` bindings written only by `for…in` heads** (Part 23; in `4d60d90ea`, `inferredEvolvingLetType` in `lower-stmts.ts`). They're strings, and comparisons are no longer treated as writes.
- [ ] **String indexing with a union key** (Part 6; in `4d60d90ea`, `element-access.ts`). A JS index whose union holds more than a number takes the keyed dynamic read.

**Tests:**
- existing: `cycle-analysis.test.ts`, `for-in-key-binding-inference.cjs`, `string-index-union-key.cjs`;
- **add:** an HTTP program serving many requests inside `AsyncLocalStorage.run`, checked by the RC audit in the sanitized lane.

## 2. React Node SSR compatibility

All in `4d60d90ea`. First in the 2 → 3 → 4 chain. The draft text `pr-react-node-ssr.md` covers the Part 1 fixes.

- [ ] **Lowering** (Part 1): discarded `&&`/`||` ending in a void conditional; `RegExp(pattern, flags)` without `new`; JS union bindings later written with another type; closures inside a destructuring initializer (TDZ box).
- [ ] **Builtins** (Part 1): `ArrayBuffer`/typed-array prototype reads refuse; feature checks fold to Node 24's answer; `new` over builtin module members (`util.TextEncoder`, `async_hooks.AsyncLocalStorage`).
- [ ] **Promise own properties** (Part 1; runtime): React's `use()` writes `status`, `value` and `reason`.
- [ ] **Objects extended by `Object.defineProperty`** stay checked-dynamic (Part 1; `returnsOpenJsBinding`).
- [ ] **Members of maybe-null JS values** (Part 6; `lowerPresentArmMember`): reads and calls on `T | null | undefined` throw Node's `TypeError` on the unit arms and are typed otherwise.
- [ ] **`this` prologue only where `this` or `super` is read** (Part 2; `readsReceiver` in `lower-functions.ts`).

**Tests:**
- existing: `discarded-logical-void-conditional.cjs`, `regexp-call-without-new.cjs`, `js-union-binding-later-writes.cjs`, `destructuring-capture-in-initializer.cjs`, `builtin-prototype-feature-checks.cjs`, `new-builtin-module-member/`, `promise-own-properties.cjs`, `js-object-define-property-binding.cjs`, `nullable-receiver-present-arm.cjs`, coverage snapshot updates.

**Docs:** `limitations/builtin-apis/{regular-expressions,arraybuffers-and-typed-arrays,prototypes}.mdx`.

## 3. Native Flow support

React compiled from its own Flow sources: the largest single speedup (Parts 20–23: `/large` 19.6 → 8.0 ms). All in `4d60d90ea`. After PR 2.

- [ ] **Flow translation and project configuration** (Parts 21–22):
  - `frontend/flow/translate.ts`, `index.ts`, `frontend/source-edits.ts`, `frontend/module-substitutions.ts`, resolution through `flowPresentedPath`;
  - `project-config.ts`: `scriptc.flow`, `flow.types`, `constants`, `moduleSubstitutions`;
  - the lazy `hermes-parser` dependency (`packages/compiler/package.json`, `pnpm-lock.yaml`);
  - translator details: tuples for `const x = [a, b.c]`, silenced nulls, `unique symbol` overrides, variadic overloads for `arguments` readers, module `let x = null` assigned only `new C()` as `C | null`, `(x: any).m` as `x!.m`.
- [ ] **Flow modules follow JavaScript where annotations stop, and program modules resolve like code** (Part 22): `isJsLikeSourceFile`; TypeScript importers of CommonJS program modules; bare specifiers resolved through tsconfig `paths` are program code.
- [ ] **Function values** (Part 22): generic functions in unpinned slots are their erased instance; `queueMicrotask` as a typed value; `Function.prototype.bind` as an interned builtin; the typed `this` ABI only when every reference binds the receiver.
- [ ] **`AsyncLocalStorage.run` with a typed callback** (Part 22; `builtins/async-context.ts`).
- [ ] **Type-mapping fixes** (Parts 17, 21–22):
  - object-literal fields typed as all-`any` instantiations take the typed container;
  - `arguments.length` skips the stdlib fence;
  - `Set`/`Map` of a recursive union still being mapped;
  - union-arm diagnostics include the arm's blocker;
  - specialization fallback (`specializationFallback`).

**Tests:**
- existing: `frontend/flow/translate.test.ts`, `cjs-namespace-import-from-typescript/`, `import-forms` diagnostic snapshot, `generic-function-erased-value.ts`, `queue-microtask-typed-value.ts`, `function-prototype-bind-value.cjs`, `async-local-storage-run-typed-callback.ts`, snapshot `retired-engine-968`, the npm-static test "a specialization that reaches a checked-dynamic form forwards to the default instance" with fixture `specialization-fallback-cli.mjs`.

**Docs:** **missing**. A Flow page or section: configuration, what translates, what doesn't.

## 4. npm-static type inference

Types untyped published packages, like React's published build. All in `4d60d90ea`. After PR 3.

- [ ] **Binding types from syntax** (Parts 6, 14–15; `npm-static-binding-types.ts`): module and local bindings, function results, `@inferred` trust, typed-array annotations; the `hasJsTypeAnnotation` span fix.
- [ ] **Flow-based variable splitting** (Parts 8–9, 14–15; `npm-static-binding-splits.ts`).
- [ ] **Bindings and hoisting** (Parts 8, 15): `jsBindingKeepsInitializer`; block-scoped `var` reads without an `undefined` arm (`var-hoisting.ts`); JS class fields from chained assignments.
- [ ] **Class-instance arguments for per-call-site instances** (Part 9; `implicitCallInstance`).

**Tests:**
- existing: `npm-static.test.ts` ("module bindings take the types of the values written to them"), fixture `module-binding-types-cli.mjs` with `chunk-writer`, `block-var-initialized-reads.cjs`.

**Decide** whether the report-only shape-inference changes (`shape-inference/analyze.ts`, `domain.ts`) ship here or are dropped. Nothing consumes them.

## 5. Checked-object memory

First in the 5 → 6 → 9 chain.

- [ ] **Object life cycle** (Parts 26–28, 36):
  - 32-byte entries (`ScrDynAccessorPair` for accessors);
  - statement `push` and constant-key literals take over their values;
  - constant-key object literals in one call (`scr_js_new_literal`) with one-pass fill (`scr_dyn_tier_fill`);
  - no `free(NULL)` calls; exact key bytes per object;
  - pooled keys (scan only key slots, 2 MB budget, untouched objects skip the scan);
  - teardown in a loop with shared leaves released inline;
  - plain objects die through a short path into a clean pool; shapes cache their key arrays;
  - the dispose hook is installed only while a weak collection holds a key or a record keeps its source.
- [ ] **Immortal boxes** (Parts 15, 18, 30, 35–36):
  - per-site literal boxes (`@sc_dyn_lit_N`), uncounted by the RC audit;
  - one immortal box per immortal string and top-level function, in a growable table with recent caches;
  - evicted recent boxes are released (the leak fix);
  - lazy shared integer nodes 256–4096.
- [ ] **Output path** (Parts 14, 18, 24, 26; `scr_bytes.c`, `text-codecs.ts`):
  - byte-array headers recycle through a free list;
  - typed `encodeInto` builds `{ read, written }` from two numbers;
  - `TypedArray.set` of ≤16 bytes is inline;
  - proven-ASCII `encodeInto` is one copy;
  - `Buffer.byteLength(s, "utf8")` returns the length directly;
  - pure-read library calls lend their operands.

**Sources:** `4d60d90ea` (literal boxes, integer nodes, `scr_js_new_literal`, output path), `ca5524f31`, `452020b1a`, `9299930a0`, `eb3918bf4`, `cbf3e4f82`, `28cf5c66b`, `84bc5f66f`, and the literal-table recent cache from `896c1c378` (its `scr_json.c` hunks).

**Tests:**
- existing: `dyn-literal-values.cjs`, `dyn-recent-box-eviction.cjs`, `dyn-integer-values.cjs`, `text-encoder-encode-into-typed.mjs`;
- **add:** object churn (accessors after compaction, pooled reuse across shapes, weak collections installing and removing the hook); short `set` and ASCII `encodeInto` cases.

## 6. Property access

After PR 5.

- [ ] **Typed records from untyped code (record capsules)** (Parts 2, 14–15, 18, 24, 36):
  - views and writes: drop the plain view after a commit; the per-shape `set` hook; undeclared keys answer `undefined`;
  - caches: the record field cache; reads and writes at cache sites;
  - in place: inline reads through `dyn_offsets`; symbol fields read in place;
  - `typeof` answered inline for capsules.
- [ ] **Absent keys** (Parts 25, 29, 36): each shape's key filter (runtime, and compile-time bits at get sites); absent properties of string primitives.
- [ ] **Keyed access** (Parts 23–24, 29):
  - writes: keyed-store sites through shape transitions; string-typed computed keys stored as strings;
  - reads: megamorphic keyed reads share the load table; keyed loads scan entries; canonical index keys return at once;
  - `for…in` keys read back by address; overlapping 8-byte key compares; `scr_dyn_property_owner` uses the indexed lookup.
- [ ] **Function properties** (Parts 23, 25–26, 36): receivers at get sites; answers remembered per (function, key); `name` strings reused; property tables lent; casts remember the last matching signature.
- [ ] **Typed arrays and streams from untyped code** (Parts 17–18, 26):
  - `byteLength`/`length` answered at cache sites;
  - live multi-argument `push` on typed arrays;
  - name reads on native arrays through a shared stand-in;
  - runtime stream methods called without building the stream's view.
- [ ] **Bug fixes in this branch's own new code** (from the Part 23 corpus run):
  - a computed store with a checker-`string` key holding `undefined` no longer traps;
  - the live-record write hook skips fields whose checks need handle kinds.

**Sources:** `4d60d90ea`; `5f37c9774`; `c45643860`; `20f61a5e5`; `896c1c378` (record symbol fields, function memo); the keyed-read part of `654c7488a` (`scr_js_object.c`).

**Tests:**
- existing: `record-capsule-dynamic-field-access.cjs`, `computed-store-fresh-objects.cjs`, `function-property-reads.cjs`, `dyn-typed-array-sizes.cjs`, `typed-array-untyped-multi-push.ts`, `expr-stream-bridges.test.ts`;
- **add:**
  - absent-key patterns (`props.ref`, `config.key`, `Object.prototype` members still found, `String.prototype` names);
  - megamorphic `row[column]` and `for…in` read-back;
  - stream methods and array name reads;
  - both bug fixes.

## 7. Dynamic operations in compiled code

Before PR 10.

- [ ] **Inline reference counting** (Parts 7, 14, 23; `shapes.ts`, `emit-module.ts`, `dyn.ts`):
  - immortal `undefined`/`null` read as globals;
  - `retainDyn` inline;
  - guarded releases in functions over the inline cap;
  - inline retains and string releases;
  - inline fast paths for bytes, union and array retains and releases by default.
- [ ] **Comparisons and tests inline** (Parts 15, 18, 22–24; `expr-dynamic.ts`, `expr-async.ts`, `dyn.ts`):
  - checked casts: kind tests first, and the `string` check inline;
  - equality: `===` between dynamic values; strict equality against boxed literals (switch cases); string-literal and symbol comparisons;
  - truthiness and `typeof v === "object"` by kind.
- [ ] **`hasOwnProperty.call` through an alias** (Part 14; `lowerObjectOwnPrototypeCall`).
- [ ] **The `arguments` count token** (Part 23; `lower-functions.ts`, `lower-calls.ts`).
- [ ] **`exec` on short ASCII subjects runs the compiled matcher first** (Part 24; `scr_regex.c`).
- [ ] **Fix** the two `shapes.test.ts` failures the inline changes caused ("release builds inline only string and dyn retains and releases and Map retains", "a function over the budget calls the runtime release at every site").

**Sources:** `4d60d90ea`. The `hasOwnProperty` and `arguments` changes touch lowering files that PRs 2–4 also change (in other functions), so cut this PR after PR 3 if it conflicts.

**Tests:**
- existing: `dyn-strict-equality-kinds.cjs`, `dyn-string-literal-comparisons.cjs`, `dyn-switch-literal-cases.cjs`, `dyn-truthiness-kinds.cjs`, `typeof-object-dynamic-kinds.cjs`, `has-own-property-alias-call.cjs`, `arguments-count-without-surplus.mjs`;
- **add:** `exec` with matching and non-matching short and long subjects.

## 8. Ownership analyses

Before PR 11.

- [ ] **Last-use moves and lends** (Parts 24–25, 28, 44):
  - call-argument moves (`ir/call-sequences.ts`, `emitSequenceStmts`; `4d60d90ea`);
  - parameters moved into record literals and unwritten parameters lent to reads (`3b1d2d4cc`);
  - borrowed reads through retypes (`4d60d90ea`);
  - union field writes move their value (`0ef856f5f`: `lowerUnionFieldWriteStmt` in `union-fields.ts` and `lower-stmts.ts`; the move through a final `if`, `lastUseReads` in `local-extents.ts` and `emitter.ts`).
- [ ] **Proof-based retain/release pair removal** (Part 37; `0ef856f5f`; `native/llvm-codegen/src/rc-pairs.cpp`/`.h`, `emit.cpp`, `CMakeLists.txt`). Decide which debug switches to keep: `SCRIPTC_NO_RC_PAIRS`, `SCRIPTC_RC_PAIRS_STATS`, `SCRIPTC_RC_SITES`, `SCRIPTC_RC_DEBUG`.
- [ ] **Two crossings no longer make types mutable for the cycle collector** (Part 44; `0ef856f5f`; `cycle-mutability.ts`): opaque live references of records with no checked-dynamic form, and `JSON.stringify` of JSON-inert data.

**Tests:**
- existing: `cycle-analysis.test.ts` (add cases);
- **add:**
  - corpus programs that observe identity and lifetimes across moves;
  - one from `/tmp/uw/uw.ts`;
  - helper tests for the pair pass (pairs removed only under each proof; temporaries);
  - one from `/tmp/cy/alscycle.ts` (sanitized lane).

## 9. Element capsules and the typed-app boundary

After PR 6. The typed bench app went from 19% slower than the untyped one to within 4%.

- [ ] **Element capsules: moves and reuse** (Parts 29, 43, 45):
  - fresh records boxed without an identity entry (`654c7488a`, its `scr_json.c` and `expr-dynamic.ts` parts);
  - the typed-ref identity table keeps the referent (`4d60d90ea`);
  - moved constructors take over the record's reference (`0ef856f5f`);
  - the capsule pool, with the fix that every unregistered construction reuses its head (`0ef856f5f`).
- [ ] **`for…in` copy loops, including typed records** (Parts 19, 24–25, 45):
  - copy loops become one runtime call (`ir/for-in-copies.ts`); owned sources are adopted (`scr_js_adopt_own_except`), with key checks memoized (`4d60d90ea`);
  - shared key snapshots (`scr_js_for_in_keys`; `4d60d90ea`);
  - record capsule sources copied straight into a shaped object (`0ef856f5f`; `scr_js_copy_record_except`, `scr_js_fill_shape`).
- [ ] **Record-source decisions remembered per (shape, layout)** (Part 45; `0ef856f5f`; `scr_record_source_note`, `scr_js_shape_identity`).

**Tests:**
- existing: `for-in-shared-key-snapshots.cjs`;
- **add:**
  - capsule types alternating at scale (RSS bounded);
  - element identity through arrays, `Map`, `WeakMap`, `Set`, props and `Children.toArray`;
  - programs from `/tmp/rc/main.ts` and `/tmp/rs/main.ts`;
  - adoption cases (sole owner, shared source, excluded keys).

## 10. Tagged unions with numbers, and scalar records

After PR 7.

- [ ] **Tagged unions** (Parts 16, 19, 23; `4d60d90ea`):
  - `string | Uint8Array`-style unions as a pointer with the arm in its low bits;
  - `Uint8Array | null | undefined` as a nullable pointer;
  - retypes between equal tag layouts are free;
  - safe array reads fused with their narrowing (`%arr.idxIn`).
- [ ] **Numbers in tagged unions** (Part 46; `0ef856f5f`):
  - `string | number`-style unions without heap boxes: doubles offset by 2^49, pointers below;
  - boxed relatives stay boxed;
  - representation-aware helpers in `dyn.ts`, `expr-callbacks.ts`, `expr-dynamic.ts`, `expr-primitives.ts`, `expr-records.ts`, `expr-stream-bridges.ts`, `walkers.ts`;
  - `SCRIPTC_TAGGED_NUMBERS=0` turns it off.
- [ ] **Scalar replacement of fresh numeric record literals** (Part 23; `ir/scalar-records.ts`).

**Tests:**
- existing: `nullable-uint8array-values.mjs`, `union-array-reads-into-wider-slots.ts`, `scalar-records.test.ts`;
- **add:** a tagged-union program; programs from `/tmp/nu/nt.ts` (all tagged) and `/tmp/nu/nu.ts` (with union map keys).

## 11. Profile-guided optimization

After PR 8. All in `0ef856f5f`.

- [ ] **macOS** (Part 47): `native-profile.ts` allows it; `process.exit` writes the profile there (a weak `__llvm_profile_write_file` on Mach-O, `scr_lib.c`).
- [ ] **The profile covers the runtime** (Part 48):
  - the release flavor ships complete unit bitcode (`full_bitcode`), from both pack builders; `runtime-pack-core.ts` and `runtime-pack.ts` read it;
  - profiled builds compile the runtime units with the program (`index.ts`, `native-codegen.ts`, `link-plan.ts`; helper `--runtime-module`/`--runtime-output` in `emit.cpp`/`emit.h`, with a strong-over-weak pre-scan and stack-probe attribute cleanup).
- [ ] **Termination signals write the profile** in instrumented builds (Part 48; `scr_profile_generate`, `scr_lib.c`, `scr_console.c`).

**Docs:** usage text, `cli.mdx`, `how-it-works.mdx`.

**Tests:**
- existing: `native-profile.test.ts`; `packages/cli/test/profile.test.ts` (enabled on macOS, plus the termination-signal test);
- **add:** a test that a profiled build covers runtime functions.

**Before merging:** build the Linux packs with `full_bitcode` and run the profile tests there; CI builds packs with the pinned LLVM 22 clang; runtime packages grow by about 21 MB each.
