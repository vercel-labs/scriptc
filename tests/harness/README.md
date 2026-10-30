# Test harness

Two lanes over the same suite: plain (`pnpm test`) and sanitized (`SCRIPTC_SAN=1 pnpm test`, ASan + the runtime RC audit). Corpus programs use Node as the oracle: they run under Node and as compiled binaries, and outputs must match exactly. The Test262 profile uses upstream assertions as its oracle. Both lanes must be green before a commit.

One deliberate exception to raw byte-compare: `node:test` programs (tests/harness/node-test.test.ts over tests/fixtures/node-test) cannot live in the corpus because Node's spec reporter embeds a real duration in EVERY result line — no node:test program has deterministic stdout, under Node itself included. Those fixtures still run both lanes against the Node oracle, but with one documented normalization applied to both sides (durations, stack frames, the inspect property block); everything else — symbols, indentation, directives, summary counts, the failing-section "test at" locations and error messages — must match byte-exactly, plus exit-code parity against the fixture's `// @exit:` line. Fixtures never console.log inside test bodies: Node's reporter stream lags console output racily, so mixed programs aren't byte-comparable against any oracle.

The LLVM differential suite (`tests/harness/llvm-differential.test.ts`) compiles every corpus program in release and dev modes and compares stdout, successful stderr, and exit status with Node. Any backend refusal fails the test. Under `SCRIPTC_SAN=1`, the emitted functions and runtime are instrumented with AddressSanitizer.

A third, env-gated lane runs the corpus AND the fixture sets with runtime legs (tests/fixtures/server, tests/fixtures/dgram, tests/fixtures/fetch) on LINUX: `SCRIPTC_LINUX=1 pnpm exec vitest run tests/harness/linux-differential.test.ts` emits every program through LLVM, selects a precompiled runtime pack with `SCRIPTC_TARGET`, and links through Zig and byte-compares against a Linux Node oracle inside a Docker container — for the fixtures, both lanes, the per-case driver, and the fetch servers all run in-container. `SCRIPTC_LINUX_TARGET=<arch>-linux-gnu.2.36` runs the whole lane in Bookworm; `SCRIPTC_LINUX_TARGET=<arch>-linux-musl` runs it in Alpine. The container platform follows the triple (`linux/arm64` for AArch64, `linux/amd64` for x86_64; the latter uses Rosetta/qemu on Apple-silicon Docker). It skips entirely without the env var and is never part of the commit gate.

A fourth lane does the same on WINDOWS: `SCRIPTC_WIN=1 pnpm exec vitest run tests/harness/windows-differential.test.ts` cross-compiles for `x86_64-windows-gnu`, ships each .exe (plus the program source) to the Windows box over scp, runs BOTH sides there over ssh — the box's own Windows Node is the oracle — and byte-compares stdout/exit codes with nothing normalized. `SCRIPTC_WIN_FILTER=<regex>` narrows a run; the box alias is `windows-dev` (`SCRIPTC_WIN_HOST` overrides). Programs needing cross-gated features skip with the gate's reason, and the in-file `WINDOWS_SKIPS` list names what compiles but deliberately diverges on Windows (posix-shaped spawn programs whose /bin children are ENOENT on Windows Node too, uid/tty surfaces) — both lists are the port's worklist. Never part of the commit gate.

