# React on scriptc: status report

Last updated 2026-10-26. This file is untracked working notes; don't commit it.


> **Most important rule (from the user):** don't spend time running scriptc's tests, not even a corpus shard, and don't sleep waiting on long background runs. Whether scriptc's tests pass doesn't matter until compiled React is blazingly fast; testing comes at the end. While optimizing, check correctness only by building React and comparing its HTML with Node (`/tmp/ft/cmp.mjs`), plus a quick Node comparison of any small repro.

> **Direction (from the user, Oct 27):** like Rust, a small optimization can look small alone but be the first step toward a larger one, so keep those. The goal is a good static compiler: React on the dynamic path will never be as fast as V8, and if it were, there'd be no point over V8. The target is fast, correct and accurate static binaries that need few dynamic types. Move fast: make changes, measure, make more changes; add scriptc tests once things take shape, and keep the focus on React's compiled output.

## Goal

Compile the server side of React apps to native executables with scriptc, then make them fast. The steps are:

1. Get React's Node renderer to compile. Done.
2. Measure it against Node. Done.
3. Fix memory and performance bugs. In progress.
4. Get React onto scriptc's static tier, the "optimal path" (ctate: "almost Rust level"). This work is ours, not the scriptc team's.
5. Later: the edge renderer (`react-dom/server.edge`), then plugin-rsc, then Rebask.

The long-term roadmap is in `/Users/lfades/all/my-own-next/scriptc-rebask.md`. Its "Demo status" section describes the old demo location; the demo has moved to the benchmark monorepo, so that section needs an update.

## Working rules from the user

- **Fixes:** fix real scriptc gaps only. Don't modify React, and don't hack around a gap just to make React work. When correct behavior can't be guaranteed, refuse rather than compile wrong behavior.
- **Tests:** don't run scriptc's vitest suites or corpus shards while optimizing (see the most important rule above); CI runs them at the end. Verify by building programs and comparing them with Node. Never call tests "regression" tests.
- **Code:** compact and correct, no defensive code, and no comments that restate the code.
- **Git:** no commits or pushes; the user does those. Worktrees and branches only with permission.
- **Explanations:** explain simply.
- **Demo:** don't mention the user's local demo in PRs or docs. React can be used as an example.
- **Benchmarks:** keep the loop fast (`bench/quick.sh`). Don't rerun the 15-minute benchmark.

## Repositories and branches

| Path | What |
|---|---|
| `/Users/lfades/all/vercel/scriptc-define` | Branch `lfades/define-env`: the `--define` PR, committed and merged with main. Its PR text is `pr-define.md` (untracked). |
| `/Users/lfades/all/vercel/scriptc-react` | Branch `lfades/react-node-ssr`, based on `lfades/define-env`. **All work below is uncommitted here.** |
| `/Users/lfades/all/vercel/scriptc` | Branch `lfades/split-cjs-table-reexports`, PR #2178 (open). Not needed for React. |
| `/Users/lfades/all/my-own-next/scriptc-ssr-bench` | The benchmark monorepo (Turborepo + pnpm, hoisted), with the demo moved in. Not a git repo yet; the user may run `git init`. |

## Toolchain (in `scriptc-react`)

- **Install and build:**
  - `CI=true npx -y pnpm@11.1.3 install --frozen-lockfile`
  - `npx -y pnpm@11.1.3 -r build`
- **Compiler only:** `cd packages/compiler && node ../../node_modules/typescript/bin/tsc -p tsconfig.json`, about 35 s.
- **Runtime C changes** need the native pack rebuilt, about 1 min: `PATH="/opt/homebrew/opt/llvm@22/bin:$PATH" npx -y pnpm@11.1.3 --filter @scriptc/runtime-darwin-arm64 build:native`.
- **LLVM helper:** `packages/llvm-darwin-arm64/bin/` was copied from `scriptc-define`.
- **Running the CLI:** `node packages/cli/dist/bootstrap.js build|run|coverage <file> ...`, with `PATH` including `/opt/homebrew/opt/llvm@22/bin`. The monorepo wraps this in `scripts/scriptc.mjs`; set the `SCRIPTC` env var to point elsewhere.
- **React flags:** `--npm-static=react,react-dom '--define=process.env.NODE_ENV="production"'`.
- **Lint and format:** `npx -y pnpm@11.1.3 lint` and `format` / `format:check`.
- **Order baselines:**
  - Check: `npx -y pnpm@11.1.3 test:ts7 --baselines-only`.
  - Record: `SCRIPTC_UPDATE_BASELINES=1 ... vitest run packages/compiler/test/ts7/order-parity.test.ts -t "re-record"`, about 3 min.
- **Docs gate:** `cd docs && NEXT_DIST_DIR=.next-check npx -y pnpm@11.1.3 check`.
- **Sanitizers:** `--sanitize` builds with ASan plus the runtime RC audit, which fails at exit and lists live object counts if anything leaks.

## Part 1: compatibility fixes (React SSR now compiles and runs)

React's Node renderer (`react-dom/server.node`, `renderToPipeableStream`) compiles to a native binary. That binary renders byte-identical HTML to Node, runs without Node (it links only `libSystem`), and serves the demo.

Each fix below is a general scriptc fix with its own corpus program. The PR description is `pr-react-node-ssr.md`; it covers items 1–8 below, not the performance work in Part 2.

1. **Discarded `&&`/`||` ending in a void conditional:**
   - Before: `d && (w(a), c ? f() : g())` crashed with SC9001 ("ternary must not be void").
   - Now: lowers as an `if`. `lowerDiscardedLogical` and the new `lowerLogicalAsIf` in `lower-stmts.ts`.
2. **`RegExp(pattern, flags)` without `new`:**
   - Now: lowers like `new RegExp` for string or `undefined` patterns. A regex or untyped pattern stays refused, because Node may return the same object.
   - Where: `lowerRegExpConstruct` in `lower-classes.ts`, called from `lowerCall` in `lower-calls.ts`.
3. **JS bindings typed as a union by their initializer and later written with a value no arm holds:**
   - Example: `var match = re.exec(t); match = "&lt;"`.
   - Now: the binding gets dynamic storage. `jsBindingHasOpenWrites` in `lower-stmts.ts` handles union declarations.
4. **`ArrayBuffer` and typed-array prototypes:**
   - Before: in JS, `.prototype` and other unmodelled members read silently as `undefined`.
   - Now: they refuse (`fenceBuiltinConstructorStaticRead`, `property-access.ts`).
   - Feature checks like `hasOwnProperty.call(ArrayBuffer.prototype, "detached")`, aliased `hasOwnProperty`, and `Object.hasOwn` fold to Node 24's answer (`builtinPrototypeOwnCheck` in `lower-calls.ts`).
5. **`new util.TextEncoder()` and `new async_hooks.AsyncLocalStorage()` over builtin module bindings:** fixed by the gate in `lowerNew` in `lower-classes.ts`.
6. **Own properties on promises** (runtime). React's `use()` writes `thenable.status`, `.value` and `.reason`.
   - **Storage:** the table lives on the shared `ScrPromiseIdentity` cell (`scr_async.c`). The dyn side reaches it through the `scr_dyn_promise_properties_fn` hook (`scr_async_dyn.c`, `scr_dyn.h`).
   - **Operations** in `scr_json.c`: get, set, `in`, hasOwn, `propertyIsEnumerable`, `delete`, keys/values/entries, `for...in`, own names, descriptors, `defineProperty`, preventExtensions/seal/freeze and their queries, spread, `Object.assign`, JSON, and `Reflect.get`.
   - **Refused:** `then`, `catch`, `finally`, `constructor`, `toString`, `valueOf`, `toLocaleString` and `toJSON` (`scr_promise_protocol_fence`).
   - **Tracing:** the table is untraced, so a cycle through it leaks instead of being freed early.
7. **JS objects extended by `Object.defineProperty`/`defineProperties`:**
   - Now: they stay checked-dynamic, as `setPrototypeOf` already did (`jsObjectBindingExpands`).
   - A function returning such a binding returns the real value (`returnsOpenJsBinding` in `function-returns.ts`). This was React's `getThrownInfo`.
8. **Closures inside a destructuring declaration's own initializer:**
   - Example: `const { pipe } = renderToPipeableStream(app, { onShellReady() { pipe(out) } })`.
   - Now: works through a TDZ box. `predeclareForwardCapture` accepts binding elements, `bindPatternTarget` initializes the box, and `refuseUninitializedPatternBoxes` covers the rest. All in `lower-stmts.ts`.

**Corpus programs** (untracked in `tests/corpus`):
- `discarded-logical-void-conditional.cjs`
- `regexp-call-without-new.cjs`
- `js-union-binding-later-writes.cjs`
- `builtin-prototype-feature-checks.cjs`
- `new-builtin-module-member/`
- `promise-own-properties.cjs`
- `js-object-define-property-binding.cjs`
- `destructuring-capture-in-initializer.cjs`

Each has an order baseline. Cost files are estimates (3000/3600).

**Docs:** `docs/content/limitations/builtin-apis/{regular-expressions,arraybuffers-and-typed-arrays,prototypes}.mdx`.

## Part 2: memory and performance fixes (all uncommitted, not in the PR description yet)

9. **Memory leak, about 45 KB per HTTP request:**
   - Cause: an HTTP response kept the AsyncLocalStorage context of its `end()` call (`end_als`) after `close`. React ends responses inside `requestStorage.run(request, …)`, and the request holds an `onShellError` closure that captured the response. That formed a cycle through `ScrAlsCtx`, which the collector can't trace.
   - Fix: release `end_als` once `close` has fired. In `scr_http_proto_sweep`, `scr_http.c`.
   - Result: the server goes from 3 → 142 MiB to 3 → 7 MiB per 3,000 requests.
10. **Listener closures attached through untyped values** (`scr_dyn_listener_closure`, `scr_dyn_handle.c`): their box is now traced (`scr_dyn_trace_v`). Correct, but not the cause of the leak.
11. **Record key read misses:** a read of a key a typed record capsule doesn't declare answers `undefined` without building the record's snapshot (`scr_dyn_typed_ref_key_get`, `scr_json.c`). No measurable gain on its own.
12. **Record capsule views:**
    - Before: after a write through a typed-record capsule, every read rebuilt the whole record as a dynamic object.
    - Fix: after a write commits, `scr_typed_ref_drop_plain_view` (`scr_json.c`) drops the view when the native record holds everything the view does, so reads use record ops again.
    - Result: `/large` 204 → 119 ms.
13. **Direct field writes** into typed records from untyped code:
    - What: a new `set` hook in `ScrDynTypedRecordOps` (`scr_dyn.h`), emitted per shape by `liveRecordOps` in `expr-stream-bridges.ts` as `<snapshot>_set`.
    - Scope: only for fixed shapes (all fields required) and non-inline-union fields. It converts with the same `dynCheckHelper` and `$.field` path the commit uses.
    - Wiring: the runtime calls it from `scr_typed_ref_record_set` in `scr_dyn_key_set`. The `expr-stream-bridges.test.ts` regex was updated for the eight-field table.
    - Result: `/large` 119 → 42.5 ms.
14. **`this` prologue:**
    - Before: every ordinary JS function lowered `dyn.this()`, which forces the dynamic tier.
    - Now: only functions that read `this` or `super` do (`readsReceiver` in `lower-functions.ts`). Static functions go from 122 to 241; no speed change yet.
    - Checked 120 `this`-using corpus programs against Node. The `super` case is fixed. Four others differ: three of them also fail with my changes stashed (`6930-dyn-buffer-methods.cjs`, `webassembly-api.mjs`, `webassembly-jsapi.mjs`), and `7710-util-debounce.cjs` fails under Node itself.

Verification for Part 2:
- `node bench/run.mjs check` gives byte-identical HTML on every route.
- The hand-written record-write test (`/tmp/leak/recset.mjs`) matches Node.
- ASan and the RC audit are clean.

## Part 3: the benchmark monorepo (`/Users/lfades/all/my-own-next/scriptc-ssr-bench`)

**Layout:**
- `packages/ssr-app/src/`:
  - `workloads.mjs`: the `/hello`, `/medium`, `/large?n=500` and `/suspense` trees;
  - `server.mjs`: HTTP, piping React into a `Writable` that forwards to the response;
  - `render.mjs`;
  - `render-loop.mjs`: in process; yields to the event loop every 64 renders.
- `apps/node`: runs it on Node.
- `apps/scriptc`: `build.mjs` builds `dist/{release,speed}/{server,render-loop}`.
- `apps/demo`: the Vite demo, moved here. The demo's server is `server.mjs` with `react-dom/server.node`. The old edge versions are backed up in `/var/folders/9t/dl6s3x6n57df07s6xs4jvyfr0000gn/T/opencode/demo-backup/`.
- `bench/`:
  - `run.mjs check|bench` (oha, fresh server per measurement; writes `results/summary.md` and JSON);
  - `quick.sh`: the fast loop, about 15 s. Rebuilds `dist/quick/render-loop`, times `/medium` and `/large`, and reports peak RSS over 20,000 `/hello` renders.
- `README.md`: results and explanations.

**Results** (M4, Node 24.16; quick loop and short oha runs, 10 connections):

| | Node | scriptc, first run | scriptc now |
|---|---|---|---|
| Startup to first response | 45 ms | 4.6 ms | 4.6 ms |
| Idle memory | 60.5 MiB | 6.8 MiB | 6.8 MiB |
| Memory under load | 318 MiB | 2.3 GiB (leak) | 50 MiB |
| `/medium` render | 0.2 ms | 8.8 ms | 2.4 ms |
| `/large` render | 3.6 ms | 205 ms | 42.5 ms |
| HTTP `/hello` | 57,414 req/s | 4,433 | 13,323 |
| HTTP `/medium` | 5,033 req/s | 114 | 490 |
| HTTP `/large` | 267 req/s | 5 | 24 |

`--optimization=speed` doesn't help. `bench/results/summary.md` still holds the first full run, from before the fixes.

## Part 4: why it's still slower, and the plan

**The current profile:** spread across dynamic-tier costs (`scr_dyn_release` about 19%, retain, `dyn_key_get`, boxing). There's no single hot spot left.

