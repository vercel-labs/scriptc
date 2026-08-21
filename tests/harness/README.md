# Test harness

Two lanes over the same suite: plain (`pnpm test`) and sanitized (`SCRIPTC_SAN=1 pnpm test`, ASan + the runtime RC audit). Node is the oracle everywhere — corpus programs run under Node and as compiled binaries, and outputs must agree byte-for-byte. Both lanes must be green before a commit.

One deliberate exception to raw byte-compare: `node:test` programs (tests/harness/node-test.test.ts over tests/fixtures/node-test) cannot live in the corpus because Node's spec reporter embeds a real duration in EVERY result line — no node:test program has deterministic stdout, under Node itself included. Those fixtures still run both lanes against the Node oracle, but with one documented normalization applied to both sides (durations, stack frames, the inspect property block); everything else — symbols, indentation, directives, summary counts, the failing-section "test at" locations and error messages — must match byte-exactly, plus exit-code parity against the fixture's `// @exit:` line. Fixtures never console.log inside test bodies: Node's reporter stream lags console output racily, so mixed programs aren't byte-comparable against any oracle.

The LLVM backend rides the same two lanes through its own dual-backend differential (tests/harness/llvm-differential.test.ts): every corpus program is ATTEMPTED through `--backend=llvm`; programs the tier claims must be byte-identical through both backends AND against the Node oracle (stdout always, stderr for exit-0 programs, exit codes), and programs outside the tier must refuse with exactly one SC3001 diagnostic naming the first unsupported IR construct — never wrong code, never a silent fallback. Tier membership is auto-discovered (attempt + catch the refusal), the survey's six trivial-tier programs are pinned as a floor, and the run prints the claimed count plus the refusal histogram (the next phase's queue). Under `SCRIPTC_SAN=1` the emitted .ll's `sanitize_address` attribute opts the LLVM-emitted functions into ASan instrumentation too.

A third, env-gated lane runs the corpus AND the fixture sets with runtime legs (tests/fixtures/server, tests/fixtures/dgram, tests/fixtures/fetch) on LINUX: `SCRIPTC_LINUX=1 pnpm exec vitest run tests/harness/linux-differential.test.ts` cross-compiles every program via `zig cc` (`SCRIPTC_CC=zigcc`/`SCRIPTC_TARGET` in cc.ts) and byte-compares against a Linux Node oracle inside a Docker container — for the fixtures, both lanes, the per-case driver, and the fetch servers all run in-container. `SCRIPTC_LINUX_TARGET=<arch>-linux-gnu.2.36` runs the whole lane in Bookworm; `SCRIPTC_LINUX_TARGET=<arch>-linux-musl` runs it in Alpine. The container platform follows the triple (`linux/arm64` for AArch64, `linux/amd64` for x86_64; the latter uses Rosetta/qemu on Apple-silicon Docker). It skips entirely without the env var and is never part of the commit gate.

A fourth lane does the same on WINDOWS: `SCRIPTC_WIN=1 pnpm exec vitest run tests/harness/windows-differential.test.ts` cross-compiles for `x86_64-windows-gnu`, ships each .exe (plus the program source) to the Windows box over scp, runs BOTH sides there over ssh — the box's own Windows Node is the oracle — and byte-compares stdout/exit codes with nothing normalized. `SCRIPTC_WIN_FILTER=<regex>` narrows a run; the box alias is `windows-dev` (`SCRIPTC_WIN_HOST` overrides). Programs needing cross-gated features skip with the gate's reason, and the in-file `WINDOWS_SKIPS` list names what compiles but deliberately diverges on Windows (posix-shaped spawn programs whose /bin children are ENOENT on Windows Node too, uid/tty surfaces) — both lists are the port's worklist. Never part of the commit gate.