A fifth lane covers LIBRARY MODE across targets: `SCRIPTC_CROSS=1 pnpm exec vitest run tests/harness/library-cross.test.ts` cross-builds every K-fixture library profile (LLVM emission) for `aarch64-linux-gnu.2.36`, `x86_64-linux-gnu.2.36`, `aarch64-linux-musl`, `x86_64-linux-musl`, `x86_64-windows-gnu`, and `x86_64-macos`, then asserts per archive ON THE HOST: K1 symbol exactness (nm reads ELF/COFF/Mach-O alike), the K8 ambient audit, and that each fixture's probe LINKS against the target's libc — plus, on win32, the documented embedder system libs (advapi32/iphlpapi/ws2_32, native-toolchain.ts's unconditional executable set). With `SCRIPTC_LINUX=1`/`SCRIPTC_WIN=1` additionally set, the K2 scalar probe also EXECUTES per linux triple in its matching Docker distribution and on the Windows box; x86_64-macos is build-only by contract (the probe runs as a bonus when Rosetta is present). Needs zig on PATH; `SCRIPTC_CROSS_FILTER=<regex>` narrows the fixture list. Never part of the commit gate.

## Workflow

Iterate filtered, gate full: while developing, run just what you're touching (`pnpm exec vitest run tests/harness/differential.test.ts -t <name>` or a single test file); run the full lanes (`pnpm test`, then `SCRIPTC_SAN=1 pnpm test`) as the gate before committing.

### Fetch compatibility profile

The engine-free fetch/Web Streams slice has one versioned source of truth in
`packages/compiler/src/compat/fetch-profile.ts`. It pins the exact Node and
bundled Undici oracle, drives the lowering allowlists, projects every supported
operation into `packages/compiler/surface-manifest.json`, and names the
differential evidence for each operation and `RequestInit`/`ResponseInit` member. A new row
without a real fixture or registered generated scenario fails the profile
suite.

`pnpm test:fetch-conformance` generates a program from that profile and runs it
under the pinned Node and the LLVM backend. The default seed exercises
WebIDL argument conversion/order, AbortSignal events, and twelve valid
ReadableStream state-machine traces. Reproduce or widen a campaign with:

```bash
SCRIPTC_FETCH_CONFORMANCE_SEED=12345 \
SCRIPTC_FETCH_CONFORMANCE_TRACES=50 \
pnpm test:fetch-conformance
```

The same profile now carries the denominator, not just the supported rows.
It reflects the public constructor/static/prototype surface of AbortController,
AbortSignal, Headers, Request, Response, ReadableStream, its default reader,
and its default controller. Proxy-backed constructor probes record Node's exact
RequestInit and ResponseInit WebIDL dictionary reads (including runtime members
that may be newer than the installed declarations). Every item is classified:

- `static`: engine-free and tied one-to-one to a differential-evidence row;
- `unsupported`: an explicit SC2020 refusal that remains implementation work;
- `out-of-scope`: reflection metadata such as `Symbol.toStringTag`, retained so
  the scope boundary is machine-readable.

The selected adjacent interface families excluded from the census carry
reasons too. A Node upgrade that adds/removes a public member or dictionary key
fails the focused suite until that member is classified. The static and unsupported rows project into the shipped surface manifest;
filter `node24FetchCompatProfile().inventory.entries` by `status`/`owner` for
the next cohesive implementation queue.

When Node changes, update `.node-version` and the profile's Node/Undici tuple
together, regenerate with `pnpm manifest`, then run the focused plain and
sanitized conformance lanes before the full sandbox gate. When the static fetch
surface changes, update the profile first; its evidence check makes the missing
fixture or generated scenario the implementation worklist.

Full-suite runs (`vitest run` with no filters) take an advisory machine-wide lock (a pidfile in the OS temp dir) so concurrent full suites — typically parallel agents — queue instead of oversubscribing the CPU, which is a known flake source (vitest worker RPC timeouts, event-loop timing failures). The lock is per flavor (plain vs `SCRIPTC_SAN=1`): the two lanes read the same committed tree through separate cache directories, so a merge gate may deliberately run one of each concurrently — split the cores between them with `SCRIPTC_TEST_WORKERS` (e.g. 5 and 5) or the oversubscription flakes come back. Two runs of the SAME flavor still queue. Filtered and watch runs never wait. `SCRIPTC_NO_LOCK=1` opts out; stale locks from dead processes are stolen automatically. `SCRIPTC_TEST_WORKERS=<n>` caps the vitest worker pool (default: unchanged, all cores).

## Build and oracle caches

### Development build benchmark

After rebuilding the workspace, `pnpm bench:builds` measures the built CLI on a generated 17-module, 256-function TypeScript program using `--optimization=dev`. It reports five builds with an empty scriptc cache, five exact rebuilds, and five rebuilds after changing an imported module. Every invocation uses a private cache and verifies each binary's stdout, stderr, and exit status against Node, outside the timed build. Temporary files are removed on completion. `pnpm bench:builds --iterations=3` changes the sample count; progress goes to stderr and the JSON result, including individual samples and medians, goes to stdout (use `pnpm --silent bench:builds` when capturing JSON).

`--workload=log-summary` exercises a five-module request-log processor; `--workload=inventory-report` exercises a fifteen-module inventory report with parsing, validation, filtering, aggregation, and ranking. Both process 10,000 records and change an imported value that appears in the output for each edit. `--compiler=/path/to/scriptc` measures an installed native compiler. Results also include executable size and median end-to-end run time, including startup and application work. `--memory` adds peak process RSS from `/usr/bin/time` on macOS and Linux; this is not the sum of concurrent processes' memory. `--launches=20` controls the measured runs after three warmups. Empty-cache builds clear scriptc's cache, not the operating system's file cache.

This is a local latency benchmark, not a timing assertion in CI. Compare the same Node version, target, compiler installation, and machine load; the empty-cache sample does not flush OS filesystem or Node bytecode caches. Unset `SCRIPTC_TARGET` because the benchmark executes the resulting host binary. Use representative application measurements alongside this small module-graph baseline when choosing further optimizations.

### Cache layers

The compiler caches frontend work, native program objects, and linked outputs. Tests place caches under `node_modules/.cache/scriptc-tests/cas` (gitignored; override with `SCRIPTC_CACHE_DIR`) instead of the per-user default. Cached programs still execute for every differential comparison.

- **frontend results** (`early-exe/` and `early-lib/`): exact repeats validate the frontend's complete file and resolution snapshot before restoring emitted LLVM, optional IR, and native feature selections. Source, configuration, package-resolution, target, and FFI changes invalidate the relevant result. Library comment-only edits can reuse lowered IR while regenerating source locations and identity metadata.
- **LLVM artifacts** (`native-codegen-v1/`): checksum-verified program objects and assembly are keyed by LLVM input, helper identity, target ABI, and optimization settings. Library identity getters compile separately, and dev libraries can reuse unchanged LLVM shards.
- **runtime packs**: ordinary builds select and verify installed precompiled objects and vendor archives. These are distribution artifacts, so compiling an application does not compile runtime C sources.
- **development toolchain caches** (`bin/`, `lib/`, `program-obj/`, `obj/`): explicit sanitizer and runtime development builds retain dependency-verified caches for external LLVM/C compilation, instrumented runtime objects, and native linking. Their compiler, header, archiver, and linker inputs participate in cache identities.
- **oracle results** (`oracle/`): deterministic Node outputs are keyed by program inputs, the spawned Node version, shim contents, and invocation shape. Timing-sensitive programs always run a live oracle.

Escape hatches: `SCRIPTC_NO_CACHE=1` bypasses every cache in both directions (no reads, no writes — the run behaves exactly like the uncached path). An explicitly empty `SCRIPTC_CACHE_DIR` does the same; a non-empty value overrides the production default. Eviction is a size-capped LRU sweep over each cache root (`SCRIPTC_CACHE_MAX_MB`, default 4096), run after the first write and periodically in long-lived processes; reads bump mtimes.

For the external development toolchain, environment variables that can resolve mutable compilation inputs (`CPATH`, `SDKROOT`, clang config directories, and their peers) conservatively bypass persistent artifacts and runtime objects. Compiler wrappers do the same because they can inject inputs conditionally on the real source/object topology; direct Clang, Apple's system Clang shim, and `zig cc` retain caching. The compiler must remain available so every invocation rediscovers dependency selection. Opaque archiver wrappers rebuild library program members and archives while retaining runtime-object reuse; trusted platform archivers and `zig ar` retain complete archive hits. Link-only search variables and explicit native link inputs bypass complete executables but retain safe runtime-object reuse.

`pnpm test:cache-identity` (optionally `--san`) is the acceptance artifact: it runs the full suite uncached, cache-populating, and cached, then diffs every test's name/status/failure output between the cached and uncached passes and exits nonzero on any drift.

`pnpm build` is incremental (tsbuildinfo under `node_modules/.cache/scriptc-tsc/`); `pnpm build:fresh` is the clean-build escape.

## Test262

The default static compiler has a pinned Test262 regression profile and a separate full-snapshot survey runner. See [tests/test262/README.md](../test262/README.md) for commands, outcome reporting, and the current strict-script and scalar-assertion limits. Both plain and sanitized Sandbox lanes run the regression profile.