**Tier status:** 1,052 of 1,293 functions are on the dynamic tier. That's the IR `tier` field; check it with `--emit ir` and a count of `tier` values. Hot functions such as `renderElement`, `renderNodeDestructive`, `pushStartGenericElement` and `escapeTextForBrowser` take all-`dyn` parameters.

**How scriptc types untyped JS** (an agent mapped this; references are in `packages/compiler/src/frontend`):
- **Per-call-site instances.** JS functions in `--npm-static` packages with untyped parameters are treated as generic and instantiated per call-site argument types (`lowering/generic-functions.ts`: `implicitCallInstance` around line 2181, `implicitAnyParamSymbolsOf` around 1853). An argument typed `dyn` makes the parameter `dyn`.
- **Exclusions.** Parameters written in the body, async and generator functions, and functions that read `arguments` don't qualify.
- **Tier rule.** A function is dynamic if any dynamic operation appears in it (`ir/tiers.ts` around line 159, `firstDynamicOperation`).
- **Where the `dyn` comes from.** React's props are built with computed keys, so they're dynamic by construction. React's request object is an ES5 constructor (`function RequestInstance(...) { this.destination = null; ... }` with `new`), which scriptc doesn't model as a class; it lowers through `%class.construct` with a `dyn` receiver (`lowering/object-factory-new.ts`). Render and replay tasks have different shapes.
- **Shape inference.** `frontend/shape-inference/` (about 4,200 lines) is a whole-program allocation-site points-to analysis. It's report-only (`SCRIPTC_DEBUG_SHAPES=1`) and nothing consumes it. On React it takes 43 s and exceeds its work budget, so results are incomplete. Sites: 178 resolved to exact records, 239 kept as dynamic objects. Much of it is untracked because the request object is.
- **Boundary.** Typed records and classes cross into dynamic code as typed-ref capsules, and `dynCheck` converts back.

**Plan for the static path:**
1. **Model ES5 constructor functions** (`this.x = ...` in `function F`, then `new F()`) as class layouts, in both the shape analysis and the lowering. Once the request object is typed, per-call-site instantiation can type React's functions that receive it.
2. **Make the shape analysis finish on React** (budget and precision).
3. **Feed its results into the lowering:**
   - per-site record layouts with inferred field types, instead of the checker's literal type (`expressions/object-literals.ts` around lines 1038 and 1085);
   - typing empty `[]` and `{}` initializers;
   - parameter types as the union across call sites.
4. **Smaller items:**
   - `null`-initialized fields as `T | null`;
   - union return types instead of `dyn` (`function-returns.ts` around line 509);
   - parameters written in the body.
5. **After each step:** `bench/quick.sh`, `node bench/run.mjs check`, and the static/dynamic function count.

## Part 5: Phase 0 measurements (Oct 26)

**Profiling tools** (`/tmp/*.py`, stdlib Python only, reading a `sample` file):
- `own.py <file> N`: the top N compiled JS functions by their own time plus the runtime calls they make.
- `callers.py <file> fnA,fnB N`: which JS functions call the given runtime functions.
- `children.py <file> <jsName>`: the runtime callees of one JS function.
- `sub.py <file> <jsName> <runtimeFn>`: the breakdown inside one of those callees.

To capture a profile, run the render loop with many renders in the background, then `sample <pid> 4 -file x.txt`.

**`/large` profile** (own time, current `scriptc-react` build):

| Function | Share |
|---|---|
| writeChunk | 15% |
| renderElement | 9% |
| anonymous function | 7% |
| pushStartInstance | 6.5% |
| retryNode | 5% |
| pushStartGenericElement | 3% |
| runtime glue | 17% |

- Self time: `scr_dyn_release` 17%, `scr_dyn_retain_v` 6%, `strcmp` 3%. The `strcmp` comes from `scr_dyn_bytes_method` matching method names one by one (`scr_json.c` around line 5505).
- In `writeChunk`, encoding itself is 41 of 651 samples. The rest is the dynamic `subarray` call and its view objects, because `currentView` and `writtenBytes` are `dyn` module globals.

**Micro-benchmarks** (`scriptc-ssr-bench/bench/micro/run.sh`): `patterns.ts` (typed) and `patterns.mjs` (the same code untyped).

| Pattern | Node | Dynamic path | Static path |
|---|---|---|---|
| read fields | 1.5 ms | 40.8 ms | 1.1 ms |
| allocate object | 2.6 ms | 95.7 ms | 7.0 ms |
| escape text | 11.9 ms | 52.3 ms | 10.8 ms |
| array push | 2.3 ms | 8.5 ms | 3.6 ms |
| closure call | 0.9 ms | 7.0 ms | 0.7 ms |
| write chunk | 4.9 ms | 8.4 ms | 8.7 ms |

The static path is about as fast as Node, and the dynamic path is 5–37× slower. The static `write-chunk` and `allocate object` costs are runtime allocation costs (views and result objects created per call).

**Why scriptc can't type React today:**
- Lowering types every expression from the TypeScript checker. In JS, the checker gives `any` to `var x = null`, to untyped parameters, and to fields initialized from them.
- In `lower-modules.ts`, around lines 2296–2545, JS module globals with a `null` initializer or with untyped writes become `dyn`.
- Typing a binding's storage isn't enough on its own, because each read would still be lowered as `any`.

**The JSDoc annotation experiment** (`/tmp/exp`: a copy of React; `./build.sh` builds and times it). Adding `/** @type {Uint8Array} */` to `currentView` and `/** @type {number} */` to `writtenBytes` in the copied `react-dom-server.node.production.js`:
- made `writeChunk` typed (15% → 8.8% of the time) and sped up `/medium` and `/large` by about 7%;
- showed that scriptc honors JSDoc in JS, and that a wrong annotation fails loudly: the `currentView = null` write threw instead of miscompiling;
- needed a measurement-only edit to the copy, `currentView = null` → `new Uint8Array(4096)` in `completeWriting`. The real type is `Uint8Array | null`, and scriptc refuses `x.subarray(...)` on `Uint8Array | null` (SC2020). Strict TypeScript rejects that code, so scriptc never needed it.

**Direction this suggests:**
1. **Nullable member access in JS:** reads and calls on a `T | null | undefined` binding throw Node's `TypeError` on `null`/`undefined` and are typed otherwise. Needed for anything inferred as nullable.
2. **Type inference for `--npm-static` packages that outputs JSDoc:**
   - Check the program once, infer types, insert JSDoc comments into the package sources in memory (on the same lines, so line numbers stay), then check again. The existing typed lowering then applies unchanged.
   - Order: module-level variables first (each variable's type is the union of every value written to it), then function parameters (the union of the types passed at all call sites), then ES5 constructor fields and object shapes, using `frontend/shape-inference`.
   - Inference must be sound, since a wrong annotation throws at runtime.
3. **Runtime:** cheaper `subarray`/`encodeInto` per chunk (pool or reuse the view and result objects), and method-name dispatch in `scr_dyn_bytes_method` without `strcmp` chains.

## Part 6: first static-path steps (Oct 26)

15. **Members of maybe-null JS values:**
    - What: `lowerPresentArmMember` in `expressions/optional-chains.ts`, hooked into the two JS dynamic fallbacks of `property-access.ts` and before the method-call refusal (`stdlibMemberFence`) in `lowerCall`.
    - Scope: when a JS receiver's union is one present type plus `null`/`undefined`, the receiver goes into a hidden local and Node's "Cannot read properties of null (reading 'm')" `TypeError` is thrown for the unit arms. Otherwise the member re-lowers typed (the optional-chain override plus `chainNarrowedType`).
    - Previously such reads went dynamic, and such method calls were refused (SC1090/SC2020).
    - Supporting changes:
      - `Lowerer.nullableArmReceiver` was split out of `runtimeOptionalPropertyReceiver`;
      - `isStdlibMember` (`surfaces.ts`) resolves through `chainNarrowedType`.
    - Evidence: `tests/corpus/nullable-receiver-present-arm.cjs`.
    - Regression check: all 981 JS corpus programs against Node. 80 differ, and all 80 also differ with the change switched off.
16. **Module binding type inference for `--npm-static` JS:**
    - Where: `frontend/npm-static-binding-types.ts`, run from `loadProgram7` (`program.ts`) after the Temporal block, for up to 3 rounds; files are re-served through `host.addVirtualFile`.
    - Scope:
      - Module-level `var`/`let` bindings the checker types `any` get `/** @type {A | B} */`, built from all their writes (initializer or undefined, `=`, compound assignments, `++`/`--`).
      - It gives up on untyped writes, destructuring or loop writes, and types other than primitives or standard-library classes, and skips files that use `eval` or `with`.
      - A nullable result is used only when every use is a member read, a method call, a comparison, a truth test, `typeof`, or the value being passed on (`blocksNullable`). Element access and member writes keep the binding dynamic, because element access on a nullable type has no typed form yet: JS evaluates the key and value before throwing, and the message names the key.
    - Also fixed: `hasJsTypeAnnotation` (`lower-stmts.ts`) only scans its own declaration's span, so `var /** @type {A} */ a, b` no longer counts `b` as annotated.
    - On React it types `currentView` (`Uint8Array | null`) and the two `suffix` bindings. The rest are blocked by writes from untyped parameters (`request`, `task`, `keyPath`…).
    - Result: `/large` 41.4 → 39.1 ms, output identical to Node.
    - Evidence:
      - test "module bindings take the types of the values written to them" in `tests/harness/npm-static.test.ts`;
      - fixture `tests/fixtures/npm-static/module-binding-types-cli.mjs` with its package `node_modules/chunk-writer`;
      - the whole `npm-static.test.ts` passes (145 tests).

**Revisions to the inference** (after the full `npm-static.test.ts` run with a cleared cache; see the warning below):
- **Types come only from syntax.** The checker's types aren't evidence in unchecked JS: any code can write `undefined` into a property TypeScript typed `number`. This caused a js-yaml miscompile ("expected number at $, got undefined").
  - `syntacticTypes` now types a written value only from what its syntax guarantees: literals, operator results, standard-library `new`, and `String`/`Number`/`Boolean` conversions.
  - A value from another variable flows through an edge, solved by a fixed point. Every variable takes part, including ones the checker types, because their checker types aren't trusted either.
  - `||`, `&&`, `??` and conditionals take the union of their operands.
  - An annotation needs exactly one type, besides `null`/`undefined`.
- **The lowering gets a fresh program after the analysis.** The analysis's checker queries changed the checker's later answers for JS: commander broke even with zero annotations. `loadProgram7` now always re-creates the program after the inference rounds.
- **Local variables** are candidates as well as module-level ones, except `for…in`/`for…of` heads.
- **Parameter inference was implemented and then removed.** A typed argument makes the per-call-site instance typed, and typed instances reach forms only the dynamic lowering supports. In smol-toml, `ptr: number` turned `[str, end]` (inferred as `(string | number)[]`) into a union index and `++` on unions, which are refused.
  - Parameters need a fallback first: a typed instance that fails to lower should fall back to the dynamic instance instead of compiling a runtime refusal.
- **Fix for string indexing with a union key** (`element-access.ts`): a JS index whose union holds more than a number (plus `undefined`) takes the keyed dynamic read, as Node does. Corpus program: `tests/corpus/string-index-union-key.cjs`, which fails before the fix and matches Node after.

**Test-cache warning:** `npm-static.test.ts`'s `buildStatic` caches binaries under a hash of the fixture files only, not the compiler. After compiler changes, run `rm -rf node_modules/.cache/scriptc-tests/npm-static-*` first, or old binaries pass. This is what made the first "145 passed" run misleading.

**Why React's hot objects can't be static yet** (found with `/tmp/ctor`):
1. **ES5 constructor functions build dynamic objects**, even with every parameter annotated: `run` 75 ms vs Node's 7 ms. The same code as a JS `class` gets a real class layout (34 ms).
2. **JS class fields assigned from constructor parameters are `dyn`** unless the file is checked (`checkedJsDocumentedParameter` / `lowerer.checkedJsFile`, i.e. `// @ts-check`). JSDoc in unchecked JS isn't trusted. Inferred annotations would need to be trusted explicitly.
3. **JS class fields holding arrays or records are always `dyn`** (`jsFieldInitializerType` in `lower-classes.ts`). This preserves object identity across dynamic crossings, and most of React's request fields are arrays and records.

**Next for the static path:**
- **Parameter types:** `@param` from the union of the types passed at all call sites, iterated with the module bindings. Object types would be named through the constructor function (`RequestInstance`) or `ReturnType<typeof createRenderTask>`.
- **Typed element access on maybe-null values:** evaluate the key and value first, then throw with the runtime key in the message.
- **A wider whitelist:** for example, allow the value as an object-literal property value.

## Part 7: dynamic-path micro-optimizations (Oct 26)

**Release-path counts per 10 `/large` renders** (temporary counters in `scr_dyn_release`):

| Release path | Count | Share |
|---|---|---|
| Null or immortal (no-op) | 22M | 57% |
| Surviving container | 4M | |
| Surviving other | 3.1M | |
| Dead number or string box | 7.8M | 20% |
| Dead other | 1.8M | |

That's 3.9M releases per render, and the hot functions are huge (`pushStartInstance`'s LLVM has 9,792 release sites). Functions with more than 256 sites (`INLINE_DYN_RELEASES_PER_FUNCTION`, `limitInlineReleases` in `shapes.ts`) call `scr_dyn_release` at every site.

**Kept:**
- **Immortal `undefined`/`null` read as globals.** The runtime exports `scr_dyn_undefined_value` and `scr_dyn_null_value` (`scr_json.c`, `scr_dyn.h`). `immortalValueAddresses` in `emit-module.ts` (called from `emitParts`) rewrites every `call ptr @scr_dyn_undefined()` / `@scr_dyn_new_null()` into a `getelementptr` of the global. Result: `/large` 39.4 → 37.7 ms (`scr_dyn_undefined` was 3% self time).
- **`retainDyn` in `dyn.ts` uses `retainSym(host, DYN)`**, the inline fast path, instead of calling `scr_dyn_retain_v`. About 1%.

**Tried and reverted:**
- An outlined `preserve_mostcc` release fast path for functions over the cap. It was about 5% slower: the callee saving registers costs more than the caller's spills.

