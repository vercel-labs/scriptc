# Test harness

Two lanes over the same suite: plain (`pnpm test`) and sanitized (`SCRIPTC_SAN=1 pnpm test`, ASan + the runtime RC audit). Node is the oracle everywhere — corpus programs run under Node and as compiled binaries, and outputs must agree byte-for-byte. Both lanes must be green before a commit.

One deliberate exception to raw byte-compare: `node:test` programs (tests/harness/node-test.test.ts over tests/fixtures/node-test) cannot live in the corpus because Node's spec reporter embeds a real duration in EVERY result line — no node:test program has deterministic stdout, under Node itself included. Those fixtures still run both lanes against the Node oracle, but with one documented normalization applied to both sides (durations, stack frames, the inspect property block); everything else — symbols, indentation, directives, summary counts, the failing-section "test at" locations and error messages — must match byte-exactly, plus exit-code parity against the fixture's `// @exit:` line. Fixtures never console.log inside test bodies: Node's reporter stream lags console output racily, so mixed programs aren't byte-comparable against any oracle.

The LLVM backend rides the same two lanes through its own dual-backend differential (tests/harness/llvm-differential.test.ts): every corpus program is ATTEMPTED through `--backend=llvm`; programs the tier claims must be byte-identical through both backends AND against the Node oracle (stdout always, stderr for exit-0 programs, exit codes), and programs outside the tier must refuse with exactly one SC3001 diagnostic naming the first unsupported IR construct — never wrong code, never a silent fallback. Tier membership is auto-discovered (attempt + catch the refusal), the survey's six trivial-tier programs are pinned as a floor, and the run prints the claimed count plus the refusal histogram (the next phase's queue). Under `SCRIPTC_SAN=1` the emitted .ll's `sanitize_address` attribute opts the LLVM-emitted functions into ASan instrumentation too.

A third, env-gated lane runs the corpus AND the fixture sets with runtime legs (tests/fixtures/server, tests/fixtures/dgram, tests/fixtures/fetch) on LINUX: `SCRIPTC_LINUX=1 pnpm exec vitest run tests/harness/linux-differential.test.ts` cross-compiles every program via `zig cc` (`SCRIPTC_CC=zigcc`/`SCRIPTC_TARGET` in cc.ts) and byte-compares against a Linux Node oracle inside a Docker container — for the fixtures, both lanes, the per-case driver, and the fetch servers all run in-container. `SCRIPTC_LINUX_TARGET=x86_64-linux-gnu.2.36` runs the whole lane under linux/amd64 (the container platform follows the triple — Rosetta/qemu on Apple-silicon Docker). It skips entirely without the env var and is never part of the commit gate; workflow, scope, and the platform audit live in [docs/linux-port.md](../../docs/linux-port.md).

A fourth lane does the same on WINDOWS: `SCRIPTC_WIN=1 pnpm exec vitest run tests/harness/windows-differential.test.ts` cross-compiles for `x86_64-windows-gnu`, ships each .exe (plus the program source) to the Windows box over scp, runs BOTH sides there over ssh — the box's own Windows Node is the oracle — and byte-compares stdout/exit codes with nothing normalized. `SCRIPTC_WIN_FILTER=<regex>` narrows a run; the box alias is `windows-dev` (`SCRIPTC_WIN_HOST` overrides). Programs needing cross-gated features skip with the gate's reason, and the in-file `WINDOWS_SKIPS` list names what compiles but deliberately diverges on Windows (posix-shaped spawn programs whose /bin children are ENOENT on Windows Node too, uid/tty surfaces) — both lists are the port's worklist. Never part of the commit gate.

