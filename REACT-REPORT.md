# React on scriptc: status report

Last updated 2026-10-28. This is a condensed version. The detailed per-part history is in git (`7f0f6c502` has Parts 1–36 in full) and in `/tmp/REACT-REPORT-full-2026-10-28.md` (Parts 1–44, before this summary; a copy is in `/var/folders/9t/dl6s3x6n57df07s6xs4jvyfr0000gn/T/opencode/`).

> **Working rules from the user:**
> - **Tests:** don't run scriptc's test suites or corpus shards while optimizing. Validate by building React and comparing its HTML with Node, by instructions per render and RSS, and by small repros compared with Node. Full testing comes at the end. Never call tests "regression" tests.
> - **Git:** no commits or pushes. The user never wanted commits; leave changes unstaged. Worktrees and branches only with permission.
> - **Fixes:** general scriptc fixes only. Don't modify React, and don't hack around a gap just to make React work. When correct behavior can't be guaranteed, refuse rather than miscompile.
> - **Direction:** a good static compiler, not a faster dynamic tier. Small steps that lead to bigger ones are welcome, and so are big changes. Move fast: change, measure, change again.
> - **Code:** compact and correct, no defensive code, no comments that restate the code.
> - **Explanations:** simple. Keep this report updated with progress.
> - **Demo:** don't mention the user's local demo in PRs or docs; React can be an example.

## Goal

Compile the server side of React apps to native executables with scriptc, and make them as fast as Node or faster, using only general compiler and runtime improvements. Later: the edge renderer (`react-dom/server.edge`), plugin-rsc, then Rebask (roadmap: `/Users/lfades/all/my-own-next/scriptc-rebask.md`).

## Current state

React v19.3.1 is compiled from its own Flow sources, unmodified, with the bench app unchanged. HTML is byte-identical to Node on every route (`/hello`, `/medium`, `/large?n=500`, `/large?n=50`, `/suspense`).

| | Node 24 | scriptc now |
|---|---|---|
| `/large` render | 3.6 ms | about 5.06 ms (119.6M instructions) |
| `/medium` render | 0.2 ms | about 283 µs |
| Startup to first response | 45 ms | 4.6 ms |
| Idle memory | 60.5 MiB | 6.8 MiB |
| RSS after 3,000 `/large` renders | | 56–59 MB, bounded |

Where scriptc already wins: output (chunk writing and encoding) is 2.2× faster than Node's. Where it loses: memory work (allocation, freeing, reference counting, cycle collection) is about 10× Node's, and generic dynamic operations in React's untyped paths (props, elements, component calls) are about 2× slower.

The compiled code itself is close to V8. The gap is runtime calls out of compiled code: object life cycle, reference counting (about 2.8M retain/release calls per render), property probes, and boxes. The profile is flat; no runtime function is above about 4%.

## Repositories

| Path | What |
|---|---|
| `/Users/lfades/all/vercel/scriptc-react` | Branch `lfades/react-node-ssr`, based on `lfades/define-env`. All React work. |
| `/Users/lfades/all/vercel/scriptc-define` | Branch `lfades/define-env`: the `--define` PR, merged with main. PR text `pr-define.md` (untracked). |
| `/Users/lfades/all/my-own-next/react-src` | React v19.3.1 source checkout (`react/`, never modified) and the static project (`static/`: `package.json` Flow config, `tsconfig.json` paths, `flow-globals.d.ts`, `bench/` copies of the bench app). |
| `/Users/lfades/all/my-own-next/scriptc-ssr-bench` | The benchmark monorepo for the published-React builds (Turborepo + pnpm; not a git repo yet). |
| `/Users/lfades/all/vercel/scriptc` | Branch `lfades/split-cjs-table-reexports`, PR #2178. Not needed for React. |
| `/Users/lfades/all/vercel/scriptc-parked/` | Parked passes (constructor classes, direct calls) from the published-React static attempt. |

**Commit state of `lfades/react-node-ssr`:** 28 commits over main. `4d60d90ea` holds the compatibility fixes, Flow support and the early speedups. Later commits cover entry compaction, container moves, teardown loops, parameter moves, megamorphic reads, absent-key filters, immortal boxes, the two leak fixes (`cbf3e4f82`, `9bb4e29f0`), the object redesign (`84bc5f66f`, `896c1c378`, `28cf5c66b`), string-primitive absent reads (`20f61a5e5`), and report updates. The young generation was committed and reverted (`f5bdb914d`, `5dd9c1a17`).

**Uncommitted (unstaged) right now:**
- the proof-based retain/release pair pass (`native/llvm-codegen/src/rc-pairs.cpp`/`.h`, `emit.cpp`, `CMakeLists.txt`);
- moved element capsules and the capsule pool, with the pool fix of Part 45 (`scr_json.c`, `expr-dynamic.ts`);
- record capsules copied straight into shaped objects, and the record-source memo (`scr_js_object.c`, `scr_json.c`);
- union field writes that move their value (`union-fields.ts`, `lower-stmts.ts`, `local-extents.ts`, `emitter.ts`);
- the two cycle-mutability exceptions (`cycle-mutability.ts`);
- numbers in tagged unions (`nullable-unions.ts`, `union-repr.ts`, `shapes.ts`, `emitter.ts`, `dyn.ts`, `expr-callbacks.ts`, `expr-dynamic.ts`, `expr-primitives.ts`, `expr-records.ts`, `expr-stream-bridges.ts`, `walkers.ts`);
- PGO on macOS (`native-profile.ts`, `scr_lib.c`, `usage.ts`, `cli.mdx`, `profile.test.ts`, `native-profile.test.ts`);
- the runtime under the app's profile (`emit.cpp`, `emit.h`, both pack builders, `runtime-pack-core.ts`, `runtime-pack.ts`, `index.ts`, `native-codegen.ts`, `link-plan.ts`, `scr_lib.c`, `scr_console.c`, `how-it-works.mdx`);
- this report.