**Not removable statically:** only 729 of 95k release sites release a value defined from the immortal globals. The rest of the immortal values come back from runtime calls.

**Bigger levers, not started:**
- **Fewer temporaries:** borrowed reads instead of retain/release pairs.
- **No number boxes:** a number crossing into `dyn` allocates a box (20% of releases free one). A tagged representation would avoid it; scriptc also has a `jsval` representation used by the `js.*` operations.
- **Faster property lookup:** hidden classes with inline caches.

**Checks:** React's HTML is identical, and 40 random corpus programs were compared against Node. The differences there predate these changes, or come from process IDs or `comptime` (which Node can't run).

## Part 8: getting React's request object onto the static path (Oct 26)

**The experiment** (`/tmp/exp`, a React copy where `RequestInstance` is hand-converted to a `class`; `./build.sh` builds and times it):
- Typed parameters with the class type: 0 functions before the fixes below, 41 after (`performWork`, `finishedTask`, `startWork`…).
- No speed change yet: the hot functions (`retryNode`, `renderElement`, `renderNodeDestructive`, `pushStartInstance`) still get `dyn`.

**What blocks the type from flowing** (minified code reuses variables for unrelated values):
1. In `createRequest`, `resumableState = new RequestInstance(...)` reuses a parameter for the request, so the binding is dynamic and the request is boxed when it's created.
2. In `performWork`, `var request = request$jscomp$1` takes the checker's `any`, even inside an instance where the parameter has the class type.
3. In `retryNode`, `request = request.aborted ? request.fatalError : x` (in a `catch` inside a loop) reuses the parameter for an error. A parameter written in its body doesn't qualify for per-call-site typing, so everything below `retryNode` gets `dyn`.
4. `request.pingedTasks` (an array field) is `dyn` by the JS class-field policy, so tasks read back are `dyn`.

**Changes so far** (all kept; React's output is identical, `/large` 37.8 ms, `/medium` 1.82 ms):
- **`jsBindingKeepsInitializer` and `lowerJsVarKeepingInitializer`** (`lower-stmts.ts`):
  - A JS `let`/`var` the checker types `any` that is never written again adopts its initializer's static type, as an `any` const already did.
  - For a hoisted `var`, every read must come after the declaration inside the declaration's own block, and outside function declarations.
  - `hoistVarBinding` takes an adopted type.
  - This fixes item 2.
- **Variable splitting, block-local form** (`frontend/npm-static-binding-splits.ts`, run once in `loadProgram7` before the type rounds):
  - A statement `x = e;` directly in a block becomes `var x$1 = e;`, and the reads after it are renamed.
  - Conditions: no enclosing loop, no later writes, every later read in the same block, and no closure references the variable.
  - This fixes item 1. Item 3 needs a flow-based version.
- **JS class fields from chained assignments** (`lower-classes.ts`): `this.a = this.b = null` declares both fields, the innermost first. This fixed an internal compiler error ("bare unit type nullT") once `RequestInstance` was a class.

**Next, in dependency order:**
1. **Flow-based splitting:** a control-flow graph per function, the writes reaching each read, union-find into webs, and one variable per web. Writes inside expressions count as may-writes, `try` bodies have edges to `catch`/`finally`, and variables referenced from closures are skipped. This handles item 3 and React's other reused variables.
2. **ES5 constructor functions as classes,** when sound:
   - the function is only used as `new F(...)` (and `instanceof`);
   - the file is strict;
   - no top-level code before the declaration can reach `new F` (class declarations aren't hoisted).
   Either as a source rewrite in the pre-pass or directly in the lowering.
3. **Array and record fields in JS classes,** currently always `dyn` for object identity (`jsFieldInitializerType`). Needed for `pingedTasks` and the task and segment objects.

## Part 9: the typed request reaches the render path (Oct 26)

**New `--npm-static` source passes** (run once in `loadProgram7` before the type rounds, in this order; each re-creates the program):
1. **`npm-static-constructor-classes.ts`:** `function F(){ this.x = … }` becomes `class F { constructor(){…} }`.
   - Conditions: a strict file, a top-level declaration, and every reference is `new F` or `instanceof F`.
   - No top-level statement before the declaration may reference `F` or a function that transitively references it, because classes aren't hoisted.
   - On React this converts `RequestInstance`. In the `/tmp/ctor` benchmark: 75 → 17 ms (Node: 7 ms).
2. **`npm-static-binding-splits.ts`, rewritten to be flow-based:**
   - Structured reaching definitions per function: branches merge; loops iterate to a fixed point; `break`/`continue`/labels go through target stacks; `try` → `catch` from the entry state plus all writes in the `try`.
   - Union-find into webs. Compound writes and `++`/`--` join the web they read.
   - Each web other than the entry value's becomes a fresh `var x$N`, declared at the top of the body. The original name is re-declared there too, for `var`s.
   - Parameters always keep their name for the entry value, so they lose their writes and qualify for per-call-site typing.
   - Excluded: `let`/`const`, bindings referenced by closures, shorthand or destructuring uses, loop heads, `finally` writes, writes inside optional chains, files with `eval`/`with`, and sloppy-mode functions that read `arguments`.
   - Bugs found and fixed while building it: double edits on `x++`, compound writes split from their read (it broke `useId`), and the original name losing its declaration.
3. **`npm-static-direct-calls.ts`:** `als.run(store, f, a, b)` becomes `als.run(store, () => f(a, b))`.
   - Only when `f` is a function declaration and the arguments are variables or literals, so `f` gets a typed instance.
   - On React: `requestStorage.run(request, performWork, request)`.

**Lowering changes:**
- **Class-instance arguments:** `implicitCallInstance` (`generic-functions.ts`) binds an argument stored as a class instance (`object`) but typed `any` by the checker to the class's instance type.
- **Inline capsule test:** `classCapsule` (`expr-dynamic.ts`) checks the kind (12) inline and calls the runtime only for typed refs.
- **Dispatcher fast path:** class read dispatchers (`%dyn.class.property.N`, `class-dynamic-dispatch.ts` `plainReceiverRead`) read a receiver that's neither a capsule nor a function directly.

**Result:**
- On real, unmodified React, 60 function instances take `request` as `RequestInstance`, including the hot `renderElement`, `retryNode`, `renderNode`, `renderNodeDestructive` and `renderChildrenArray`. The typed `renderElement` instance is the one that runs.
- **Speed: no gain, about a 5–8% loss.** `/large` is about 40.5 ms vs 37.8 before Part 8. Partial typing adds conversions at every typed/dynamic boundary (`sc_dc_*` checks, class dispatchers on property names the class declares), and the hot functions stay dynamic.
  - The other lowering changes cost about 1–2%; each pass about 1–2% more (A/B with switches, noisy within ±3%).
- **Still dynamic in the hot functions:**
  - `task` (read from `request.pingedTasks`, an array field forced `dyn` by `jsFieldInitializerType`);
  - `segment`, `boundary` and `props` (records/dictionaries);
  - 22 of `RequestInstance`'s 32 fields.

**Checks done:**
- React's HTML is identical on all routes.
- `/tmp/sp` (the split patterns), the `chunk-writer` fixture, commander, smol-toml and js-yaml all match Node.
- 48 random corpus programs: the differences predate these changes, or come from process IDs.

## Part 10: what it takes to type `task`, `segment` and the request's fields (Oct 26)

**The field policy** (`/tmp/fld`: a JS class with array fields, aliases, pushes through untyped functions, and identity checks; it matches Node today):
- Lifting the `array`/`record` → `dyn` rule in `jsFieldInitializerType` changes nothing on its own. In JS, `this.items = []` is checker-typed `any[]`, which maps to `dyn` before that rule runs.
- `inferredEmptyCollectionFieldType` only infers `Map`/`Set` element types, and only from `this.field.set/add` inside the class's own members.
- Class layouts are decided before function bodies are lowered. So an element type for `request.pingedTasks` has to come from a whole-program analysis of every `push` into it, which means knowing which expressions denote a request.

**The shape analysis on the rewritten React** (`SCRIPTC_DEBUG_SHAPES=1`):
- It now finishes: 0.9 s and 38,772 steps, vs the budget overrun at 20M steps before the class conversion and splits.
- It reports precise per-field allocation sites. For example, `RequestInstance.pingedTasks: []@4209`, `currentTask: {replay,node,…}@4500|@4553`, and task fields `blockedSegment: {status,parentFlushed,…}@4592 | null`.
- But every field also has a ⊤ (untracked) arm and is marked writable by untracked code, for two reasons:
  1. **The request escapes as an "argument of a ⊤ call" at 7467:** it's the store of `requestStorage.run(...)`. Model AsyncLocalStorage run/getStore (the store only comes back through `getStore`).
  2. **Writes through ⊤ receivers taint every object:**
     - `Object.defineProperty(initializedReason, …)` at 3556 is on a fresh `Error(...)` result. Model built-in constructor results as fresh sites.
     - `delete slots[index]` at 6317 is on resume data from outside, so it's legitimately ⊤. Scope the taint to objects that can actually reach ⊤ values, instead of `*`.
- With those fixed, the analysis could prove field types for the request, tasks and segments.

**Plan from here:**
1. Fix the two precision issues above in `frontend/shape-inference`.
2. Turn its proven field and element types into JSDoc in the pre-pass: `@type` on `this.x =` in constructors and on object-literal properties of factory functions, plus array element types.
3. Then revisit the `jsFieldInitializerType` array/record policy with identity in mind: typed arrays and records crossing into dynamic code must keep their identity (typed-ref capsules).

## Part 11: shape-analysis precision work, in progress (Oct 26)

Everything here is in `frontend/shape-inference/analyze.ts` and `domain.ts`. The analysis is report-only, so compiled output is unchanged (React's HTML is still identical; `/large` about 40.7 ms).

**Changes:**
- **AsyncLocalStorage is modeled:**
  - `require("async_hooks")` and the ambient `declare module "async_hooks"` binding resolve to `builtin("async_hooks")`. This check sits before the declaration-file `globalNode` early return in `identifier()`.
  - Imports from it resolve too (`asyncHooksImport`).
  - `new AsyncLocalStorage()` gives `builtin("AsyncLocalStorage.instance", holder)`, with one store-holder object per construction site.
  - `run(store, fn, ...args)` and `exit(fn, ...args)` call `fn` with those arguments; `getStore()` returns the stored value or `undefined`; `enterWith` stores. See `ALS_METHODS` and the `als.*` cases in `callBuiltin`.
- **Timer globals are modeled:** `queueMicrotask`, `setImmediate`, `setTimeout` and `setInterval` are in `MODELED_GLOBALS` and call their callback with the given arguments.
- **`forEach` passes its `thisArg`:** the `callback` helper in `callBuiltin` takes the argument index the receiver comes from, used by array and collection `forEach`. Collection `forEach` also passes `(value, key, set)`.

**Result:** the request no longer escapes through `requestStorage.run` (7467) or the timers. It now escapes at 6556, `boundary.fallbackAbortableTasks.forEach(abortTaskSoft, request)`, because the receiver is ⊤.
- The ⊤ cascades: once anything escapes, its fields go ⊤, and calls on ⊤ make their arguments escape.
- To see the current escape and its source line, run `/tmp/esc.sh` (rebuilds the compiler, runs the analysis with `SCRIPTC_DEBUG_SHAPES=1`, output in `/tmp/shapes3.txt`).

**Remaining root escapes on React** (the `escape root:` lines):
1. **React's shared internals are ⊤:**
   - `HooksDispatcher` stored into `⊤.H` (6612) and `DefaultAsyncDispatcher` into `⊤.A` (6614), on `ReactSharedInternals`;
   - `{f,r,D,C,L,m,…}` into `⊤.d` (311), on `ReactDOMSharedInternals`.
   - Likely cause: `react/index.js` picks `./cjs/react.production.js` or the development build by `process.env.NODE_ENV`, and the analysis doesn't apply `--define`, so the unanalyzed development build makes the export ⊤.
   - Next step: fold `process.env.X` through the `--define` values in the analysis, or check how the program's `react/index.js` text looks after define folding.
2. **`Error(msg, { cause })` (3552) and `Object.defineProperty` descriptors** (3556, 4624): model `Error`'s options and descriptor objects as not escaping (a descriptor's value or getter goes into the target object).
3. **`{last,dispatch}` bound argument (3658):** model `Function.prototype.bind`'s bound arguments as arguments of the bound function.
4. **`<fn>` passed to an untracked call (1105)**, `checkDCE` (react-dom/index.js), and the render-loop's own closures: inspect each.

After the escapes, use the analysis's proven field types (Part 10, plan step 2).

**Update, same day:**
- **Constant `if` conditions** (`constantCondition` in the `stmt` walker): only the branch that runs is analyzed.
- **Relative `require` fallback:** a specifier the checker can't resolve (`react/index.js`'s shadowed `require('./cjs/react.production.js')`) resolves by path among the analyzed files. This was the cause of the ⊤ shared internals.
- **Result:** precisely tracked sites 60 → 122, escaping sites 350 → 211, and the shared-internals and `requestStorage` escapes are gone.

**Remaining escapes are mostly legitimate:**
- task `ping` closures handed to a user's thenable (`x.then(ping, ping)`, 6177 and 6228);
- `Error.prepareStackTrace`;
- property descriptors;
- callbacks through `forEach` on ⊤ receivers.

These feed ⊤ back into the request and boundaries. `finishedTask`'s `boundary` parameter also mixes many unrelated objects, because the analysis isn't flow-sensitive.

**Conclusion:** a purely static proof keeps losing React's core objects to code outside React (user thenables, callbacks, props).

**The realistic next lever is guarded specialization** (static inline caches):
- On a `dyn` value, a hot property read like `request.status` checks "is this a capsule of class C?" inline and does a direct slot load; anything else takes the generic path.
- This is sound without whole-program proofs. The existing `%dyn.class.property.N` dispatchers do this check, but through out-of-line calls, bag lookups and `jsval` round trips.
- Combined with typed class layouts (the constructor-class pass), it would make class-field access native even from dynamic code.

## Part 12: guarded fast paths in class dispatch (Oct 26)

**Change:**
- `plainReceiverRead` (`class-dynamic-dispatch.ts`) is now registered in `PLAIN_RECEIVER_READS`, and `frontPlainReceiverReads`, called from `normalizedDispatches`, moves it ahead of the class branches.
- 374 of 375 `%dyn.class.property.N` dispatchers now test for an ordinary receiver first.
- Gain: about 0.5% (`/large` about 39.8 vs 40.0 ms), within noise.

**Findings:**
- **Class brand tests are already cheap.** `dyn.typedRefIs` (`lib-dispatch.ts`) inlines the kind check, compares the key pointer, then checks key length and last 8 bytes before calling the runtime, so failed tests cost a few instructions each.
- **The remaining dispatcher costs are scattered:**
  - `%dyn.class.computed.N` (computed `obj[k]` reads, stores and `hasOwn`) converts the key to a string (`dyn.toStringCoerce`) and runs symbol tests before the class branches;
  - each class branch extracts the instance (`dynCheck`), looks up the property bag (`%class.branchPropertiesOrEmpty` with `dyn.hasOwn`), then reads the field;
  - results go through `js.fromDyn`/`js.toDyn` round trips.
- **The class branch itself:** it reads the slot only when the bag holds no own `status`. Fast enough once reached, but it's reached through about six operations.
- **Gap to `base`:** builds with the static-path passes (Parts 8–9) are still about 7% slower than `base` (37.2 ms). The dispatchers explain little of that. The remaining contributors from the per-function diff are the `sc_dc_*` checked conversions at typed/dynamic boundaries, `readPropertiesOrEmpty`, and `retryNode`.

**Possible next steps:**
1. **Find the regression by A/B per pass** (the earlier `TMP_NO_*` switches in `program.ts`): measure each pass alone, and drop or gate any that costs more than it enables.
2. **Make `%dyn.class.computed.N` start with a fast path for ordinary receivers.** For a non-capsule, non-function receiver, the final generic operation can run directly on `p.0` (where `readPropertiesOrEmpty(p.0)` is `p.0`); string keys still need `key.string`, and symbol keys their own branch.
3. **The bigger lever is still typed objects in the hot functions** (task, segment, props), which needs either the proofs (Part 11) or guarded speculation in the hot functions themselves: version a hot function on its argument's class, the way V8 does, with a check at entry.

## Part 13: where the remaining time is, and the plan for a large speedup (handoff)

**Facts** (IR scan of `/tmp/real.ir`, the current real-React build):
- The hot `writeChunk` instances take `chunk: dyn` (string | Uint8Array, read from dynamic chunk arrays).
  - Their bodies hold 28 `dynFrom`, 15 `dynCheck`, and many `js.*` operations.
  - The variable splits worked (`target$1`/`target$2` separate), but everything still touches the dynamic `chunk`.
- The same holds for the whole render path:
  - Tasks and segments are created as typed records (`createRenderTask` / `createPendingSegment` object literals).
  - They're stored in dynamic containers (`request.pingedTasks`, `segment.children`, `task.blockedSegment` held in dyn fields) and read back through typed-ref record capsules (`scr_dyn_typed_ref_key_get`, about 4% self time), so each hot function sees `dyn`.
- **Conclusion:** a large speedup needs typed containers end to end. Until then, typed islands mostly add conversions; builds with the Part 8–9 passes are about 7% slower than `base`.

**Plan, in order** (each step measured with `bench/quick.sh` plus `node bench/run.mjs check`):
1. **Recover the regression:** A/B each `loadProgram7` pass (constructor classes, splits, direct calls) with temporary switches. Keep them only if they're neutral or better on their own, and otherwise gate them (for example, only when the analysis can type the class's fields).
2. **Typed container fields with identity preserved:**
   - Allow array- and record-typed fields in JS classes (`jsFieldInitializerType`) when the shape analysis (Part 11) proves the element and field sites. Example: `pingedTasks` holds only `{replay,node,…}@4500|@4553`.
   - Make sure crossing into `dyn` wraps (typed-ref capsule) rather than copies, so identity holds. `/tmp/fld` is the identity test harness.
   - The analysis still sees ⊤ arms from legitimate escapes (task `ping` closures given to user thenables). For fields, treat ⊤ as "values from outside", which is safe when those can only be what JS code inside the package stores. That needs a check that unknown code can't write the field: the analysis's `⊤-writable` per field.