A fifth lane covers LIBRARY MODE across targets: `SCRIPTC_CROSS=1 pnpm exec vitest run tests/harness/library-cross.test.ts` cross-builds every K-fixture library profile (both emissions) for `aarch64-linux-gnu.2.36`, `x86_64-linux-gnu.2.36`, `aarch64-linux-musl`, `x86_64-linux-musl`, `x86_64-windows-gnu`, and `x86_64-macos`, then asserts per archive ON THE HOST: K1 symbol exactness (nm reads ELF/COFF/Mach-O alike), the K8 ambient audit, and that each fixture's probe LINKS against the target's libc — plus, on win32, the documented embedder system libs (advapi32/iphlpapi/ws2_32, cc.ts's unconditional executable set). With `SCRIPTC_LINUX=1`/`SCRIPTC_WIN=1` additionally set, the K2 scalar probe also EXECUTES per linux triple in its matching Docker distribution and on the Windows box; x86_64-macos is build-only by contract (the probe runs as a bonus when Rosetta is present). Needs zig on PATH; `SCRIPTC_CROSS_FILTER=<regex>` narrows the fixture list. Never part of the commit gate.

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
under the pinned Node plus both native backends. The default seed exercises
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
- `dynamic-only`: fenced from static builds with SC2020, accepted under
  `--dynamic`;
- `unsupported`: SC2020 in both tiers; this is implementation work rather than
  an implicit omission;
- `out-of-scope`: reflection metadata such as `Symbol.toStringTag`, retained so
  the scope boundary is machine-readable.

The selected adjacent interface families excluded from the census carry
reasons too. A Node upgrade that adds/removes a public member or dictionary key
fails the focused suite until that member is classified. The static,
dynamic-only, and unsupported rows project into the shipped surface manifest;
filter `NODE24_FETCH_COMPAT_PROFILE.inventory.entries` by `status`/`owner` for
the next cohesive implementation queue.

When Node changes, update `.node-version` and the profile's Node/Undici tuple
together, regenerate with `pnpm manifest`, then run the focused plain and
sanitized conformance lanes before the full sandbox gate. When the static fetch
surface changes, update the profile first; its evidence check makes the missing
fixture or generated scenario the implementation worklist.

Full-suite runs (`vitest run` with no filters) take an advisory machine-wide lock (a pidfile in the OS temp dir) so concurrent full suites — typically parallel agents — queue instead of oversubscribing the CPU, which is a known flake source (vitest worker RPC timeouts, event-loop timing failures). The lock is per flavor (plain vs `SCRIPTC_SAN=1`): the two lanes read the same committed tree through separate cache directories, so a merge gate may deliberately run one of each concurrently — split the cores between them with `SCRIPTC_TEST_WORKERS` (e.g. 5 and 5) or the oversubscription flakes come back. Two runs of the SAME flavor still queue. Filtered and watch runs never wait. `SCRIPTC_NO_LOCK=1` opts out; stale locks from dead processes are stolen automatically. `SCRIPTC_TEST_WORKERS=<n>` caps the vitest worker pool (default: unchanged, all cores).

## Build and oracle caches

Test runs are dominated by clang (~275 corpus programs × two lanes at -O2/-O1+ASan). The production content-addressed build cache and the harness's oracle cache make repeat runs fast. Tests pin them under `node_modules/.cache/scriptc-tests/cas` (gitignored; override with `SCRIPTC_CACHE_DIR`) instead of using the per-user default:

- **binaries** (`bin/`, cc.ts): key = resolved clang identity/version + target/compiler environment + implicit system-header dependency bytes + linker/assembler identities + runtime fingerprint (every runtime .c/.h + the vendor pin) + the full normalized command line + the emitted C bytes (byte-stable by project invariant). A hit skips native code generation and linking; the binary still RUNS live, so no comparison or sanitizer coverage is ever skipped. Each hit is checksum-verified. The sanitized lane's flags land in naturally distinct keys. FFI archive/object inputs and ambient system libraries always relink because their named files can hide mutable transitive dependencies.
- **library archives** (`lib/`, cc.ts): key = resolved clang and archiver identities/versions + target/compiler environment and implicit dependencies + runtime fingerprint + target/flags + gated runtime-source set + emitted program-TU bytes. A checksum-verified hit skips native code generation and `ar`.
- **library program objects** (`program-obj/`, cc.ts): generated library TUs compile into checksum-verified objects keyed independently of the tiny exact-source identity TU. A build-id-only miss reuses the large program object, compiles the identity getters, and rearchives; runtime/header/toolchain inputs remain part of the key and are rechecked before publication.
- **early executable frontend** (`early-exe/`, executable/early-cache.ts): exact executable repeats validate the frontend's complete file/resolution snapshot and native dependency proof before restoring the emitted C/LLVM unit, optional IR, and final executable without spawning TypeScript, lowering, or rediscovering clang/linker inputs. Source/config/package edits, newly appearing resolution candidates, mode/target/compiler/FFI changes, runtime/toolchain updates, and corrupt payloads miss; a valid frontend hit with an invalid native proof restores only the TU and falls through to compileC's strict native cache.
- **early executable frontend** (`early-exe/`, executable/early-cache.ts): exact executable repeats validate the frontend's complete file/resolution snapshot and native dependency proof before restoring the emitted C/LLVM unit, optional IR, and final executable without spawning TypeScript, lowering, or rediscovering clang/linker inputs. Source/config/package edits, newly appearing resolution candidates, mode/target/compiler/FFI changes, runtime/toolchain updates, and corrupt payloads miss; a valid frontend hit with an invalid native proof restores only the TU and falls through to compileC's strict native cache.
- **early library frontend** (`early-lib/`, library/early-cache.ts): exact library repeats validate content hashes for every file the TypeScript frontend read plus recorded failed-resolution and directory-enumeration probes, then restore the generated C/LLVM unit, optional IR, sidecar, and native feature gates without spawning TypeScript or lowering again. TypeScript comment-only misses may restore compressed lowered IR after token equivalence checks; source locations and exact-source sidecar/build identities regenerate from current bytes. Semantic comments/directives, JavaScript comments, token/config/package edits, and newly appearing resolution candidates miss. The native archive tier still performs its own toolchain/runtime checks.
- **runtime objects** (`obj/`, cc.ts): per-flavor .o for the runtime sources, including a distinct `-DSCR_LIB` flavor, so an edited executable or library recompiles only the program's own translation unit before linking or archiving. Each object carries a verified digest; a damaged entry is rebuilt before it reaches the linker or archiver. Publication rechecks the runtime and implicit-toolchain fingerprints after compilation so a concurrent source/header edit cannot place new bytes under an old key. Compiles route through ccache when installed, silently falling back when not.
- **oracle results** (`oracle/`, differential.test.ts): Node's stdout/exit per program, keyed by program bytes + the spawned node's version + shim contents + invocation shape. Only the spawn is skipped; the comparison never changes. Real-time programs (setTimeout/setInterval/Promise.race — 18 of 298) are excluded and always spawn Node live: their stdout is a timer interleave that Node and the native binary only agree on under the same instantaneous load, so a cached verdict from one run must never meet a live native run from another.

Escape hatches: `SCRIPTC_NO_CACHE=1` bypasses every cache in both directions (no reads, no writes — the run behaves exactly like the uncached path). An explicitly empty `SCRIPTC_CACHE_DIR` does the same; a non-empty value overrides the production default. Eviction is a size-capped LRU sweep over each cache root (`SCRIPTC_CACHE_MAX_MB`, default 4096), run after the first write and periodically in long-lived processes; reads bump mtimes.

Compiler environment variables that can resolve mutable compilation inputs (`CPATH`, `SDKROOT`, clang config directories, and their peers) conservatively bypass persistent artifacts and runtime objects. Compiler wrappers do the same because they can inject inputs conditionally on the real source/object topology; direct Clang, Apple's system Clang shim, and `zig cc` retain caching. The compiler must remain available so every invocation rediscovers dependency selection. Opaque archiver wrappers rebuild library program members and archives while retaining runtime-object reuse; trusted platform archivers and `zig ar` retain complete archive hits. Link-only search variables and explicit native link inputs bypass complete executables but retain safe runtime-object reuse.

`pnpm test:cache-identity` (optionally `--san`) is the acceptance artifact: it runs the full suite uncached, cache-populating, and cached, then diffs every test's name/status/failure output between the cached and uncached passes and exits nonzero on any drift.

`pnpm build` is incremental (tsbuildinfo under `node_modules/.cache/scriptc-tsc/`); `pnpm build:fresh` is the clean-build escape.