A fifth lane covers LIBRARY MODE across targets: `SCRIPTC_CROSS=1 pnpm exec vitest run tests/harness/library-cross.test.ts` cross-builds every K-fixture library profile (both emissions) for `aarch64-linux-gnu.2.36`, `x86_64-linux-gnu.2.36`, `x86_64-linux-musl`, `x86_64-windows-gnu`, and `x86_64-macos`, then asserts per archive ON THE HOST: K1 symbol exactness (nm reads ELF/COFF/Mach-O alike), the K8 ambient audit, and that each fixture's probe LINKS against the target's libc — plus, on win32, the documented embedder system libs (advapi32/iphlpapi/ws2_32, cc.ts's unconditional executable set). With `SCRIPTC_LINUX=1`/`SCRIPTC_WIN=1` additionally set, the K2 scalar probe also EXECUTES per linux triple in the docker container and on the Windows box; x86_64-macos is build-only by contract (the probe runs as a bonus when Rosetta is present). Needs zig on PATH; ~3min warm — which is why it is env-gated. `SCRIPTC_CROSS_FILTER=<regex>` narrows the fixture list. Never part of the commit gate.

## Workflow

Iterate filtered, gate full: while developing, run just what you're touching (`pnpm exec vitest run tests/harness/differential.test.ts -t <name>` or a single test file); run the full lanes (`pnpm test`, then `SCRIPTC_SAN=1 pnpm test`) as the gate before committing.

### Fetch compatibility profile

The engine-free fetch/Web Streams slice has one versioned source of truth in
`packages/compiler/src/compat/fetch-profile.ts`. It pins the exact Node and
bundled Undici oracle, drives the lowering allowlists, projects every supported
operation into `packages/compiler/surface-manifest.json`, and names the
differential evidence for each operation and `RequestInit` member. A new row
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

When Node changes, update `.node-version` and the profile's Node/Undici tuple
together, regenerate with `pnpm manifest`, then run the focused plain and
sanitized conformance lanes before the full sandbox gate. When the static fetch
surface changes, update the profile first; its evidence check makes the missing
fixture or generated scenario the implementation worklist.

Full-suite runs (`vitest run` with no filters) take an advisory machine-wide lock (a pidfile in the OS temp dir) so concurrent full suites — typically parallel agents — queue instead of oversubscribing the CPU, which is a known flake source (vitest worker RPC timeouts, event-loop timing failures). The lock is per flavor (plain vs `SCRIPTC_SAN=1`): the two lanes read the same committed tree through separate cache directories, so a merge gate may deliberately run one of each concurrently — split the cores between them with `SCRIPTC_TEST_WORKERS` (e.g. 5 and 5) or the oversubscription flakes come back. Two runs of the SAME flavor still queue. Filtered and watch runs never wait. `SCRIPTC_NO_LOCK=1` opts out; stale locks from dead processes are stolen automatically. `SCRIPTC_TEST_WORKERS=<n>` caps the vitest worker pool (default: unchanged, all cores).

## Build and oracle caches

Test runs are dominated by clang (~275 corpus programs × two lanes at -O2/-O1+ASan). Three content-addressed caches make repeat runs fast, all under `node_modules/.cache/scriptc-tests/cas` (gitignored; override with `SCRIPTC_CACHE_DIR`):

- **binaries** (`bin/`, cc.ts): key = clang version + runtime fingerprint (every runtime .c/.h + the vendor pin) + the full normalized command line + the emitted C bytes (byte-stable by project invariant). A hit skips clang entirely; the binary still RUNS live, so no comparison or sanitizer coverage is ever skipped. The sanitized lane's flags land in naturally distinct keys.
- **runtime objects** (`obj/`, cc.ts): per-flavor .o for the runtime sources, so a binary-cache miss compiles only the program's own C and links (~0.15s instead of ~1.4s). Compiles route through ccache when installed, silently fall back when not.
- **oracle results** (`oracle/`, differential.test.ts): Node's stdout/exit per program, keyed by program bytes + the spawned node's version + shim contents + invocation shape. Only the spawn is skipped; the comparison never changes. Real-time programs (setTimeout/setInterval/Promise.race — 18 of 298) are excluded and always spawn Node live: their stdout is a timer interleave that Node and the native binary only agree on under the same instantaneous load, so a cached verdict from one run must never meet a live native run from another.

Escape hatches: `SCRIPTC_NO_CACHE=1` bypasses every cache in both directions (no reads, no writes — the run behaves exactly like pre-cache main). Caching only activates when `SCRIPTC_CACHE_DIR` is set, which only vitest.config.ts does — production CLI builds are untouched. Eviction is a size-capped LRU sweep over the cache root (`SCRIPTC_CACHE_MAX_MB`, default 4096), run at most once per process after a write; reads bump mtimes.

`pnpm test:cache-identity` (optionally `--san`) is the acceptance artifact: it runs the full suite uncached, cache-populating, and cached, then diffs every test's name/status/failure output between the cached and uncached passes and exits nonzero on any drift.

`pnpm build` is incremental (tsbuildinfo under `node_modules/.cache/scriptc-tsc/`); `pnpm build:fresh` is the clean-build escape.