3. **Typed chunk arrays:** `segment.chunks` and `target` arrays of `string | Uint8Array` as typed unions, so `writeChunk(destination, chunk)` instantiates with a typed `chunk`, and `pushStartInstance` pushes typed chunks.
4. Then re-profile. The hot functions should leave the dynamic tier, and the micro-benchmarks put the static path near Node.

**State of the tree:** everything is uncommitted in `scriptc-react`, builds, and lint is clean. React's HTML is identical on all routes. `/tmp/sp`, `/tmp/fld`, `chunk-writer`, commander, smol-toml and js-yaml all match Node.

## Part 14: 21% faster (Oct 26)

**Result:** `/large` 37.4 → 29.4 ms, `/medium` 1.80 → 1.44 ms, against `base` (the build before Parts 8–13). React's HTML is identical on all routes.

**Measuring:** `/tmp/ab.sh` runs interleaved rounds and reports the minimum per variant (`ROUNDS=n`; don't use `N`, which the render loop reads as `/large`'s row count). Other processes on the machine make single runs noisy.

**Reverted:**
- **The class-dispatch fast path** (Part 12): it cost about 4%, because its extra tests ran on every dispatch.
- **The constructor-class and direct-call passes:** parked in `/Users/lfades/all/vercel/scriptc-parked/`. Each cost 4–5%, or was neutral, without typed containers.

**Kept:**
1. **Guarded releases** in functions over the inline cap (`shapes.ts`, `GUARDED_DYN_RELEASE`): an `alwaysinline` check skips null and immortal values before calling `scr_dyn_release`. About 4%, with no compile-time change.
2. **Inline retains and string releases** (`emit-module.ts`, `inlineRcCalls`, when inline RC is on):
   - direct `scr_dyn_retain_v` / `scr_str_retain_v` calls become an inline increment that skips immortals with a branch (string literals are read-only: a branchless store crashed with SIGBUS);
   - `scr_str_release` decrements inline and calls the runtime only for the last reference.
   - About 8%.