## Toolchain and measuring

- **PATH:** `PATH="/opt/homebrew/opt/llvm@22/bin:$PATH"` for every build.
- **CLI:** `node /Users/lfades/all/vercel/scriptc-react/packages/cli/dist/bootstrap.js build|run|coverage <file>`. Always set `SCRIPTC_NO_CACHE=1` while iterating.
- **Compiler only:** `cd packages/compiler && node ../../node_modules/typescript/bin/tsc -p tsconfig.json` (about 35 s).
- **Runtime C changes:** `npx -y pnpm@11.1.3 --filter @scriptc/runtime-darwin-arm64 build:native` from the repo root (about 1 min), then rebuild the binaries.
- **Codegen tool (`native/llvm-codegen`):** `npx -y pnpm@11.1.3 --filter @scriptc/llvm-darwin-arm64 build:native`.
- **Full install and build:** `CI=true npx -y pnpm@11.1.3 install --frozen-lockfile`, then `npx -y pnpm@11.1.3 -r build`.
- **React builds:** from `/Users/lfades/all/my-own-next/react-src/static/bench`: `build render-loop.mjs -o /tmp/kl/SNN '--define=process.env.NODE_ENV="production"'`, and `server.mjs` → `/tmp/kl/SNN-server`.
- **HTML check:** `PATH="/Users/lfades/Library/Application Support/fnm/node-versions/v24.22.0/installation/bin:$PATH" node /tmp/ft/cmp.mjs /tmp/kl/SNN-server`. All five routes must say `same`. Use Node 24.22.0, the pinned release: the machine's default 24.16 differs in stream batching and error messages.
- **Instructions per render** (the primary metric; machine load doesn't move it): `/tmp/ipr.sh SNN`, the difference between 250 and 50 renders.
- **Wall time:** `ROUNDS=16 /tmp/ab.sh A B A B`, same-run comparisons only. Don't use `N` for rounds: the render loop reads it as `/large`'s row count.
- **RSS:** `/usr/bin/time -l env NODE_ENV=production WORKLOADS=/large RENDERS=3000 WARMUP=0 /tmp/kl/SNN`.
- **Profile:** `/tmp/ft/prof.sh SNN out` (names, not paths), then `sort -rn /tmp/ft/out.top`; callers with `python3 /tmp/rtcallers.py /tmp/ft/out.txt FUNC`; categories with `/tmp/np/cat.py` (Node's profile is in `/tmp/np/`).
- **Per-instruction sampling:** `python3 /tmp/addsampler.py add|remove` (Mach thread sampler, `/tmp/pcsampler.c`, env `SCR_PCPROF=file`), analyzed with `/tmp/pcprof.py` and `/tmp/hotins.py`. A `SIGPROF` sampler records page-fault sites on macOS, not time.
- **Retain/release site counts:** `/tmp/rcrun2.sh TAG` (codegen env `SCRIPTC_RC_SITES=1`), with `/tmp/rcsites.py` and `/tmp/rccount.py`. Pass diagnostics: `SCRIPTC_NO_RC_PAIRS`, `SCRIPTC_RC_PAIRS_STATS=<file>`, `SCRIPTC_RC_DEBUG=<fn>`.
- **Repros (`/tmp/ad`):** `lit.cjs b.mjs acc.cjs fi.cjs ab.cjs kp.cjs sb.cjs a.mjs idt.cjs fnmemo.cjs` must match `n_<file>.txt`. `strget.cjs` and `fb.cjs` differ only by known gaps. Also `/tmp/uw/uw.ts` (union writes) and `/tmp/cy/alscycle.ts`.
- **Sanitized check of one file:** `/tmp/dp/san1.sh FILE`. It caches Node's output by file name in `/tmp/dp/<name>.n`; delete that after editing the file.
- **Sanitizers:** `--sanitize` builds with ASan and the runtime RC audit, which fails at exit and lists live counts if anything leaks.
- **Before a PR:** lint and format (`npx -y pnpm@11.1.3 lint`, `format:check`), order baselines (`npx -y pnpm@11.1.3 test:ts7 --baselines-only`, record with `SCRIPTC_UPDATE_BASELINES=1 ... vitest run packages/compiler/test/ts7/order-parity.test.ts -t "re-record"`), the docs gate if docs changed, and the full gate (`pnpm test:sandbox`).
- **npm-static test cache:** `npm-static.test.ts` caches binaries by fixture hash only. After compiler changes, `rm -rf node_modules/.cache/scriptc-tests/npm-static-*` first.

## Timeline

| Stage | `/large` | `/medium` | What changed |
|---|---|---|---|
| Published React, first run | 205 ms | 8.8 ms | Compiles and renders identical HTML (Part 1) |
| Memory and record fixes | 42.5 ms | 2.4 ms | Leak fix, record capsule views and direct field writes (Part 2) |
| Dynamic-tier micro-optimizations | 37.7 ms | 1.80 ms | Immortal `undefined`/`null`, inline retains, module binding types (Parts 6–7) |
| Inline RC, splits, typed `encodeInto` | 29.4 ms | 1.44 ms | Part 14 |
| Literal boxes, record read caches | 26.0 ms | 1.25 ms | Part 15 |
| Cheaper untyped operations | 19.7 ms | 0.94 ms | Record capsules at cache sites, switch literals, typed-array sizes, for-in key snapshots (Parts 18–19) |
| React from its Flow sources | 10.6 ms | 487 µs | Native Flow support; React's internal structures become static records (Parts 20–22) |
| Gaps the static build exposed | 8.0 ms | 396 µs | Part 23 |
| For-in copies, inline capsule reads | 7.27 ms | 376 µs | Part 24 |
| Adopting copies, argument moves | 6.8 ms | 360 µs | Part 25 |
| No hidden snapshots | 6.5 ms | 337 µs | Part 26 |
| Cheaper checked objects, property paths | 5.98 ms | 322 µs | Parts 27–29 |
| Object redesign | 5.54 ms | 303 µs | 136.7M → 125.8M instructions (Part 36) |
| Retain/release pair pass | 5.24 ms | 290 µs | 122.5M (Part 37) |
| Element capsule moves and pool | | | 121.9M (Part 43) |
| Fewer cycle candidates | 5.06 ms | 283 µs | 119.6M (Part 44) |
| Typed boundary (Part 45) | | | untyped app 119.7M; typed app 142.7M → 124.5M |
| Numbers in tagged unions (Part 46) | | | untyped app 119.4M; typed app 122.6M |

## What landed, by area

### Compatibility fixes for React's Node renderer (Part 1)

Each is a general fix with a corpus program:
- discarded `&&`/`||` ending in a void conditional lowers as an `if`;
- `RegExp(pattern, flags)` without `new`;
- JS bindings typed by their initializer as a union and later written with a value no arm holds get dynamic storage;
- `ArrayBuffer`/typed-array prototypes refuse instead of reading `undefined`, and feature checks fold to Node 24's answer;
- `new util.TextEncoder()` and `new async_hooks.AsyncLocalStorage()` through module bindings;
- own properties on promises (React's `use()` writes `status`/`value`/`reason`);
- JS objects extended by `Object.defineProperty` stay checked-dynamic;
- closures inside a destructuring declaration's own initializer, through a TDZ box.

### Leaks

- **HTTP responses kept their `end()` call's AsyncLocalStorage context after `close`:** a cycle the collector couldn't trace. About 45 KB per request, now released in `scr_http_proto_sweep`. The server went from 3 → 142 MiB to 3 → 7 MiB per 3,000 requests.
- **Recent-box caches abandoned boxes on slot collisions** (about 22 per render). Slots now hold counted references and release on eviction (`cbf3e4f82`, corpus `dyn-recent-box-eviction.cjs`).
- **Emitter subclasses' slots were untraced:** the synthetic `<listeners>` field went to `%EventEmitter` only, so a stream → listener → closure → request → capsule → stream cycle leaked one stream graph per render. Fixed for every emitter and event-target subclass (`9bb4e29f0`, unit test in `cycle-analysis.test.ts`). RSS went from 482 MB to 59 MB after 3,000 renders.

### React from its Flow sources (Parts 20–23)

- **`frontend/flow/translate.ts`:** Flow → TypeScript by in-place edits over hermes-parser's tree, with diagnostics mapped back (`frontend/source-edits.ts`).
  - **Types:** `mixed`/`any` → `unknown`; exact and inexact objects, spreads, variance, `$ReadOnly`/`$Keys`, `opaque type`; `void` in unions → `undefined`.
  - **Casts:** `(x: T)` → `as`, and `(x: any)` keeps the operand's type.
  - **Tuples and nullables:** unannotated `const x = [a, b.c]` is a tuple (React's `KeyNode`), and module `let x = null` assigned only `new C()` is `C | null`.
  - **Overrides:** `flow.types` corrects a Flow type (`ReactOptimisticKey` is a `unique symbol`, −10%).
  - **Functions:** a function reading `arguments` gets a variadic overload.
  - Modules are `@ts-nocheck`; Flow is the checker of record.
- **Project config** (`project-config.ts`): `scriptc.flow` (`all`, `dynamicTypes`, `types`), `scriptc.constants`, `scriptc.moduleSubstitutions` (React's platform forks).
- **Static project setup:** `react` → `packages/react/index.stable.js`, `react-dom` → `packages/react-dom/index.js`, `react-dom/server.node` → its source entry, plus the shared-internals substitutions.
  - `dynamicTypes` covers user-facing or cold boundaries: `HostDispatcher`, `SharedStateClient`, `ThrownInfo`, `Destination`, the thenable family, `FormData`.
- **Compiler support React needed:**
  - **JavaScript semantics in Flow modules:** where annotations stop, they follow JavaScript (ES5 constructors, expandos, untyped `this`).
  - **Program modules:** TypeScript importers of CommonJS program modules, and bare specifiers resolved to project sources count as program code.
  - **Generic functions in unpinned slots** are their erased instance.
  - **Builtins as values:** `queueMicrotask`, and `Function.prototype.bind`.
  - **Typed `this`** only when every reference binds the receiver.
  - **`AsyncLocalStorage.run` with a compiled callback** goes through a lifted helper.
- **Results:** `Request`, tasks, segments and boundaries are static records; `/large` went from 19.6 ms (best published-React build) to 10.6 ms, then 8.0 ms after closing the gaps it exposed.

### Static code improvements (compiler)

- **Reads:**
  - Safe array reads fuse with their narrowing (`%arr.idxIn`).
  - Retypes between tagged unions with equal bits are the identity.
  - Tagged pointer unions: `string | Uint8Array` is the payload pointer with the arm in its low bits.
  - `Uint8Array | null` is a nullable pointer.
- **Moves and borrows:**
  - Call arguments spilled into hidden locals move at their last read (`ir/call-sequences.ts`, `emitSequenceStmts`).
  - Parameters move into record literals.
  - Unwritten parameters lend to reads.
  - Statement `push` and constant-key literals take over their values.
  - Union field writes in statement position move the value: each `if` arm takes over the reference (`lowerUnionFieldWriteStmt`, `lastUseReads`).
- **Copies:**
  - For-in copy loops are one runtime call (`ir/for-in-copies.ts`).
  - When the source is a parameter never read again, the copy adopts its entries (`createElement` takes the config's entries as props).
- **Retain/release pair pass** (`rc-pairs.cpp`, runs on each partition before helper inlining):
  - removes a retain and its releases when the value comes from a private slot nothing touches in between, or when nothing in between can release;
  - drops copies parked in private temporaries when their owner provably keeps them alive.
  - 800 pairs, −3%.
- **Cycle analysis:** construction-only edges can't form cycles (`cycle-mutability.ts`). Two crossings no longer make types mutable:
  - an opaque `liveRef` capsule of a record with no checked-dynamic form (its view throws, its commit is null), which had made `Request`'s whole closure mutable through `AsyncLocalStorage.run`;
  - `JSON.stringify` of data made only of primitives, arrays, records and unions, which runs an emitted writer that builds no capsule.
  - React's `keyPath` tuples no longer buffer as cycle candidates.
- **Inline RC fast paths** for strings, bytes, unions and arrays, guarded releases in functions over the inline cap, immortal `undefined`/`null` as globals.
- **Scalar replacement** of fresh numeric record literals read only through their fields (`const {read, written} = encoder.encodeInto(...)`).

### Untyped (checked-dynamic) operations

- **Property access:**
  - **Inline caches:** 4-way per site, shared megamorphic tables, keyed-store sites through shape transitions.
  - **Absent keys:** answered from each shape's 64-bit key filter, with the bit computed at compile time, so `props.ref` and `config.key` make no runtime call.
  - **Record capsules:** read their fields in place at compiled sites (element `$$typeof`, `type`, `key`, `props`).
  - **Function property reads:** memoized per (function, key).
  - **String primitives:** absent properties are answered without a probe.
  - **for-in keys:** read back by address.
- **Object life cycle:**
  - 32-byte entries.
  - Plain objects die through a short path into a clean pool, reused with five stores.
  - Shapes cache their key arrays, and literal sites cache their final shape (`scr_js_new_literal`, one-pass fill).
  - Teardown runs in a loop, not recursion.
  - Exact key bytes are kept per object.
  - The dispose hook is installed only while something observes.
- **Boxes:**
  - One immortal box per literal, interned string and top-level function, behind a recent cache.
  - Lazy shared integer nodes 256–4096.
  - Element capsules take over the record's reference (no retain/release, no cycle candidate) and reuse pooled capsules of the same type.
- **Comparisons and tests:** inline `===` by kind, against literals, and against symbols; inline truthiness and `typeof x === "object"`; switch cases over dyn strings compare as scalars (React's 47-case switch, −8%).
- **Typed arrays:** `byteLength`/`length` inline; byte-array headers recycled; typed `encodeInto`; short `set` inline; ASCII `encodeInto` without scanning.
- **Streams and arrays:** `destination.write` on a runtime stream calls the builtin method without building the stream's view; name reads on native arrays use a shared stand-in.
- **`arguments`:** a call with no surplus argument passes a count instead of an array.

## Part 45: the typed-app boundary (Oct 28)

A TypeScript copy of the bench app (`react-src/static/bench-typed/`: typed rows, columns, props and component parameters; same HTML as Node) cost 19% more than the untyped app: 142.7M vs 119.6M instructions per `/large` render. Typing an app should never make it slower, so this is the boundary to fix first.

1. **Record capsules in `for…in` copies** (`scr_js_copy_record_except`, `scr_js_object.c`; 142.7M → 132.6M):
   - **The cost:** `createElement` copies each config into props with a `for…in` copy loop. A typed config is a record capsule, which fell back to the loop as written: key lists, a check and a read per field, an unshaped object, then a slow free.
   - **The fix:** the copy now reads the record's present fields in layout order through its ops. For a layout whose fields are all required, it fills a cached final shape in one pass, the way object literals do.
   - **Memo:** per (layout, excluded names), it remembers the kept fields and that no name is index-like, `__proto__` or an error-mirrored key.
   - **Repro:** `/tmp/rc/main.ts` covers excluded keys, optional fields, nested record identity, writes after the copy, frozen records and empty results. It matches Node plain and sanitized.
2. **Capsule pool bug** (from Part 43; 132.6M → 124.9M, RSS 1,175 MB → 67 MB):
   - **The bug:** dispose pushed every unregistered capsule onto the pool, but a constructor popped only when the head held the same adapters. With element and config capsules alternating, the list grew to `SCR_DYN_FREE_MAX` (1M nodes). From then on every freelist push failed, so all kinds took the slow dispose (`scr_dyn_dispose` 7.7% self).
   - **The fix:** every unregistered construction now takes the head node, reinitializing it fully when its adapters differ. The untyped app never showed this because all its capsules were elements.
3. **Record-source decision remembered** (`scr_record_source_note`; 124.9M → 124.5M):
   - Converting untyped props into a typed component's record checks whether the source has undeclared keys or another key order.
   - For a shaped source the answer depends only on its shape, so it's remembered per (shape, layout), in the tiered runtime only.

**Result:** the typed app is now 4% above the untyped one (124.5M vs 119.7M), from 19%.

**What remains of the typed overhead:**
- heap union boxes for `string | number` (`row[column]`, `scr_union_destroy` and friends, about 3%);
- the record copy itself (about 1%);
- string boxes for record fields crossing into untyped code.

**RSS note:** the untyped app plateaus at about 78 MB after 6,000–12,000 renders, against about 64 MB before Part 44. It's bounded, not a leak. The union-write moves (S110: 73 MB) and the mutability exceptions (S111: 77 MB) each cut cycle candidates, so collection passes, triggered by candidate count, run less often and real cyclic garbage waits longer.

**Measured and not pursued this round:**
- **`flushSubtree`'s chunk retains:** callees already borrow; the caller retains because an untyped call (`destination.write`) could modify the chunk array. That's the isolation problem, bounded at about 1% in Part 44.
- **`encodeInto(s, view.subarray(n))` fused into one call:** about 1%; it needs dataflow through React's `target` local.
- **Number-arm unions without heap boxes:** done in Part 46 for unions with a pointer arm; `number | undefined` keeps its scalar paths.

## Part 46: numbers in tagged unions (Oct 28)

`string | number` (and `string | number | undefined | null`, `string | Uint8Array | number`) values were heap boxes: one allocation and one free per value. The typed app boxes `row[column]` for every cell.

**Representation** (`nullable-unions.ts`):
- A tagged union may now hold one `number` arm beside one to three leaf pointer arms (strings, byte arrays, stats) and up to two unit arms.
- **A number:** its double's bits plus 2^49 (`TAGGED_NUMBER_OFFSET`), with NaN made canonical first. Every number then sits at or above 2^49.
- **Everything else:** pointers (low two bits tag the arm), `NULL` (the unit arm) and the `null` sentinel all sit below 2^49.
- Unions of a number and unit arms only (`number | undefined`) keep their scalar paths: register results, inline record fields, stack boxes.
- `SCRIPTC_TAGGED_NUMBERS=0` turns it off at build time.

**Where it took code changes:**
- **Helpers:** the per-union tag, retain and release helpers (`shapes.ts`) test the range first. The encode/decode helpers are in `union-repr.ts` (`emitTaggedNumber`, `emitTaggedNumberWrap`, and template forms `unionNumberLines`, `unionNewNumberLines`).
- **Emitter:** `unionGetF64` now takes the union id. `unionNewOwned` wraps numbers, and `retypeIsIdentity` keeps the number arm.
- **Hand-written helpers:** every one that built or read a number arm directly now goes through those helpers: checked casts and untyped conversions in `dyn.ts`, worker-message decoding (now representation-aware for all pointer unions), promise race and generator resume adapters, live stream union views, and the JSON writers in `walkers.ts`.
- **Boxed relatives:** map and set keys keep union boxes. A conversion may reuse a value as it is (`T` into `T | undefined` on `Map.get`), so a boxed union with a number arm also boxes every union with a number arm whose arms are a subset or superset of it.

**Checks:**
- `/tmp/nu/nu.ts` (with union map keys, so the boxed family) and `/tmp/nu/nt.ts` (all tagged) cover a long list of contexts:
  - NaN, ±0, ±Infinity, extreme magnitudes;
  - truthiness, `===`, `Object.is`, template strings, `String`, `JSON`, `console.log`;
  - records with optional fields, `Map` values, closures, `sort`, `Uint8Array` arms;
  - untyped round trips, checked casts, generators, promises, `switch`, optional chaining.
- Both match Node; `nt.ts` is clean under the sanitizer.
- **Corpus:** 341 TypeScript corpus programs using unions with a number arm ran against Node.
  - Ten differ, all equally with the representation switched off: Node 24.16's own failures and stack traces.
  - The sanitized lane on 143 of them adds only pre-existing "fiber never resumed" audit notes.
- React's HTML is identical for both apps.

**Result:** typed app 124.6M → 122.6M (−1.6%), untyped app 119.6M → 119.4M. The typed app is now 2.7% above the untyped one.

## Part 47: assessment of speed, memory and size (Oct 28)

### Speed: profile-guided optimization

scriptc already had PGO (`--profile-generate`, `merge-profiles`, `--profile-use`), but instrumentation was refused on macOS.

**What changed:**
- `native-profile.ts` now accepts macOS.
- `scr_lib.c` makes `process.exit` write the profile on macOS too. `_Exit` skips the profile runtime's exit writer, and Mach-O can't leave a weak reference unresolved, so the runtime defines a weak no-op `__llvm_profile_write_file` that an instrumented build's profile runtime replaces at link time.
- The CLI's end-to-end profile test runs on macOS and passes. Usage text and `docs/content/docs/cli.mdx` say Linux and macOS.

**Results** (`/tmp/kl/Spu`; profile from `/hello,/medium,/large,/suspense` × 200 renders):

| | No profile | Program profile |
|---|---|---|
| `/large` | 5.00 ms | 4.34 ms (−13%) |
| `/medium` | 266 µs | 230 µs (−14%) |
| Instructions per `/large` render | 119.3M | 112.2M |
| Binary | 2.79 MB | 2.57 MB |

- **Generalization:** a profile trained only on `/hello` and `/medium` still gives `/large` −12%.
- **Server:** the HTTP server built with the render-loop profile handles 219 vs 178 requests/s under `oha` (10 connections, `/large`); Node handles 245.
- **Posture:** `--optimization=speed` on top adds nothing.

**The runtime under the profile:** the profile reaches only the compiled program; the runtime is a prebuilt C archive. A temporary build hook (`SCR_RT_EXTRA_CFLAGS`, since reverted) measured the runtime under profiles:

| Runtime | App profile | `/large` (same noisy run) | Instructions per render |
|---|---|---|---|
| plain (S116) | no | 5,400 µs | 119.3M |
| profiled on 37 non-React programs (Sgen0) | no | 5,382 µs | 117.7M |
| plain (Spu) | yes | 4,739 µs | 112.1M |
| profiled on 37 non-React programs (Sgen) | yes | 4,632 µs | 110.7M |
| profiled on React (Srpu) | yes | 4,280 µs | 106.0M |
| Node | | 4,243 µs | |

In a quieter run, the React-trained program and runtime (Srpu) measured `/large` 3,939 µs against Node's 3,946 µs, `/medium` 200 against 247 µs, and `/hello` 16 against 22 µs.

**Conclusion:** a runtime profiled once on general programs adds little (about 2%). A runtime profiled on the app's own workload adds 8–9% more. The opportunity is to make the app's PGO cycle cover the runtime: an instrumented runtime variant for `--profile-generate`, and for `--profile-use` either bitcode runtime archives that link-time optimization profiles with the program, or a runtime rebuilt from source with the profile.

### Memory

**Server:** under `oha` load on `/large` the scriptc server starts at 4 MB, peaks at 15 MB and sits at 13–15 MB afterwards. Node starts at 61 MB, peaks at 475 MB and stays at 315 MB.

**Render loop:** the 77 MB is specific to a loop that never goes idle.
- **What it is:** one `/large` render peaks at 6.4 MB. In a running loop, about 67 MB is dirty: about 20 MB live in `malloc` small regions, about 17.5 MB of freed-but-dirty `malloc` small regions, and about 28 MB in scriptc's allocator arena.
- **Live `malloc`:** 12.5 MB, of which 21 blocks of 512 KB are runtime tables.
- **Cyclic garbage:** about 6–10K objects wait for collection at any time, a few MB.
- **Why it stays resident:** free pages are returned when a thread parks, and the render loop never parks, which a server does between requests.
- **Possible improvement:** trim on a schedule while busy (after full cycle passes, plus `malloc_zone_pressure_relief` on macOS). Low priority, since servers already park.

### Binary size (3.06 MB server)

- **Layout:** machine code 2.1 MB (compiled program 1.2 MB, runtime 0.77 MB, other 0.1 MB); constants 0.28 MB; link-edit symbols 0.43 MB. `__DATA`'s 1.6 MB is zero-fill and takes no file space.
- **Duplicated variants:** only 34 KB (`mapIntoArray` ×3).
- **Runtime code:** spread across subsystems (checked values 153 KB, HTTP 58 KB, net 45 KB, arrays 43 KB, inspect 46 KB, …).
- **Levers:** PGO −8% (cold code optimized for size); `--strip` 3.06 → 2.69 MB (−12%); both together about 2.3–2.4 MB. React's own code (about 860 KB of bodies) shrinks only by proving code unreachable.

## Part 48: the app's profile covers the runtime (Oct 28)

### What changed

**Runtime packs:**
- The release flavor also ships each unit's complete bitcode (`<unit>.full.bc`, `-O2 -Xclang -disable-llvm-passes`), recorded as `full_bitcode` in `runtime-pack.json`.
- The macOS builder (`runtime-darwin-arm64/scripts/build.mjs`) and the shared Linux/zig builder (`runtime-pack-common/scripts/build.mjs`) both write it. The macOS pack grows by 21.4 MB (256 variants).
- `runtime-pack-core.ts` validates the field, and `loadRuntimePack({ withRuntimeModules: true })` verifies the modules and returns `runtimeModules`.

**Compiler** (`index.ts`, `native-codegen.ts`, `link-plan.ts`):
- A `--profile-generate` or `--profile-use` build selects the program's runtime units and takes their full bitcode from the release flavor, for every optimized posture.
- It passes them to the helper (`--runtime-module`, `--runtime-output`) and links the resulting objects in place of the pack's, runtime first as before.
- The runtime module contents are part of the artifact cache key. Builds without a profile are unchanged.

**Helper** (`native/llvm-codegen/src/emit.cpp`, `emit.h`):
- Runtime modules join the optimized partition path as extra ThinLTO inputs: same pre-link pipeline (profile instrumentation or annotation, by the helper's own LLVM), same thin link, own objects.
- **Kept as-is:** they keep their own source name (profiles key local functions by it) and skip the retain/release pass.
- **Visibility:** their definitions stay visible to native objects (the vendor archives).
- **Duplicate names:** a strong definition prevails over weak ones (pre-scan of all inputs).
- **Stack probes:** units from a vendor clang lose stack-probe attributes this LLVM can't emit. Apple clang's `probe-stack` failed with "Unsupported stack probing method".

**Termination signals:**
- An instrumented program defines `scr_profile_generate = 1` (added by the helper; weakly 0 in `scr_lib.c`).
- `scr_init` then installs SIGINT, SIGTERM and SIGHUP handlers, where those signals still have their default action. The handler writes the profile, restores the default and re-raises.
- So a server trained under traffic and stopped with a signal still writes its profile. Before this, the file was empty.

**Docs and tests:**
- `cli.mdx` "Profile-guided optimization" recommends `release`, says the runtime is covered, and explains server training. `how-it-works.mdx` lists the runtime compile among a profile's build costs. The documented commands were run.
- New test: "an instrumented program stopped by a termination signal still writes its profile" (`packages/cli/test/profile.test.ts`).
- The focused suites pass: runtime-pack, link-plan, native-codegen, native-profile, native-codegen-integration (with the system linker), and the CLI profile tests.

### Results

| | `/hello` | `/medium` | `/large` | Instructions per `/large` |
|---|---|---|---|---|
| Node 24.22 | 23 µs | 248 µs | 4,003 µs | |
| scriptc, no profile | 19 µs | 275 µs | 5,530 µs | 119.3M |
| scriptc, program profile only (previous) | 19 µs | 250 µs | 4,573 µs | 112.1M |
| **scriptc, program + runtime profile** | **15 µs** | **201 µs** | **3,872 µs** | **104.2M** |

Same run, best of 6. HTML is identical to Node on all routes. Binary: 2.54 MB against 2.76 MB without a profile.

**HTTP server** (`oha`, 10 connections, `/large`):
- With the render-loop profile: 236 requests/s against Node's 246, up from 167 without a profile.
- With a profile collected from the server itself under traffic (stopped by SIGTERM): 219 against Node's 225, in a busier run.
- RSS: 15 MB against Node's 407–437 MB peak.

**Correctness:**
- Ten repros, `nt.ts`, `uw.ts`, the record-copy repro and 20 corpus programs each ran instrumented and then profile-optimized, both compared with Node.
- All match except two that differ identically without a profile (Node 24.16 differences).
- Builds without a profile are unchanged (119.27M vs 119.17M instructions; the runtime objects are now compiled by LLVM 22 clang).

### Notes

- **Not changed:** release executables stay unstripped by default. The repository's zero-cost gate and native crash reports read their symbols; `--strip` remains opt-in (−12%).
- **Not done:** returning memory in processes that never go idle. The allocator's trim serves exiting worker threads, and servers stay at 15 MB, so it only helps artificial busy loops.

## Dead ends and measured upper bounds

Each was built or measured; don't retry without new information.

- **Typing published React's objects by inference** (Parts 6–13): ES5 constructors as classes, variable splitting, module and parameter type inference, and the shape analysis.
  - The request escapes into user code (thenables, callbacks), so a sound proof keeps losing React's core objects.
  - Partial typing adds boundary conversions and broke even at best: one typed container was slower, and the hand-typed chunk path came out the same.
  - Superseded by compiling React from its Flow sources.
- **Guarded class-dispatch fast paths:** extra tests on every dispatch cost about 4%.
- **Outlined `preserve_mostcc` release path:** 5% slower.
- **Cycle collector threshold tuning:** no help; passes reclaim real cyclic garbage.
- **Elements as plain checked objects** (instead of record plus capsule): neutral, tried twice.
- **Shape pools** (dead objects keep entries for their shape's literal site): the microbenchmark gained, React was neutral.
- **Never freeing:** slower (8.3 vs 6.8 ms); reuse keeps memory cache-hot.
- **No stack frames at all:** only 1.1%.
- **Node size:** halving `ScrDyn` wouldn't help (C model: 64–192-byte nodes cost the same).
- **Young generation for checked values** (built behind `SCR_YOUNG=1`, correct, 7.7 vs 5.8 ms): every dead young value still holds counted references to strings, records, closures and keys, so the sweep visits each one. A nursery only wins if everything lives in the collected world with moving collection.
- **Profile-guided specialization of compiled code:** aims at the wrong thing; the compiled code is close to V8, and the inline caches exist.
- **Escape analysis for React's dynamic objects:** nearly all escape (config → props → elements → children → tasks).
- **Shape inference for props:** props reach components through React's generic calls, typed `any` in React's own types.
- **A typed app:** was 19% slower; Part 45 brought it to 4%.
- **Deferred reference counting** (Parts 38–42, built three ways, correct and bounded):
  - Deferral costs about 210 instructions per death, about 90K deaths per render.
  - Most remaining operations are bindings and owned call results, not pairs.
  - Best case about 10% for a large, risky audit; measured 141M vs 122M. Removed.
- **Emitter-level `dyn` borrowed parameters** and lending uncaptured locals: neutral.
- **Borrowed parameters for byte buffers and arrays:** no change; the callees pass chunks into untyped calls.
- **Isolation analysis** (untyped calls can't write types they can't reach): an unsound upper bound (unknown calls write nothing) gained 1.1%, or 1.3% with untyped borrows. Untyped calls can re-enter React (`abort`, `pipe`, components), so a sound version keeps only part of that.
- **Removing element capsules entirely** (about 2% left) or **string boxes** (about 700 `v.str` uses, at most 2.5%): too invasive for the gain.
- **Inline function-property reads:** 33K per render, all memo hits at about 2.7 ns; at most 0.8%.
- **`config.key` misses:** under 15K object probes per render; about 0.2%.
- **Candidate-buffer holes** for `scr_cyc_on_dead`: the inline append window and pass scheduling read each generation's count, so holes need a separate live count everywhere. Fewer candidates was the better fix.
- **Codegen settings:** a single LLVM partition and `-O3` change nothing; `--optimization speed` adds nothing beyond the default inline RC.

## Where the time is now

Spread thin, 1–4% per item:
- checked-object life cycle (`scr_dyn_release`, `scr_dyn_obj_die_plain`, `scr_rc_destroy`, `scr_dyn_dispose`, fill and adopt);
- string boxes (`scr_dyn_new_str`, 14.6K per render) and string concatenation;
- probes (`scr_js_get_probe` about 3%, mostly function-property reads);
- output (`writeStringChunk`, `writeViewChunk`, encoding, `byteLengthOfChunk`);
- the regex matcher for escaping;
- React's hot functions (`retryNode`, `flushSubtree`, `pushComponentStack`, `createElement`, `renderNode`).

About 2.8M retain/release calls per render remain. Most protect field values read into locals, or owned call results and bindings, across calls that can reach untyped code. No local proof removes those.

The structural options left are large: strings and numbers without boxes in checked containers, records as checked values without capsules, or a different memory model (a nursery with moving collection). Each was estimated above at a few percent for React today, or is a rewrite.

## Before shipping

- **Tests to add:** the uncommitted work needs corpus programs:
  - union field writes that move (as in `/tmp/uw/uw.ts`);
  - opaque `liveRef` and JSON-inert crossings (as in `/tmp/cy/alscycle.ts`);
  - capsule moves and the pool, including alternating capsule types (the Part 45 growth bug);
  - record capsules in `for…in` copy loops (as in `/tmp/rc/main.ts`) and record-source decisions for shaped sources (as in `/tmp/rs/main.ts`);
  - numbers in tagged unions (as in `/tmp/nu/nu.ts` and `/tmp/nu/nt.ts`), including a union map key boxing its relatives;
  - a codegen test for the pair pass.
- **Failing tests:** two in `shapes.test.ts` from this branch's inline-release changes: "release builds inline only string and dyn retains and releases and Map retains" and "a function over the budget calls the runtime release at every site".
- **Order baselines:** missing for about 7 corpus programs from this branch (`pnpm test:ts7 --baselines-only`).
- **Full gates:** lint, format, and `pnpm test:sandbox` (both lanes), none run yet. The docs gate (`cd docs && NEXT_DIST_DIR=.next-check pnpm check`) for the profile docs.
- **PGO tests and packs:**
  - a test that a profiled build covers the runtime (for example, a runtime function's counts in the merged profile);
  - build the Linux packs with the new `full_bitcode` (only the macOS pack was built here) and run the profile tests there;
  - CI should build packs with the pinned LLVM 22 clang;
  - the runtime packages grow by about 21 MB each.
- **Unresolved corpus difference:** `7748-npm-any-bytes-receiver` (a circular inference types `next` as `Uint8Array`). It may predate this branch; it needs a clean baseline build.

## Known scriptc gaps found along the way (not fixed)

- **Receiver read order:** a field write through a receiver TypeScript has narrowed (`let cur: A | B = new A(); cur.stack = f()`, where `f` rebinds `cur`) reads the receiver after evaluating the right-hand side, and the narrowing check traps. Node evaluates the receiver first. The union-write lowering snapshots its receiver; the plain field path does not.
- **String primitives:** keyed reads of inherited members (`s[k]` with `k` = `"padStart"`, `"toString"`, `"constructor"`, `"__proto__"`, …) answer `undefined`; constant-key reads are right.
- **Function property tables:** a top-level function's table (built by a dynamic `.name` or `.length` read) lives as long as the program; the sanitized audit reports it at exit.
- **Function names:** a named function expression assigned to a variable (`const Other = function Named() {}`) reports the variable's name from `.name`.
- **Number boxes:** constant numbers in dynamic code (`$$typeof: 1`) are boxed at every evaluation.
- **Typed promises:** converting a typed `Promise<T>` to `unknown` is refused (SC1101); React's exports are `unknown` from TypeScript; member reads, writes and `in` on statically typed promises are refused.
- **Typed `getStore()`:** `AsyncLocalStorage<Record>.getStore()` from typed code is refused for records with no checked-dynamic form.
- **Captured `any`:** property writes on a captured `any` binding inside a closure are refused (SC1090).
- **Typed records in untyped code:** for-in copies are now direct (Part 45); other key walks still take slower paths.
- **Dynamic stores and reads on functions:**
  - a computed `o["__proto__"] = p` defines an own property;
  - a store to a frozen object throws in sloppy-mode `.cjs`;
  - `call`, `bind` and `toString` read off a function through a dynamic value are `undefined`.
- **HTTP:** `ServerResponse` `'error'` listeners are refused (React pipes into a `Writable` wrapper); `response.write` with `string | undefined` or `(chunk, callback)` is refused.
- **Checker-typed reads:** a value read from a dynamic binding through an expression the checker types is checked against the checker's type and throws on mismatch.
- **Typed arrays and constructors:**
  - `ArrayBuffer[Symbol.species]`, `buffer.constructor.prototype` and `buffer.__proto__` read wrong values;
  - `Reflect.get` misses typed arrays' named properties;
  - `Reflect.has` and `Object.hasOwn([1], "0")` are unsupported.
- **Constructors through module bindings:** `new (require("m").C)()` and `ns.AsyncLocalStorage.bind/snapshot` are refused.
- **Small leak:** about 40 B per iteration with `setImmediate` inside `AsyncLocalStorage.run`.
- **Parallel runs:** `scriptc run` on two files with the same stem in parallel mixes their outputs.
- **Edge renderer:** needs `typeof` of globals Node doesn't have (`AsyncLocalStorage`, `window`) and byte `ReadableStream` with a strategy argument.

## Debugging techniques that worked

- **Who throws:** `lldb --batch -o "breakpoint set -r '^scr_throw'" -o run -o "bt 25" ./bin`; use `-n scr_dyn_check_fail` for "expected X at $" errors.
- **Leaks:** `--sanitize` with the RC audit; macOS `leaks <pid>`; temporary collector instrumentation; bisecting a copied React (never the real one).
- **IR:** `--emit=ir` or `--emit=llvm -o x.ll`; `--keep-llvm` maps `sc_ldr_N_materialize` and `sc_rs_rXXXX` names to types (the `.ll` comments name record fields).
- **Why a type is cycle-capable:** temporarily log `result.units.add`/`fields.add` in `computeCycleMutability` with the current function and expression kind.
- **Counting runtime paths:** temporary static counters with an `atexit` dump in the runtime, rebuilt with `build:native` and restored afterwards.
- **Upper bounds before big work:** a deliberately unsound switch (for example, every unknown write writes nothing) bounds what an analysis could gain.

## Scratch locations

- `/tmp/kl/`: React builds (`S107` before Part 44, `S111`/`S112` current).
- `/tmp/ad/`: repros and Node outputs; `/tmp/uw/`, `/tmp/cy/`: union-write and `AsyncLocalStorage` repros; `/tmp/rc/`, `/tmp/rs/`: record copy and record-source repros.
- `/Users/lfades/all/my-own-next/react-src/static/bench-typed/`: the typed bench app (`workloads.ts`, `render-loop.mjs`, `server.mjs`); builds `/tmp/kl/T*`.
- `/tmp/cap/`, `/tmp/mb2/`, `/tmp/mb3/`: object and capsule microbenchmarks (`/tmp/mb2/floor.c` is the C floor model).
- `/tmp/ft/`: `cmp.mjs`, `prof.sh` and profiles; `/tmp/np/`: Node profile and categories.
- `/tmp/leak/`: leak repros; `/tmp/dp/`: per-file Node comparison scripts.
- `/var/folders/9t/dl6s3x6n57df07s6xs4jvyfr0000gn/T/opencode/`: early React test programs, small repros, and the full report copy.