3. **`hasOwnProperty.call(o, k)` through an alias** (`lowerObjectOwnPrototypeCall` in `lower-calls.ts`, via `isObjectHasOwnProperty`) lowers to the own-key check instead of a dynamic invoke with `strcmp` method dispatch (`createElement`'s prop copy). About 4%. Corpus: `has-own-property-alias-call.cjs`.
4. **Variable splitting is back** (`npm-static-binding-splits.ts`, run once in `loadProgram7`), restricted to `var`s (not parameters) whose webs hold values of different checker types (`writtenTypeText`). About 7% on its own now. It splits React's `target` (view, then `encodeInto` result).
5. **More proven values in the type inference** (`npm-static-binding-types.ts`):
   - Annotations are marked `@inferred`. Later rounds trust reads of those bindings and standard methods or members on them (`proven`, `checkerTypes`).
   - `new X.Y()` of library classes counts as proven. Library files include `@types/node` and scriptc's `compiler/ambient/scriptc*.d.ts`.
   - Standard method or member chains on another candidate (`memberChainRoot`) resolve after the fixed point (deferred `calls`).
   - Anonymous library result objects of primitive fields (encodeInto's `{ read; written }`) are accepted.
   - Compound assignments use proven right-hand sides.
   - `let`/`var` bindings the checker already types as exactly that primitive also take the annotation. Never `const`: a widened literal type broke Effect's `FiberRuntime`.
6. **Typed `encodeInto`** (`text-codecs.ts`, runtime `scr_text_encode_into_typed` and `_last_written` in `scr_bytes.c`): a typed string into a typed `Uint8Array` (or `Uint8Array | null`, branching to the checked call otherwise) builds the `{ read, written }` record from two numbers, with no dynamic object. About 3.5%. Corpus: `text-encoder-encode-into-typed.mjs`.
7. **Record field cache** (`scr_typed_ref_record_field` in `scr_json.c`): a 512-entry thread-local direct-mapped cache of (record ops, immortal key) → field index or absence. About 1.5%.

**Verified:**
- `npm-static.test.ts` 145/145 with a cleared cache.
- 120 random corpus programs against Node: the differences predate these changes, or come from Node not running the TypeScript syntax.
- `/tmp/sp`, `/tmp/fld`, `chunk-writer`, commander, smol-toml, js-yaml and Effect all match Node.
- Lint clean.

**Biggest remaining costs** (`/large` profile):
- the `performWork` loop entered from the `requestStorage.run` microtask: 14% including inlined helpers, mostly `sc_dyn_key_get`;
- `writeChunk` (9%), `renderElement` (6.6%), `createElement` (5.7%, untyped: it reads `arguments`, which excludes per-call-site typing);
- record capsule reads (`scr_dyn_typed_ref_key_get`, about 6%), the cycle collector's scheduled passes (about 6%; threshold tuning didn't help), and boxing of record field values on read.

## Part 15: 31% faster than base (Oct 26)

**Result** (`/tmp/ab.sh`, minimum over 6 rounds):

| | `base` | end of Part 14 | now |
|---|---|---|---|
| `/large` | 37.7 ms | 29.9 ms | 26.0 ms |
| `/medium` | 1.79 ms | 1.44 ms | 1.25 ms |

React's HTML is identical on all routes.

**New in this part:**
1. **Record capsule inline cache** (`expr-dynamic.ts` `dynKeyGet` with a literal key, runtime `scr_dyn_record_read_ic`):
   - The `ScrDynReadIc` site struct gains `record_ops` and `record_index`; the emitted global is `{ ptr, size, size, ptr, ptr, size }`.
   - A typed-ref receiver (kind 12) reads the field through the site's remembered layout; anything else falls back to `sc_dyn_key_get`.
   - About 2.6%.
2. **Checked conversions test the kind first:** `typedRefMatches` (`dyn.ts`) branches on kind 12 before calling `scr_dyn_typed_ref_is`. About 0.6%.
3. **Inline `===` between dynamic values** (`dynScalarEq`, dyn vs dyn): the same node is equal unless it's a number; different kinds are unequal unless they're a typed-ref/object pair; the runtime answers the rest. About 0.7%.
4. **Comparisons with a string literal** use `host.literalEquals` (constant length and bytes). About neutral.
5. **Immortal per-site boxes for literals:**
   - `dynFrom(strLit | numLit)` loads a per-site global (`@sc_dyn_lit_N`, thread-local in worker builds, journaled with `dynLiteralSite`) and creates it once with `scr_dyn_new_str_immortal` / `scr_dyn_new_num_immortal` (`rc = SIZE_MAX`).
   - Only with inline RC on: sanitized builds keep allocating, so the RC audit doesn't report the boxes as leaks.
   - About 5.5%.
6. **Block-scoped `var` reads** (`var-hoisting.ts`, `followsInitializingDeclaration`):
   - A `var` declared with an initializer in a nested block, and read only after the declaration within that block (outside function declarations), no longer gets an `undefined` arm.
   - Previously only top-level function statements counted as settling.
   - This made `writeChunk`'s `target` `Uint8Array | null` (a nullable pointer, no heap union). About 2.5%.
7. **Splitting improvements** (`npm-static-binding-splits.ts`):
   - A fresh binding is declared at its first write (`var x$1 = e`) when that's an assignment statement, instead of in a function-top `var` list without an initializer, which added `undefined`.
   - The original name is re-declared only if renaming took all of its declarations.
8. **Function result inference** (`npm-static-binding-types.ts`, `results`): non-generator, non-async function declarations with one declaration get a result candidate.
   - It's the union of their returns, plus `undefined` when the body's last statement isn't a `return` or `throw`.
   - A direct call flows from it; a rebound name voids it.
   - Checker-typed `var`s may take a typed-array annotation equal to their checker type (`TYPED_ARRAY`), so React's precomputed chunk globals are `bytes` instead of `dyn`. Neutral on its own for now.

**Measured and dropped:**
- **The cycle collector's threshold** (`SCR_CYCLE_THRESHOLD`) doesn't help. Its passes reclaim real cyclic garbage every render.

**Release counts per 10 `/large` renders** (temporary counters):

| Release path | Count |
|---|---|
| Immortal (no-op) | 0.38M (was 22M) |
| Dead string box | 5.7M |
| Dead number box | 1.2M |
| Surviving object | 2.6M |
| Surviving typed ref | 1.1M |

**Corpus programs added:**
- `dyn-strict-equality-kinds.cjs`
- `dyn-string-literal-comparisons.cjs`
- `dyn-literal-values.cjs`
- `block-var-initialized-reads.cjs`

**Verified:**
- 160 random corpus programs: the differences predate these changes, or come from Node's own failures (TypeScript syntax, missing certificate files).
- `npm-static.test.ts` 145/145 with a cleared cache.
- Lint clean.

## Part 16: where the remaining time is (Oct 26)

**New:**
- `Uint8Array | null | undefined` unions use the nullable-pointer representation (`nullable-unions.ts`: `bytes` arms allowed), so no heap union per assignment. About 1.3%.
- Corpus program: `nullable-uint8array-values.mjs`.
- Verified: 100 corpus programs that use `Uint8Array`/`Buffer` (the differences either predate these changes, or their compiled output is byte-identical to the committed compiler's); `npm-static.test.ts` 145/145.

**Current:** `/large` about 26 ms (Node: 3.6 ms), `/medium` about 1.25 ms.

**Self time by category** (`/large`):

| Category | Share | Notes |
|---|---|---|
| Compiled code | 36% | Instruction-level samples (`/tmp/selfoff.py` + `llvm-objdump`): mostly inlined reference counting (decrement, kind switch, collector candidate check). |
| RC runtime calls | 14% | |
| Property reads | 10% | |
| Allocation and freeing | 9% | |
| Cycle collector | 5–7.6% | Real cyclic garbage. |
| Comparisons | 5% | |
| Property writes | 4% | |

**Conclusion:**
- About half of the render is reference counting and boxing for the dynamic values React's untyped core creates (1.45M releases per render, 570k of them dead string boxes).
- Each remaining runtime micro-optimization is worth 1–3%.

**What could close most of the gap to Node:**
1. **A tagged dynamic value representation:** NaN-boxing or small immediates, so numbers, booleans, `null`, `undefined` and maybe strings aren't heap boxes. This changes the whole dynamic tier's ABI, a very large change.
2. **Request-scoped memory regions:** allocate a render's objects in an arena, freed at once, with no reference counting inside. Soundness depends on escape analysis.
3. **Typing React's core containers:** tasks, segments, chunk arrays. This needs a flow-sensitive whole-program analysis; the current shape analysis merges React's reused variables, so the segment's `id` field holds about 1,650 sites.

## Part 17: typing one React container, an upper-bound experiment (Oct 26)

Before building flow-sensitive inference for React's containers, I measured the payoff by hand. In a copy of React, I annotated a segment's `chunks` as `Array<string | Uint8Array>`, the type inference would have to prove.

- **First result: 11.7 s per `/large` render** (from 26 ms), with correct bytes. `pushStringAttribute` calls `target.push(a, b, c)` on the typed array from untyped code. Live `push` on a typed array handled one argument only, so every multi-argument push copied the whole array into a dynamic snapshot, pushed, and wrote it back: quadratic.
- **Fix (runtime, general):** `dyn_live_array_method` appends any number of arguments through the native array's ops. If a value doesn't fit the element type, it truncates back to the original length and the snapshot path answers the whole call, so nothing is pushed twice. Corpus: `typed-array-untyped-multi-push.ts`.
- **Second result: 31.4 ms**, still slower than the untyped 26 ms. Every element of a `string | Uint8Array` array is a heap union box (`scr_union_new_ref`); a union of two pointer types has no cheap representation.
- **Conclusion:** typing one React container is a net loss unless everything around it is also typed and the union representation is cheap. Inference for containers pays off only after (1) pointer-only unions get a tagged-pointer representation instead of a heap box, and (2) inference covers whole data paths (segment → chunks → `writeChunk` → destination), not single fields.

- **Whole chunk path typed by hand** (`writeChunk` / `writeChunkAndReturn` with `@param {string | Uint8Array} chunk`, `flushSubtree`'s `chunks` local): 25.8 ms `/large`, the same as untyped (about 26 ms); `/medium` 1.51 ms, worse than untyped (about 1.27). `writeChunk` compiles typed, but the boundary moves instead of disappearing. `segment` is still untyped, so `segment.chunks` reads go through typed-reference record fields and the materialize helpers (about 4.5%). Union boxes cost another 4.5%.
- **What this means:** React's objects form one connected graph (segments → tasks → requests → boundaries). Typing any part makes every untyped neighbor pay to cross, so partial typing breaks even at best. A win needs essentially all of React's core typed, and earlier shape analysis showed that can't be proven soundly (the request escapes into user code, so the analysis gives up on it). Tagged pointer unions would remove about 3–4.5% in these typed builds and nothing in the untyped one.

Also landed in this piece of work:

- **Specialization fallback** (`specializationFallback`, `generic-functions.ts`): when a plain function's typed instance defers a refusal to a runtime fence (a form only the checked-dynamic body compiles, such as `JSON.stringify` of a `Uint8Array`), the instance forwards to the default instance, converting its arguments. Deliberate fences (a `require` resolved at run time) don't trigger it. `lowerer.deferRefusals` records which fences are deferred refusals. Test: "a specialization that reaches a checked-dynamic form forwards to the default instance" in `npm-static.test.ts`.
- **Validation:** `npm-static.test.ts` 146/146 (cleared cache); 90 corpus programs (pushes, `Uint8Array`, implicit instances) match Node; lint clean; preflight/order baselines recorded for the new corpus programs.
- **React:** unchanged at about 25.5–26 ms `/large` (these paths only matter once containers are typed); output identical.

## Part 18: making the untyped path cheaper (Oct 27)

React stays untyped; this batch makes the dynamic tier's operations cheaper. All changes are general, and each was measured with `/tmp/ab.sh` against the previous build. Result: `/large` 25.7 → 20.5 ms (−20%), `/medium` 1.23 → 0.98 ms (−20%); original base 37.4 ms. Output identical.

<table>
<tr><th>Change</th><th>Where</th><th>/large</th></tr>
<tr><td>Record capsules answer at property cache sites: a record compiled by static code (React's task, element) reached by dynamic code reads and writes its declared fields through the record ops, with the field index cached per site, instead of the helper call → generic [[Get]]/[[Set]] → key comparison.</td><td><code>scr_js_object.c</code> (<code>scr_js_record_load/store</code>), exports <code>scr_dyn_record_field_index</code>, <code>scr_dyn_typed_ref_is_frozen</code></td><td>−4.7%, then −1.2% inlining the checks</td></tr>
<tr><td>Byte-array headers recycle through a per-thread free list (<code>subarray</code> views made and dropped per chunk). Compiled out under the RC audit.</td><td><code>scr_bytes.c</code></td><td>−1.5%</td></tr>
<tr><td>Inline fast path for <code>dynCheck</code> to <code>string</code>: a string node yields its payload, retained; others call the checking helper.</td><td><code>expr-async.ts</code> (<code>emitStringCheck</code>)</td><td>−2.2%</td></tr>
<tr><td>Strict equality against a boxed primitive literal (<code>dynFrom(strLit/numLit/boolLit)</code>, which switch cases over dyn values produce) compares as the scalar: kind test plus inline literal comparison, instead of a <code>scr_dyn_strict_eq</code> call per case. React's 47-case <code>switch (type)</code> in <code>pushStartInstance</code> was the hot one.</td><td><code>expr-dynamic.ts</code> (<code>dynScalarEq</code>)</td><td>−8%</td></tr>
<tr><td>Property cache sites for <code>byteLength</code> and <code>length</code> answer typed arrays inline through <code>scr_dyn_bytes_size</code> (declines for views with own named properties, and <code>length</code> of a DataView).</td><td><code>js-ic.ts</code>, <code>scr_json.c</code></td><td>−5.9%</td></tr>
<tr><td>Live multi-argument <code>push</code> on typed arrays from untyped code (Part 17).</td><td><code>scr_dyn_invoke.c</code></td><td>— (only typed containers)</td></tr>
</table>

- **Leak fix:** immortal literal boxes (`scr_dyn_new_str_immortal` / `scr_dyn_new_num_immortal`, from the per-site literal boxes) were counted as live by the RC audit, so sanitized builds of any program converting a literal to dyn failed with "N dyn value(s) live at exit". `scr_dyn_make_immortal` uncounts them.
- **Tried and reverted (no gain):**
  - Inline record reads at load sites: probe time dropped, but the binary grew 5% and wall time didn't move.
  - Jump-table dispatch for switches over dyn strings: after the literal fix, the case tests are already cheap.
  - Inline string `length` at sites: after `typeof` narrowing, `chunk.length` is already typed.
  - Building mostly-dyn JS literals as dyn objects: −0.8% over 20 rounds, too fragile a rule for that.
- **Tests:**
  - Corpus programs `record-capsule-dynamic-field-access.cjs`, `dyn-switch-literal-cases.cjs`, `dyn-typed-array-sizes.cjs`, `typed-array-untyped-multi-push.ts`, each with a cost file and order baselines.
  - `npm-static.test.ts`: 146/146 (cleared cache).
  - JS corpus sample (160): only pre-existing differences. TS sample (120): 9 differences, all identical with the committed compiler (Node can't strip enums or decorators).
  - Sanitized sample (70): clean apart from pre-existing differences.
  - Lint and format clean.
- **Where the time is now (`/large`):** compiled code 27%, refcounting and freeing 24%, cache probes 12.5%, cycle collector 6.8%, allocation 5%.

## Part 19: toward static React (Oct 27)

Second batch on the dynamic path, then the first static-path infrastructure.

- **Shared for-in key snapshots:** objects of one JS shape share one immortal key array (`scr_js_for_in_keys` in `scr_js_object.c`, used by `scr_dyn_own_key_strs` for for-in). It applies when every entry is enumerable and no key is integer-like. −3.6% `/large`. Corpus: `for-in-shared-key-snapshots.cjs`.
- **Lazy shared integer nodes 256–4096** (`scr_dyn_lazy_int` in `scr_json.c`): filled on first use with atomic stores, so untouched entries cost no memory. About −1–2%. Corpus: `dyn-integer-values.cjs`.
- **`--optimization speed`** is a further −2.7% on `/large` (a user posture; the bench uses release).
- **Current:** `/large` ≈ 19.7 ms (from 26 this session, 37.7 base), `/medium` ≈ 0.94 ms.

**Static path, step 1: tagged pointer unions** (`nullable-unions.ts` `TaggedUnion`, helpers `emitTaggedUnionHelpers` in `shapes.ts`, `emitTaggedPayload`/`emitTaggedWrap` in `union-repr.ts`):
- Unions of 2–4 leaf reference arms (string, bytes, stats) plus up to two unit arms are the payload pointer with the arm index in its low two bits: `string | Uint8Array`, `string | Buffer | null`.
- No box, no allocation; retain and release dispatch on the bits. Leaf arms only, so the collector never visits a tagged value; traced arms need trace masking first. `SCRIPTC_TAGGED_UNIONS=0` turns it off.
- Fixed along the way: hard-coded box builders (child and stream `'data'` thunks, promise payloads, runtime results, map/array absent wraps); JSON parse schemas decline tagged unions.
- Corpus samples: 85/90 `Uint8Array`/`Buffer` TS programs match Node (the 5 differences predate this change); sanitizer clean on the test program.
- React: neutral today (nothing typed uses these unions yet). With the hand-typed chunk path, the gap to untyped went from +1% to +0.6%.

**What blocks static React**, measured with the hand-typed chunk path:
- `segment.chunks` stays dynamic: an empty `[]` literal has no element type, and a JSDoc cast on it isn't honored when lowering.
- Even typed, the segment is reached through `task.blockedSegment` (dyn), so `target` in `pushStartInstance` → `pushAttribute` → `pushStringAttribute` is dyn, and every `target.push(...)` goes through dynamic invoke into the typed array.
- Typed arrays already accept foreign elements from dynamic code (`SCR_ARR_FOREIGN`), but typed code reading one throws, so inferred container types must be provably right.
- Proving them for React means interprocedural, flow-sensitive inference over aliased objects (task → segment → chunks, with `typeof` narrowing of pushed values). The shape analysis attempted earlier was too imprecise for this.

## Part 20: decision, compile React from its Flow sources (Oct 27)

**Decision:** React's static path comes from React's own Flow types. scriptc gets first-class Flow support: it should feel native, not like a patch.

**Constraints:**
- No extra cost for projects without Flow: Flow handling loads only when Flow files are present.
- Don't rely on `@types/react`. It doesn't match React's core types; React's own Flow types are the source of truth.
- Keep working in the `scriptc-react` worktree; splitting the change comes later.
- Move fast: no scriptc test runs while iterating.

**Prototype so far** (outside scriptc, in `/Users/lfades/all/my-own-next/react-src`):
- **Source:** React v19.3.1 cloned at `react-src/react`.
- **Converter:** `build-ts.mjs` follows imports from `react-dom/src/server/ReactDOMFizzServerNode.js` and applies the `dom-node` forks of React's Rollup build. It converts each module to TypeScript using a hermes-parser pre-pass (`/tmp/ft/pre.mjs`, for newer Flow syntax) plus `@khanacademy/flow-to-ts` (`/tmp/ft/conv.sh`), and writes `fizz-ts/` (63 modules).
- **Under Node:** the converted renderer renders correctly (`fizz-ts/smoke.ts`).
- **Under scriptc:** about 60 diagnostics.

**Lessons for the real implementation:**
- `flow-to-ts` is too old (no `as` casts, typed catch parameters, newer type nodes) and gets `mixed`/`any` wrong for scriptc. scriptc needs its own Flow translation on hermes-parser.
- Flow `mixed` and `any` must be `unknown` (scriptc has no `any` representation).
- Flow `(x: any)` casts that only silence Flow should keep the operand's own type.
- `opaque type` becomes its underlying type, and `void` in unions becomes `undefined`.
- React's build-time setup (forks, `__DEV__`/`__EXPERIMENTAL__` defines, the flow-typed globals such as `ConsoleTask`) needs project configuration.
- User-facing types (nodes, elements, contexts, props, thenables) are loose in React's own types and stay checked-dynamic. React's internal structures (request, tasks, segments, boundaries, chunks, hooks state) are precisely typed, and that's the static win.
- scriptc gaps found so far: generic function values (`Object.assign`, `getCacheForType`), class & object intersections (`Destination`), `FormData`, circular imports involving bindings whose types don't compile, and implicit `unknown`-to-record conversions where Flow refines.

## Part 21: native Flow support in scriptc (Oct 27)

**Design** (all in the `scriptc-react` worktree):
- **`frontend/flow/translate.ts`:** Flow → TypeScript by in-place source edits over hermes-parser's ESTree.
  - Only Flow constructs whose TypeScript spelling differs are rewritten; comments and formatting are copied. Diagnostics map back through `frontend/source-edits.ts` (a general edits-with-position-maps utility).
  - Types are reprinted: `mixed`/`any` → `unknown`; `?T`; exact and inexact objects; spreads → intersections; variance; `$ReadOnly`, `$Keys` and friends; `opaque type`; `void` in unions → `undefined`; `Iterator<T>` gets explicit `unknown` result types.
  - Casts: `(x: T)` → `(x as T)`, and `(x: any)` keeps the operand's own type.
  - Functions: `%checks` predicates dropped. An unannotated parameter is `unknown`, optional when trailing. A function that reads `arguments` takes extra arguments.
  - Project `dynamicTypes` translate to `unknown`. Project `constants` substitute and drop the `if`/`?:` branches they decide, keeping hoisted `var` names.
  - Every module is marked `@ts-nocheck`: Flow is the checker of record, TypeScript still computes and uses the types, and scriptc's lowering still enforces what it needs.
  - Not supported yet: Flow enums, component/hook syntax, `import typeof`.
- **`frontend/flow/index.ts`:** a Flow module `m.js` (`@flow`/`@noflow` pragma, or every project `.js` with `flow.all`) is presented as `m.ts`.
  - The program serves the translation at that path and hides the `.js`.
  - Specifiers resolve as for any TypeScript source: `resolve.ts` maps answers through `flowPresentedPath`, and the host shadow gained a `fileExists` hook.
  - Translation happens on first use, and nothing runs without the setting (no file is read for a pragma).
- **`frontend/module-substitutions.ts`:** `scriptc.moduleSubstitutions` answers a module with another (a build's platform forks) by serving a re-export.
- **Project config** (`project-config.ts`): `scriptc.flow` (`true` or `{ all, dynamicTypes }`), `scriptc.constants`, `scriptc.moduleSubstitutions`.
- **Parser:** `hermes-parser` is a compiler dependency, loaded lazily by the Node frontend services (`services.parseFlow`).

**Type-mapping fixes found on the way:**
- (Reverted in Part 22) A class instance refined by a plain object type mapped to the instance. It also swallowed index signatures and required members, so it was removed; React's `Destination` is checked-dynamic instead.
- `Set`/`Map` of a recursive union still being mapped (`Set<Task>` inside a `Task` arm) no longer fails on the placeholder's empty arm list; the validator checks the completed module.
- Union-arm diagnostics now include the arm's own blocker.

**The React project** (`/Users/lfades/all/my-own-next/react-src/static`):
- `package.json`: `scriptc.flow` (`all`, `dynamicTypes` for user-facing values), `constants` (`__DEV__`, `__EXPERIMENTAL__`, `__PROFILE__` = false), and the `dom-node` forks as `moduleSubstitutions`.
- `tsconfig.json`: `paths` for React's bare specifiers (`shared/*`, `react-server/*`, …) into the v19.3.1 source checkout. (Part 22 moves `react` and `react-dom` to their sources too.) No `@types/react`.
- `flow-globals.d.ts`: the flow-typed globals (`ConsoleTask`, `TimeoutID`, `CallSite`).
- `smoke.ts` renders a small tree.
- **Status:** every module translates and loads, TypeScript accepts the program, and `Request`/`Task`/segments now compile as static records. What remains is scriptc static-tier gaps in the renderer's code, about 30 kinds:
  - **Library:** `Object.assign`, `Object.defineProperty`, `Map`/`Set` `forEach` with a `thisArg`, `queueMicrotask`, `Function.prototype.bind`/`apply` values.
  - **Unions and tuples:** `.length` on unions, element access and assignment on tuple-like replay nodes, union layout conversions, `delete` with number keys.
  - **Values from the published `react` package:** TS modules importing `react`/`react-dom` as namespaces or named bindings (`Children`), and `unknown` passed to typed parameters where Flow refined.
  - **Misc:** for-in over an optional record, symbol truthiness, generic function values, record width coercions, and `FormData` (to be added to `dynamicTypes`).

## Part 22: React compiled from its Flow sources renders, 46% faster (Oct 27)

**Result:** the whole server stack (`react`, `react-dom`, the Fizz renderer) compiles from React's Flow sources, and the bench app compiles against it unchanged. HTML is byte-identical to Node with the published React on every route (`/hello`, `/medium`, `/large?n=500`, `/large?n=50`, `/suspense`). Best of 12 interleaved rounds, against `G3` (the best dynamic-path build):

<table>
<tr><th>binary</th><th>/medium</th><th>/large</th></tr>
<tr><td>G3 (published React, dynamic path)</td><td>946 µs</td><td>19.6 ms</td></tr>
<tr><td>S1 (React from Flow sources)</td><td>545 µs</td><td>12.0 ms</td></tr>
<tr><td>S7 (current)</td><td>487 µs</td><td>10.6 ms</td></tr>
</table>

Node renders `/large` in 3.6 ms, so this is still about 3× off.

**Project setup** (`/Users/lfades/all/my-own-next/react-src/static`):
- `tsconfig.json` `paths`: `react` → `packages/react/index.stable.js` and `react-dom` → `packages/react-dom/index.js` (the entries React's release build picks with `__EXPERIMENTAL__` false), and `react-dom/server.node` → `react-dom/src/server/react-dom-server.node.js`.
- `moduleSubstitutions`: `shared/ReactSharedInternals` → `react/src/ReactSharedInternalsClient`, `shared/ReactDOMSharedInternals` → `react-dom/src/ReactDOMSharedInternals` (React's own forks for a single program; without them the namespace imports form import cycles).
- `flow.dynamicTypes` additions, all user-facing or cold boundaries: `HostDispatcher` (preload/preconnect dispatch), `SharedStateClient` (built partial and filled later), `ThrownInfo` (lazy `defineProperty` getter on the error path), `Destination` (the user's stream: `flush` probe and `destroy`), and the thenable family (`Wakeable`, `ThenableImpl`, `Pending`/`WeakPending`/`Fulfilled`/`RejectedThenable`).
- `flow.types: { "ReactOptimisticKey": "unique symbol" }` (see below).
- `bench/`: copies of the bench app's `render-loop.mjs`, `render.mjs`, `workloads.mjs`, `server.mjs`, unchanged.

**Compiler changes (general, each with its reason):**
- **Flow translation** (`frontend/flow/translate.ts`):
  - `flow.types` corrects a Flow type to the TypeScript type it really is. `"unique symbol"` makes the type the unique symbol of the module `const` declared with it, so equality refines it out of unions as Flow does with the literal it pretends to be. React's `ReactOptimisticKey` is a symbol typed `true` for exactly that reason. Typing it `unknown` had made every key, `keyOrIndex` and `keyPath` dynamic: −10% on `/large` once fixed.
  - An unannotated `const x = [a, b.c]` of references is the tuple Flow infers (`[typeof a, typeof b.c]`), unless the function uses `x` as an array. This gives React's `KeyNode` tuples.
  - `const f: T = (null: any)` / `null as any` (after constant folding of `__DEV__ ? … : (null: any)`) holds `T | null`.
  - A function declaration reading `arguments` gets a variadic overload for TypeScript callers, and the implementation keeps its parameters and JavaScript's hidden arguments slot (replacing the earlier synthetic `...rest_` parameter, which broke `arguments.length`).
  - The `@ts-nocheck` header goes first among offset-0 insertions.
- **Flow modules follow JavaScript where annotations stop** (`isJsLikeSourceFile` in `program.ts`): ES5 constructor functions and prototype assignments (`ReactBaseClasses`), expando members, `this` in unannotated functions, prototype-method parameters, the hidden arguments slot, `Array(n)` as `unknown[]`, and `never` narrowings not treated as proofs.
- **TypeScript importers of CommonJS program modules:** namespace imports read the members Node's lexer detects, as JavaScript importers already did (SC1013 removed for that case).
- **Bare specifiers the project resolves to its own sources** (tsconfig `paths`) are program code, not npm packages (`pipeline.ts`, via `resolveProjectModule`).
- **Generic functions in unpinned slots:** a generic function stored into an `unknown`/`any` slot (or, in JavaScript-like sources, a slot with no contextual signature or a generic one) is its erased instance. Shorthand properties go through the same path. This compiles React's hooks dispatchers.
- **Builtins as values:** `queueMicrotask` as a typed function value; `Function.prototype.bind` as an interned builtin that binds its receiver (JavaScript-like sources).
- **Typed `this`:** the typed first-parameter ABI applies only when every reference binds the receiver (`f.call(t, …)`, `forEach(f, thisArg)`). `this: void` and other uses keep the checked-dynamic receiver. Before this fix, six corpus programs regressed.
- **`AsyncLocalStorage.run(store, fn, ...args)`** with a compiled callback that can't box: a lifted helper enters the store (`scr_als_push`), calls `fn` with its typed arguments, and restores in a finally (`scr_als_pop`). React's `startWork` compiles statically.
- **Object literals:** a field the checker typed as an all-`any` instantiation (`new Map()` typed without context under `@ts-nocheck`) takes the typed container the value lowered to, including nested literals.
- **`arguments.length`** reads in functions with the hidden slot skip the stdlib fence.
- **`typeof v === "object"`** answers by kind inline. Only typed references and proxies call the runtime (`scr_dyn_typeof_object_ref`), instead of two calls per test.

**Tried and reverted:** a class-capsule fast path in the class-dynamic-dispatch helpers (neutral: the time is the underlying store), and elements as dynamic objects instead of records (+1.4%, not kept).

**Tests added:**
- Corpus programs (Node differential, plain and sanitized lanes): `cjs-namespace-import-from-typescript/main.ts`, `queue-microtask-typed-value.ts`, `async-local-storage-run-typed-callback.ts`, `function-prototype-bind-value.cjs`, `generic-function-erased-value.ts`, `typeof-object-dynamic-kinds.cjs`, with cost files and order baselines.
- `frontend/flow/translate.test.ts`: tuples, silenced nulls, unique symbols, type overrides, variadic overloads.
- Snapshot updates: `import-forms` (the CommonJS namespace refusal is gone), `retired-engine-968` (arm blocker detail), and four coverage snapshots (fewer dynamic-tier statements, because functions that never read `this` no longer get a dynamic receiver).
- Passing: diagnostics (235), npm-static (146), coverage (62), lint, format.
- Not run: the full corpus and the sandbox gate.

**Where `/large` time goes now** (S4 profile):
- **Spread:** checked-dynamic object release and dispose is still the largest block. It mostly frees element trees after each component renders; the elements themselves are records with typed-reference wrappers.
- **`createElement`:** about 20% with its props copy (`for-in` + `hasOwnProperty` + computed stores into a fresh props object) and `ReactElement`.
- **Output:** about 10% (`writeStringChunk`, `writeViewChunk`, encode, escape).
- **The app's own components:** about 10%.
- **Smaller items:** `union_retag` on chunk reads (`%arr.idxOr` builds `T | undefined`, then narrows back: about 2.4%), `pushComponentStack`, `getComponentNameFromType`.

No single item is over 10%. The next big step is a cheaper memory model for checked-dynamic objects (elements and props), or typing the app.

**Next:**
- Fuse an array read with its narrowing when the consumer excludes `undefined`.
- Make tagged-union retags between equal tag layouts free.
- Look at `createElement`'s props copy.
- Re-profile.
- Run the full corpus or the sandbox gate before any PR.

## Part 23: closing the gaps the static build exposed (Oct 27)

**Result:** `/large` went from 10.6 ms to 8.0 ms (−25%) and `/medium` from 487 to 396 µs (−19%). The best dynamic-path build (`G3`) was at 19.6 ms and 946 µs, so the static React build is now 2.4× faster on both. Node is at 3.6 ms on `/large`. HTML is still byte-identical to Node on every route.

**Changes, in the order measured** (each a general compiler or runtime change):

<table>
<tr><th>change</th><th>/large</th></tr>
<tr><td>A safe array read whose consumer takes the element type reads the present element directly (<code>%arr.idxIn</code>), with the old read and narrowing only on a miss</td><td>−2%</td></tr>
<tr><td>An evolving <code>let</code> written only by for-in heads is a string; the analysis no longer treats comparisons (<code>x !== "a"</code>) as writes (a pre-existing bug)</td><td>−5%</td></tr>
<tr><td>Retyping between tagged-pointer unions whose listed arms keep their bits is the identity</td><td>−3%</td></tr>
<tr><td><code>typeof v === "object"</code> on record capsules answers without string compares</td><td>small</td></tr>
<tr><td>Keyed-store inline-cache site (<code>o[k] = v</code>) through shape transitions, dyn and string keys; a string-typed computed store key is stored as a string</td><td>−1%</td></tr>
<tr><td>Function receivers at get sites (<code>type.defaultProps</code>, <code>type.displayName</code>, <code>type.name</code>): own table through the site cache, cached absent answers, memoized builtin-name check</td><td>−4%</td></tr>
<tr><td>Inline truthiness by kind</td><td>−1.4%</td></tr>
<tr><td><code>arguments</code> count token: a call with no surplus argument passes its count instead of an array, to functions whose parameters are never reassigned; the callee builds the array from its parameters on first use as an array</td><td>−3.6%</td></tr>
<tr><td>Flow translation: a module <code>let x = null</code> only ever assigned <code>new C()</code> is <code>C | null</code>; <code>(x: any).m</code> is <code>x!.m</code> (React's output buffer becomes static; the renderer's deferred fences went from 88 to 60)</td><td>−2.4%</td></tr>
<tr><td>Scalar replacement of fresh numeric record literals read only through their fields (<code>const {read, written} = encoder.encodeInto(...)</code>)</td><td>−0.7%</td></tr>
<tr><td>Default inline RC fast paths for bytes, union and array retain/release (+1.8% binary size; <code>--optimization speed</code> adds nothing beyond this)</td><td>−4.6%</td></tr>
</table>

Also: overlapping 8-byte key compares for keys of 9–16 bytes, and `scr_dyn_property_owner` uses the indexed lookup.

**Tried and reverted:**
- A class-capsule fast path in the computed helpers.
- A string-key read site (shape scan, no gain).
- Typing module bindings from all their writes in the compiler: method dispatch follows the checker type, which stays `any`, so it's done in the Flow translator instead.
- Elements as dynamic objects (neutral).

**Bug fixed on the way:** the keyed-store probe first used a stack cache, which `scr_js_ic_add` registered in the global filled-cache list. The store core now takes a nullable cache.

**Tests:**
- Corpus programs (plain and sanitized lanes): `computed-store-fresh-objects.cjs`, `function-property-reads.cjs`, `arguments-count-without-surplus.mjs`, `dyn-truthiness-kinds.cjs`, `for-in-key-binding-inference.cjs`, `union-array-reads-into-wider-slots.ts`.
- Unit tests: translator (constructed bindings, `any` member casts) and `scalarizeRecordLiterals`.

**Corpus run** (differential suite, with Node 24.22.0, the pinned release; the machine's default Node 24.16 differs in stream batching and error messages, which accounted for 12 of the first 17 failures):
- **Fixed:** a computed store with a checker-`string` key that holds `undefined` at run time (an unchecked index read) trapped. A key now takes the string store only when its lowered value is a string.
- **Fixed:** a compiler crash in the live-record write hook on fields whose checks need handle kinds (`URL.searchParams`). The hook now covers only fields whose checked conversion is known to work; others take the checked view.
- **Unresolved:** `7748-npm-any-bytes-receiver`. The checker now types `next` as `Uint8Array` where the program expects `any` (a circular inference), so `next.at(-1)` meets the static bytes `.at` gap. Today's analyses don't query it first, so this may predate this session; it needs a clean baseline build to settle.

**Pre-existing gaps found** (not fixed; see the gaps list): a computed `o["__proto__"] = p` defines an own property; a store to a frozen object throws in sloppy-mode `.cjs`; `call`, `bind` and `toString` read off a function through a dynamic value are `undefined`.

**Where `/large` time goes now:**
- Freeing the element trees after each component (about 10%).
- `createElement` (about 11%, mostly shape transitions for the fresh props object).
- `retryNode`.
- The app's components.
- Megamorphic absent reads (`config.key`, `props.ref`).
- Output (about 8%).

## Part 24: static code and dynamic paths, round 2 (Oct 27)

`/large` went from 8.0 to 7.27 ms and `/medium` from 396 to 376 µs; HTML is still identical on every route.

**Changes** (all general):
- **For-in copy loops become one runtime call** (`ir/for-in-copies.ts`, `scr_js_copy_own_except`), as LLVM turns copy loops into `memcpy`. The loop is `for (k in src) if (hasOwn(src, k) && k !== "a" …) dst[k] = src[k]` into a fresh empty `dst`. An ordinary shaped source copies through shape transitions; with no excluded key present it clones the shape and entries instead (`scr_dyn_tier_clone_entries`). Any other source runs the loop as written. (−4%, then −2%.)
- **Inline record-capsule reads at get sites:** record ops carry the byte offsets of fields stored as checked values (`ScrDynTypedRecordOps.dyn_offsets`), and a compiled site reads React's element fields (`$$typeof`, `type`, `key`, `props`) in place (−2.6%).
- **Symbol comparisons:** `dynValue === someSymbol` compares the kind and the symbol pointer inline, with no box or runtime call (−2.3%).
- **Borrowed reads through retypes:** a retype between equal encodings is the operand's own pointer for the borrow analysis, so safe-read helpers over tagged unions lend their result (the retain/release pair per chunk read is gone).
- **Smaller ones:**
  - Simple safe array reads fuse inline.
  - `exec` on a short ASCII subject runs the compiled matcher first and returns null with no engine setup.
  - `Buffer.byteLength(s, "utf8")` returns the length directly.
  - Keyed loads scan the receiver's entries rather than the shape chain.

**Tried, no gain:** moving a temporary argument's entries (needs proving the callee never rebuilds `arguments`; replaced by the clone path).

**Measured, not pursued:** React reads `error.stack`, so every hot function pushes a frame for stack traces. Building with no frames at all gains only 1.1% on `/large` (2% on `/medium`), so replacing them with unwind-table stack capture waits until bigger costs are gone.

**Where `/large` time goes now:**
- **Freeing element trees (about 16%).** Each element releases its record, wrapper, props object and children. RC cost per object is the floor; the real lever is a cheaper memory model for short-lived checked objects (a nursery-style allocator), a large project.
- **Megamorphic absent reads** (`config.key`, `props.ref`) and the app's own components (about 11%).
- **Output (about 8%):** the per-write `subarray` view in `writeStringChunk`, and owned chunk parameters (`writeChunk` retains and releases each chunk because its parameter can escape). A borrowed-by-default parameter convention (callee retains on escape, as Swift does) would remove those pairs everywhere.

## Part 25: adopting copies, call-argument moves, teardown (Oct 27)

`/large` went from 7.27 to about 6.8 ms and `/medium` from 376 to about 360 µs. HTML is still identical on every route.

**Changes** (all general):
- **Adopting copies:**
  - **What it is:** when the source of a for-in copy loop is a parameter the function never reads after the loop, the pass (`ir/for-in-copies.ts`, `adoptableSource`) marks the parameter owned and emits `dyn.adoptOwnExcept`. Reads of `arguments[i + c]` past the parameter's position, with `i` a counter that only counts up from a non-negative integer, don't count as reads.
  - **Runtime:** `scr_js_adopt_own_except` sees the only reference to an ordinary object (refcount 1), swaps the entries into the fresh target (`scr_dyn_tier_adopt_entries`) and drops the excluded keys. Otherwise it copies as before.
  - **Caching:** key checks are memoized per (shape, excluded names), including the shape of the kept keys.
  - **Effect:** React's `createElement` no longer copies each config into props; it takes the config's entries. Together with the next item, −3.8%; the memo another −3%.
- **Call-argument moves:**
  - **What it is:** argument lowering spills a call's values into hidden locals declared in a sequence on the first argument. `ir/call-sequences.ts` hoists that sequence over a direct call, and the emitter gives a sequence's statements a cursor over the sequence (`emitSequenceStmts`) when their local is mentioned nowhere else.
  - **Effect:** each spilled argument's last read moves its reference, so a fresh literal passed to an owned parameter arrives as the only reference, and no retain/release pair remains per argument.
- **Typed-ref identity table:** slots keep the referent beside the capsule, so probes and deletion no longer load each capsule (−1.2%).
- **Pooled object keys:**
  - Disposal scans only the slots that may hold keys (`key_slots`, a high-water mark) instead of the whole capacity.
  - The pool's key budget is 2 MB instead of 64 KB; it is small next to the nodes and entry arrays the pool keeps anyway.
  - Gain: −1.3%.

**Smaller ones, each within the ±1.5% noise (kept for profile-share gains):**
- **Absent megamorphic reads:** each shape keeps a 64-bit filter of its keys' hash bits. A megamorphic site's read of an absent key on a receiver with the default prototype answers from the filter, without the shared cache (`ReactElement`'s `props.ref` probes went from 53 to 24 samples).
- **Function names:** a function's `name` read reuses the string it built last time for that name text, instead of building a string per read (React reads a component's name for every element).
- **Untouched pooled objects:** an object whose keys didn't change since it left the pool returns its cached key bytes to the budget without a scan (`drop_keys` halved).
- **Pure-read libcalls lend their operands:** `Buffer.byteLength` and `encodeInto` no longer retain and release each chunk.
- **Signature casts:** a dynamic-to-function cast compares the signature pointers before `strcmp`.
- **Record capsules in `typeof x === "object"`:** an unviewed record capsule answers inline.

**Where `/large` time goes now:** element-tree teardown is about 10% (`renderFunctionComponent`'s release of the tree a component returned), and property-cache probes are about 6%. Hot static code mostly stalls on cache misses loading the next object, so the remaining gap to Node is mainly the cost of freeing short-lived objects one by one. A nursery-style memory model for checked objects is the large lever left.

**Measured, not kept:**
- **Codegen settings:** a single LLVM partition and `-O3` each changed nothing measurable.
- **Skipping cycle-candidate buffering** for small containers without traced edges: the survivor scan cost more than the buffering it saved.
- **Keeping keys another owner holds** without the budget: no gain, because reading the key header is the cost.
- **A per-shape memo for megamorphic loads:** no gain; the shared table already hits.

## Part 26: removing hidden snapshots and per-field work (Oct 27)

`/large` went from about 6.8 to about 6.5 ms and `/medium` from about 357 to 337 µs. HTML is still identical on every route.

**Changes** (all general):
- **Stream method calls without a snapshot:** `destination.write(chunk)` on a runtime stream built the whole dynamic view of the stream (a prototype of closures plus every state property) on every call. A capsule whose cached view still has the builtin method, not overridden on the view or its prototype, now calls that method directly (`scr_dyn_typed_ref_view_builtin_method`). Materializing went from 2.5% to 0.7%, and `/medium` gained 4.5%.
- **Name reads on native arrays:** `children.$$typeof` on an array capsule materialized the array, because the capsule's lookup only knew indexes and `length`. When no view, prototype or symbol properties exist and nothing was added to `Array.prototype` or `Object.prototype`, the read now goes to a shared empty array (`scr_dyn_typed_ref_name_stand_in`), which answers exactly as the view would.
- **Index-looking keys:** `scr_arr_numeric_key` returns at once for a canonical index such as `"0"`, instead of `strtod` plus number formatting.
- **Function property tables are lent:** a read on a function borrows its property table instead of retaining and releasing it (`scr_box_peek_ref`).
- **Object literals of constant keys:** a literal whose members all have distinct constant keys is one call, `scr_js_new_literal`. The site caches the final shape and fills the entries with the shape's shared keys, with no per-field cache check or transition (about −1%).
- **Function casts:** a dynamic-to-function cast remembers the last signature pointer that matched. Signature literals have one copy per LLVM partition, so pointer equality alone rarely hit (`strcmp` went from 0.74% to 0.40%).
- **Short copies:** `TypedArray.set` of 16 bytes or fewer copies inline, and `encodeInto` of a proven-ASCII string is one copy without scanning.

**Measured, not pursued:**
- **Never freeing anything** (leaking): slower, 8.3 against 6.8 ms. Reusing freed memory keeps it cache-hot, so a nursery has to reuse one small, cache-hot region.
- **Upper bound for a nursery:** freeing is 17% and cycle collection about 3.5%, so a scheme where dead objects cost nothing removes at most about 25–30%. Exact reference counting in compiled code plus a young generation needs either deferred counting (the LXR design: no counts for young objects, plus finding every reference to them from the stack and old objects) or batched deaths. Batched deaths visit each dead object two or three times and may not win.
- **A per-record pointer to its capsule** (instead of the identity table): about 2%. Record capsules are created on several runtime paths that would all have to use it, or one record could get two capsules.

## Plan: matching and beating Node without changing React (Oct 27)

React stays unmodified; the work is in scriptc, and each step is general, so every library like React benefits. Node's advantage comes from three things we pay for: cheap objects (one block, properties inline, bump allocation), free death (a young generation that never visits dead objects), and single-load property access. The plan attacks them in the order that is most efficient and least risky:

1. **V8-style objects in the runtime.**
   - **Layout:** a small checked-dynamic object stores its properties inside its own allocation, and its keys come from its shape instead of per-entry key pointers. Large or growing objects spill to a separate store.
   - **Effect:** this halves allocations and frees for props, config and children objects, removes per-entry key bookkeeping, and makes reads one load at a known offset.
   - **Scope:** internal to the runtime's object layer; the ownership model stays as it is.
2. **Escape analysis in the compiler.** Objects proven not to outlive a call are allocated on the stack or split into locals: no counts, no free. This builds on the existing borrow, move and record-scalarization analyses, and applies to static code too.
3. **Whole-program shape inference for untyped code.** Stable shapes for the app's objects and React's `mixed`/`any` paths, such as one component's props, become plain records with fixed layouts, with a checked-dynamic fallback where inference fails.
4. **Regions or a nursery, measured again after 1–3.** With far fewer short-lived checked-dynamic objects left, the remaining teardown may no longer justify rewriting the memory model. A request region proven by escape analysis is the compile-time option; a nursery with write barriers and stack maps is the runtime one.

Expected outcome: 1 and 2 should bring `/large` close to Node's 3.6 ms; beating it most likely needs 3 as well.

## Part 27: step 1, cheaper checked objects (Oct 27)

`/large` went from about 6.45 to about 6.3 ms; HTML is identical on every route.

**A microbenchmark that isolates the gap.** Node against scriptc on plain object work (`/tmp/mb/obj.mjs`, and `/tmp/mb/tree2.mjs` with the work inside a function, as module initializers take no caches):

| Test | Node | scriptc (start) | scriptc (now) |
|---|---|---|---|
| create-drop: `{a, b, c}` read and dropped | 0.7 ns | 1.4 ns | — |
| create-keep: two million objects pushed, then freed | 12.4 ns | 100 ns | — |
| read-poly: `.a` across five shapes | 3.0 ns | 11.3 ns | — |
| tree: arrays of `{k, p: {v}}` built and dropped | 7.7 ns | 79.8 ns | 54 ns |

Objects that die at once cost about the same in both. Objects that are kept and freed later cost 8–13 times more in scriptc, which is the per-object cost of creating, storing and freeing them.

**Changes:**
- **Compact entries:** an object entry is 32 bytes instead of 48. The key length is 32-bit, and an accessor's getter and setter live in a separate `ScrDynAccessorPair`, so data properties carry no two empty pointer fields. The value stays at offset 16, the stride and flag offsets moved in `js-ic.ts` and `dyn.ts`, and every getter/setter use goes through `SCR_DYN_ENTRY_GETTER`/`SETTER` and the slot helpers. Neutral on React; it halves entry memory.
- **Moves into containers:** a statement `push` and a constant-key object literal take over their values' references (`scr_dyn_invoke_discard_move_id`, `scr_js_new_literal`). A fresh object stored into a container no longer takes a retain and a release, and that release, leaving a count of 1, made it a cycle candidate that its death then removed. The tree microbenchmark went from 79.8 to 61.7 ns, and React's `/large` gained 2.8%.
- **No calls for absent side tables:** disposal skipped `free(NULL)` for an object's index, presence map and accessor pair, which went through the dynamic-linker stub each time.
- **One-pass literal fill:** a cached literal writes all its entries in one loop (`scr_dyn_tier_fill`) instead of an append per member.
- **Exact key bytes per object:** each object keeps the key bytes its slots hold (`slot_key_bytes`), updated wherever a slot's key changes, so disposal counts them into the pool's budget without a scan. Pooled nodes that alternate between literal shapes never matched the earlier "untouched keys" shortcut.

**What the microbenchmark says next:** at 54 against 7.7 ns, the remaining cost is generic per-object work spread over allocation, the fill, releases, the destroy guard and disposal. That is what steps 2 and 3 remove: objects that are never heap-allocated (escape analysis) or that are records instead of checked objects (shape inference).

## Part 28: object life cycle, round 2 (Oct 27)

`/large` stays at about 6.3 ms; the tree microbenchmark went from 54 to about 49 ns (Node: 7.7 ns).

**Changes** (general):
- **Teardown in a loop:** a checked value that dies while another is being disposed waits in a list the outermost disposal drains, instead of recursing through the generic depth guard. A shared leaf child (null, boolean, number or string box with other owners) is released inline.
- **Moves into record literals:** a parameter whose last use is a record literal field is consumed even when sibling fields read bindings derived from it (the literal keeps the moved value alive), and a binding assigned a fresh literal is no alias of what the literal holds. React's `ReactElement` now takes `props` over from `createElement`.
- **Unwritten parameters are stable bindings:** reads of a parameter nothing declares or writes lend it instead of retaining it. `config.key` reads no longer bump `config`'s count.

**What a counter showed:** per `/large` render, about 21,000 checked objects, 11,000 element capsules, 5,700 closures and 500 arrays died while buffered as cycle candidates. Each had been retained by a container and released by its creator, leaving a count of 1. The changes above cut checked objects by a quarter with no measurable time change: what remains is spread over React's dynamic calls of components and its element plumbing.

**Measured scope of the remaining ideas:**
- **Strings without a box:** about 700 `v.str` uses and 640 string-kind checks in the runtime, for at most 1–2% of React. Not pursued.
- **Escape analysis (plan step 2):** React's dynamic objects nearly all escape (config into props, props into elements, children into props, elements returned, key paths into tasks). Not applicable to this render.
- **Shape inference (plan step 3):** props reach the app through React's generic `Component(props)` calls, and React's Flow types declare them `any`, so no single site proves a layout. Typing them needs per-layout specialization of React's render path.

## Part 29: property paths, round 3 (Oct 27)

`/large` went from about 6.3 to 5.98 ms (best same-run measurement; the machine was noisy) and `/medium` to about 322 µs. HTML is identical on every route.

**Changes** (general):
- **Absent keys at compiled get sites:** a get site's key filter bit is computed at compile time (the compiler's `scrKeyHash` mirrors the runtime's). An object whose shape filter lacks the bit and whose prototype is the default reads `undefined` inline, with no probe call. The unshaped marker sets every bit, and keys of `Object.prototype` members and `length`/`next` keep the probe. `props.ref` and `config.key` no longer call into the runtime: `scr_js_probe_load` went from 5% to 2.2%, and `/large` gained 3%.
- **Fresh records boxed without an identity entry:** `dynFrom` of a call's result (not a borrowed return) or of a record literal uses `scr_dyn_new_typed_ref_*_moved`. A record with that one reference gets a capsule marked `unregistered`, not entered into the identity table. Nothing can box it again until a static reference leaves the capsule; `scr_dyn_typed_ref_unbox`, the await exact path, in-place capsules and message encoding register it first. Element identity holds through arrays, `Map`, `WeakMap`, `Set`, props and `Children.toArray`. `scr_typed_ref_forget` dropped out of the profile (−1%).
- **Megamorphic keyed reads share the load table:** a keyed site past its four ways (`row[column]`) asks the shared (shape, key bytes) table and checks the slot's key bytes.
- **for-in keys read back by address:** a shape keeps the byte pointers of its for-in key strings, so the loop's presence test, its `hasOwnProperty` and its `props[key]` read find the slot by address (`scr_dyn_find_entry` went from 1.6% to 0.6%).

## Part 30: allocation counts (Oct 27)

`/large` is at about 5.9–6.2 ms depending on machine load; HTML is identical on every route.

**Checked-dynamic allocations per `/large` render:**

| Kind | Per render |
|---|---|
| String boxes | 41,500 |
| Checked objects | 25,700 |
| Typed-ref capsules (element wrappers) | 10,800 |
| Functions | 5,500 |
| Number boxes | 900 |
| Arrays | 900 |

**Changes:**
- **String boxes:** the Row arrow boxed each `column` string three times per cell (`key: column`, `column`, and `row[column]`). An immortal string (a literal or interned) now keeps one immortal box (`scr_dyn_new_str`); strings have no identity.
- **Function boxes:** `renderWithHooks` boxed each component's closure per render, and the Row arrow boxed `Cell` per cell. The compiler's function box helpers now use `scr_dyn_new_func_box`: an immortal closure (a top-level function) keeps one immortal box per thunk, signature and name. Functions compare by closure identity, and class boxes and adapters keep their own path.

Both are neutral within noise: a pooled box costs a free-list pop and push, so the gain is the allocation count, not time.

## Part 31: elements as plain checked objects, measured (Oct 27)

**Experiment:** `ReactElement`'s `let element` was typed `any` through a temporary translator switch, and an IR pass built `dynFrom(liveRef, recordLit)` as a checked object literal. That is equivalent for a fresh literal nothing static can reach. Each element was then one checked object instead of a record plus its capsule. HTML was identical; `/large` took 5.89 against 5.86 ms, no gain (an earlier attempt found the same). With capsule field reads inline, absent keys answered from the shape filter and fresh records boxed without an identity entry, a record plus capsule costs what one checked object does. Reverted.

**What this says about the remaining options:**
- **Specializing the render path** cannot be done soundly as a compile-time transform here. The app's components build the element tree, and React consumes it later through its task queue and segments (with Suspense retries holding nodes), so no call chain exists for the compiler to fuse.
- **A generational collector for checked values** is the remaining structural lever. Freeing (`scr_rc_destroy` inclusive) is about 17% and cycle bookkeeping about 3.5%. It needs write barriers across the runtime's stores of checked values (1,327 retain sites, about 1,000 global slots, 280 struct fields) and stack maps from the compiler.

## Part 32: design, a young generation for checked values (Oct 27)

**Goal:** dead short-lived checked values (props, children arrays, element capsules, boxes) cost no teardown walk, and stores into fresh containers cost no reference counting. Freeing is about 17% of `/large` and cycle bookkeeping about 3.5%.

**What exists:** `SCRIPTC_YOUNG_NURSERY=1` (`SCR_YIN` in `scr_cycle.c`) nurses compiled records and classes with exact counts. Each collection recounts young-to-young edges, marks from objects referenced from outside the nursery, and tears the dead down giving up only edges that leave the dead set. On React it is neutral (5.84 against 5.85 ms): dead objects are still visited edge by edge.

**The design: uncounted young slots.**
- **Young values:** every checked value (`ScrDyn`: objects, arrays, capsules, function boxes, string and number boxes) is born young. Its header has generation `SCR_CYC_YOUNG` with the buffered bit set, so releases never make it a cycle candidate, and it is listed in the young list in allocation order.
- **Invariant 1, counted references:** every reference to a young value is counted (stack, locals, globals, records and classes, closures, runtime structures, old checked containers) *except* a reference held in a young container's value slot (object entry values, array items). Because every root is counted, a young value with a nonzero count is referenced from outside the young set: **no stack maps, no conservative scan**.
- **Invariant 2, uncounted slots:** a young container's value slots hold uncounted references, whether the value is young or old.
  - Storing into a young container does not retain, and a store that takes over a reference releases it.
  - Overwriting or removing a value does not release it, and taking a value out with ownership (`pop`, `shift`, `splice` results) retains it.
  - Moving entries between containers of different generations converts the counts, or takes the copying path (adopting copies require both young).
- **Invariant 3, deferred deaths:** an old checked value whose count reaches zero while the young list is not empty may still sit in an uncounted young slot, so its teardown waits in a deferred list.
- **Death of a young value:** when its count reaches zero, nothing happens. Liveness is decided at collection.

**Collection** (when the young list reaches its limit, and before every cycle-collection pass, so trial deletion never meets young values):
1. **Mark:** every young value with a nonzero count is a root (counted references are exact). From the roots, follow the uncounted slots (entry values, array items) to young values.
2. **Sweep** the young list in order:
   - **An unmarked (dead) value** releases only the counted references it holds: a string box's string, a capsule's referent (plus identity-table forget), a function box's closure, a prototype, symbol tables, accessor pairs, a materialized view. It returns to the pool with its entry buffer and cached keys, with no recursion into slot values.
   - **A marked value is promoted:** generation old, unbuffered, and each slot value it holds gains its count (+1 per edge).
3. **Deferred old deaths:** each value whose count is still zero is torn down as today.

**Why no runtime-wide audit:** the runtime's own references (streams, timers, caches, 1,327 retain sites) are counted references and stay exactly as they are. Only code that writes or removes slot values of checked objects and arrays changes:
- **Entry values:** `scr_json.c` `scr_dyn_obj_put`, `append_shared`, `tier_fill`, `tier_append`, `clone_entries`, define-property and accessor paths, delete, `fit_object`, the view refresh; `scr_js_object.c` `scr_js_store_shaped`, adopt (both young), literal fill.
- **Array items:** `scr_dyn_arr_push`, index set, length truncation; `scr_dyn_invoke.c` `push`, `pop`, `shift`, `unshift`, `splice`, `reverse`, `fill`, `copyWithin`, `sort`.
- **Compiled code:** the inline store path of `js-ic.ts` `emitSet` (retain new, release old at entry +16).
- **Elsewhere:** `scr_message.c` decode writes into fresh arrays.

A missed store site retains into an uncounted slot (a leak); a missed removal site releases an uncounted reference (an early free). Removal sites need the most care.

**Phases:**
1. Young allocation, list and header state; `scr_dyn_release` does nothing at zero for young values; collection (mark, sweep, promote, deferred deaths); the collection before cycle passes. Slot sites still count, so the first build changes nothing observable.
2. Convert the slot sites to the uncounted rule, one family at a time (object stores, array stores, removals), measuring after each.
3. Leaf boxes and capsules through the sweep; weak tables (`scr_dyn_weak_dispose`, typed-ref identity) at sweep.

## Part 33: the young generation, built and measured (Oct 27)

Part 32's design was implemented behind `SCR_YOUNG=1`.
- **Phase 1** (young values, count/mark/sweep, deferred old deaths, the collection before cycle passes) and **phase 2 for objects** (`SCR_YOUNG_SLOTS_OBJ` 1, every entry store and removal site through `scr_slot_take`/`scr_slot_retain`/`scr_slot_out`, adopt limited to one generation, compiled inline stores sent to the probe for young receivers) were both correct: every repro and every React route was identical, with the switch on and off.
- **They were slower:** `/large` took 7.7–7.9 ms with young values against 5.8–6.1 ms without, in the same runs.
  - **First cause, premature promotion:** collecting every 16K allocations promoted the render's live tree mid-render, and its later releases made it cycle candidates (cycle passes went to 21%). Aging (two collections) and a 64K nursery removed that.
  - **What remained:** the young collection itself was 15% inclusive.
- **Why the design cannot win here:** a dead young value is still visited. Nearly every checked value holds a counted reference to a reference-counted object outside the checked world (a string box its string, a capsule its record, a function box its closure, objects their keys and accessor pairs), so the sweep must visit each dead value to release them. It must also return each node to the pool. A collection therefore does at least the work reference counting already did, plus counting and marking.
- **What a nursery would need to win:** V8 wins because a dead young object costs nothing, and the whole nursery is reset at once. That requires every kind the young values point to (strings, records, closures, keys) to live in the collected world too, and survivors to be moved out of a bump region. That is a rewrite of the whole memory model, with moving collection, precise roots from compiled code, and barriers.
- **Reverted** (commit "Revert …phase 1"); the design and this measurement stay here for reference.

## Known scriptc gaps found along the way (not fixed)

- A named function expression assigned to a variable (`const Other = function Named() {}`) reports the variable's name from `.name` (`Other`; Node prints `Named`).

- **Dynamic stores and reads on functions:**
  - A computed store `o["__proto__"] = p` defines an own property instead of setting the prototype.
  - A store to a frozen object throws in sloppy-mode `.cjs` files, where Node ignores it.
  - `call`, `bind` and `toString` read off a function through a dynamic value are `undefined`; only `apply` is answered.

- **HTTP:**
  - `ServerResponse` `'error'` listeners are refused, statically and through untyped values. This is why React pipes into a `Writable` wrapper.
  - `response.write` with a `string | undefined` argument is refused, and so is `write(chunk, callback)`.
- **Statically typed promises:** member reads, writes and `in` are refused.
- **Checker-typed reads:** a value read from a dynamic binding through an expression the checker types (`typeof x === "number" ? x : x[0]`) is checked against the checker's type, and throws when it doesn't match.
- **Typed arrays and constructors:**
  - `ArrayBuffer[Symbol.species]`, `buffer.constructor.prototype` and `buffer.__proto__` read wrong values.
  - `Reflect.get` misses typed arrays' named properties.
  - `Reflect.has` and `Object.hasOwn([1], "0")` are unsupported.
- **Constructors through module bindings:** `new (require("m").C)()` and `ns.AsyncLocalStorage.bind/snapshot` are refused.
- **Small runtime leak:** about 40 B per iteration with `setImmediate` inside `AsyncLocalStorage.run`.
- **Parallel runs:** `scriptc run` on two files with the same stem in parallel (`x.js` and `x.cjs`) mixes their outputs.
- **Typed unions of pointer types** (`string | Uint8Array`) are heap boxes per value.
- **Edge renderer:** needs `typeof` of globals Node doesn't have (`AsyncLocalStorage`, `window`) and byte `ReadableStream` with a strategy argument.

## Debugging techniques that worked

- **Who throws:** `lldb --batch -o "breakpoint set -r '^scr_throw'" -o run -o "bt 25" ./bin` names the compiled JS function that throws. Use `-n scr_dyn_check_fail` for "expected X at $" errors.
- **CPU profile:** `sample <pid> 4 -file out.txt`, then look at "Sort by top of stack".
- **Leaks:**
  - `--sanitize` builds; the RC audit reports per-kind live counts at exit.
  - macOS `leaks <pid>` distinguishes unreachable memory from retained memory.
  - Temporary collector instrumentation (per-pass freed and live counts; a histogram of externally referenced gray objects) showed that the garbage wasn't reachable from candidates.
  - Bisecting React by editing a copy in `/tmp/leak/bis/node_modules` (never the real one).
- **IR inspection:** `--emit ir -o x.ir`, then read it with Python: function `tier`, param types, and `libCall` names.
- **Function names:** `--keep-llvm` keeps `.ll` files, which helps map `sc_ldr_N_materialize` to a record type.

## Scratch locations

- `/var/folders/9t/dl6s3x6n57df07s6xs4jvyfr0000gn/T/opencode/ssr-node/`: early React test programs (`main.mjs`, `rich.mjs`, `stream.mjs`, `sc.sh`).
- `/var/folders/9t/dl6s3x6n57df07s6xs4jvyfr0000gn/T/opencode/repro/`: small repros.
- `/tmp/leak/`: leak and performance repros; `bis/` has the copied React for bisecting.
- `/tmp/dp/one.sh`: compares one corpus program between Node and scriptc (`SAME`/`DIFF`). Feed it a file list with `xargs -P 6`.
