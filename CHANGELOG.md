# Changelog

All notable changes to scriptc will be documented in this file.

## Unreleased

<!-- release:start -->

## 0.0.35

### Performance

- **Development builds reach native output sooner.** Exact executable cache hits route through the lightweight CLI before loading the compiler, while uncached dev builds use `-O0` and split large LLVM programs and libraries into stable, parallel, independently cached objects. npm installation also warms toolchain-specific runtime, TLS, and dynamic-engine artifacts for later builds.
- **The TypeScript frontend asks the checker for less work.** Lowering batches structure, reachable-body, call, receiver, and implicit-instance queries by phase, memoizes immutable type constituents, and avoids querying dead bodies or visibly non-object array candidates.

### Fixes

- **Unsupported `Array.from` element shapes refuse cleanly.** Mapper results that the backends cannot represent are diagnosed or deferred before emission instead of reaching a C emitter crash.
- **JSDoc record equality reads preserve dynamic property behavior.** Dot and bracket reads used by strict-equality and missing-key probes now route through checked-dynamic lookup, preserving absent properties and object identity.

<!-- release:end -->

## 0.0.34

### Performance

- **Library builds reuse more validated work.** Unchanged frontends, comment-only edits, lowered IR, and emitted C or LLVM translation units can be restored from the persistent cache while semantic, configuration, package-resolution, toolchain, and source-annotation changes still invalidate safely; volatile library identity is refreshed independently.
- **Reachable library code is lowered once.** Module assembly reuses retained lowering output without re-lowering function bodies, preserving reached-only artifact filtering, coverage remainder behavior, and output ordering while reducing repeated compiler work.
- **Same-shape record spreads emit smaller code.** Reusable clone helpers and outlined large-record copies reduce generated C and LLVM code while preserving ownership, integer proofs, and runtime behavior.

## 0.0.33

### Features

- **Foreign-thread native callbacks are marshalled to the event loop.** FFI format 5 adds `invoke: "foreign"` for retained, context-bearing, `void` callbacks. Thread-safe generated trampolines copy scalar/string/byte arguments into plain staging memory, wake the process loop, and return immediately; the loop delivers one callback per turn on the script thread with ref'd registration liveness, concurrent-producer FIFO safety, explicit release, throw propagation, and clean shutdown across both backends.
- **Native callbacks can be retained and explicitly released.** FFI format 4 adds `lifetime: "retained"` registrations and paired `release` descriptors that reuse the original function-pointer trampoline. Registrations pin captured closures until the same function value is released, count duplicate registrations, support multiple context-bearing registrations and raw single-slot replacement, defer callback throws through later FFI pump calls, and clean up live registrations at process exit across both backends.
- **Native callbacks copy in strings and byte spans.** FFI format 3 adds callback-only `cstring` parameters plus length-delimited `string` and `bytes` parameters. Trampolines in both backends copy native memory into owned scriptc values, decode malformed UTF-8 with U+FFFD replacement, preserve embedded NUL bytes in spans, and trap precise invalid null pointers before invoking the closure.
- **`Array.prototype.filter` accepts JavaScript-truthy predicate results.** Static predicates may return strings, numbers, references, or supported unions and now keep elements according to JavaScript's `ToBoolean` rules instead of requiring a boolean result. Checked-dynamic calls without a predicate reach the runtime's callback error, while predicates whose return value was erased to `void` refuse rather than silently producing the wrong array.

### Performance

- **Repeated builds avoid redundant compiler work.** Validated native-toolchain metadata and same-output artifacts persist across CLI processes with dependency and content checks that preserve cache invalidation; Node 24's bytecode cache reduces CLI startup work, frontend type lowering is memoized and checker prefetch avoids unused AST queries, and library profiles gain a fast `optimization: "dev"` posture plus `SCRIPTC_TIMING=1` phase diagnostics. The compiler CLI now requires Node 24 or newer.

## 0.0.32

### Features

- **Cross-compilation targets ARM64 Alpine Linux.** `SCRIPTC_TARGET=aarch64-linux-musl` produces statically linked executables and library archives through both backends, including async and generator fibers, runtime localization, multi-instance libraries, and the full portable differential contract. Cross-tool failures also retain the compiler's useful stderr or stdout diagnostics instead of losing the underlying error.

### Fixes

- **Windows TLS trusts the native system certificate stores.** TLS and HTTPS clients now load, policy-filter, and deduplicate server-auth roots and intermediates from the applicable user and machine stores; `tls.getCACertificates("system")` exposes the same live trust source.
- **Library integer proofs preserve JavaScript's NaN comparison behavior.** Failed ordered comparisons no longer narrow a value when either operand may be NaN, preventing an unsafe integer-boundary proof, while the false edge of `!==` correctly proves equality and clears the NaN alternative.

## 0.0.31

### Fixes

- **`Array.isArray` recognizes fixed tuples.** Readonly tuple arms now retain JavaScript array identity and their runtime-tag narrowing through `Array.isArray`, so Native SDK-style values such as `Model | readonly [Model, Command]` compile and preserve tuple indexing, `.length`, `slice`, and `map` behavior.

## 0.0.30

### Features

- **Library archives call back into their host.** A profile's `callbacks` array declares named channels over the marshalling classes (bytes, string, f64, bool, and the u8/u32/i32 plumbing classes; scalar returns), and `abi.callback_register_symbol` names the registration entry point: the host supplies a function pointer and an opaque context per channel, and compiled code reaches a channel as a signature-only ambient function whose direct calls deliver synchronously on the calling thread, buffers borrowed for the duration of the call. Registrations are per instance, matching the panic sink under `abi.localize_runtime` and `abi.instance_per_thread`. Calling an unregistered channel is a structured `SC4025` trap through the sink naming the channel and the entry; a call the profile's channels cannot serve refuses at compile time with `SC4024`. Profiles without a `callbacks` section produce unchanged output.

## 0.0.29

### Features

- **Library archives build for iOS and Android.** `SCRIPTC_TARGET=aarch64-apple-ios`, `aarch64-apple-ios-simulator`, and `aarch64-linux-android` produce library-mode static archives for an embedding app to link — Xcode projects on the Apple side, Gradle/NDK builds on the Android side. iOS archives compile against the selected Xcode SDK with an iOS 15.0 minimum (stamped into every object's `LC_BUILD_VERSION`) and localize with the macOS host linker; Android archives compile against the NDK's bionic headers at API level 26 and use the same in-process ELF localization as the Linux cross targets. Multi-instance (`abi.localize_runtime`) and thread-instanced (`abi.instance_per_thread`) profiles carry over unchanged, verified by simulator- and emulator-executed probes; standalone executable builds refuse these targets with a pointer to `--lib`.

## 0.0.28

### Features

- **Runtime-localized library archives build for Windows and cross targets.** `abi.localize_runtime` now follows the target object format: COFF localization runs in process for native and cross Windows builds, ELF cross builds use Zig plus in-process symbol demotion, and macOS cross builds work from Darwin hosts. The existing independent-instance and per-thread composition contracts now carry across the supported Windows and Linux targets; unsupported host-target pairings still refuse before emission.

## 0.0.27

### Features

- **Library archives support independent instances in one process.** `abi.localize_runtime` combines an archive's reached program, runtime, and vendor objects and hides every definition except its profile-declared ABI, so archives with distinct symbol prefixes link together without collisions or shared mutable runtime state. Each instance owns its allocator, collector, result arena, and panic sink, and a trap poisons only the instance that raised it. Localization is available for host-native Darwin and Linux builds and refuses cross-target builds before emission.
- **One library archive can serve an independent instance per embedder thread.** `abi.instance_per_thread` moves mutable program and runtime state into thread-local storage while keeping immutable interned data shared, preserving the existing entry family with the calling thread as the instance selector. Each thread initializes and owns its instance for its lifetime, including its collector, result arena, panic sink, and poison state. Thread instancing composes with runtime localization, remains opt-in, and leaves classic archives byte-for-byte unchanged.

## 0.0.26

### Features

- **WebAssembly is a production target.** `SCRIPTC_TARGET=wasm32-wasi` emits a standalone WASI Preview 1 module through the LLVM backend, and `scriptc run` hosts it with inherited stdio and environment plus preopened working and temporary directories. The full portable language tier includes checked dynamic values, async/await, promises, generators, timers, filesystem work, and `--dynamic`; APIs whose capabilities WASI does not provide refuse before linking with a targeted diagnostic instead of producing a broken module.
- **Cross-compilation targets Alpine Linux directly.** `SCRIPTC_TARGET=x86_64-linux-musl` produces a statically linked executable with Zig, backed by musl-specific runtime shims for randomness, fibers, and child-process working directories. Executables and library archives are validated against Alpine alongside the existing glibc targets.
- **Native FFI accepts C function-pointer callbacks.** Format 2 describes callback pointers and opaque contexts as independently positioned ABI entries, adapts ordinary capturing TypeScript closures through both backends, and preserves scalar C conversion and catchable callback throws. Raw callbacks without userdata use a binding-specific same-thread trampoline. The initial lifetime policy is explicit and bounded: callbacks are valid only during the native call; retained and foreign-thread callbacks remain rejected by contract.
- **HTTP and HTTPS servers expose Node's timeout configuration statically.** `timeout`, `keepAliveTimeout`, `keepAliveTimeoutBuffer`, `headersTimeout`, and `requestTimeout` retain Node's defaults and independent per-server storage through typed and dynamic reads and writes. The HTTP and HTTPS constructors also accept and validate `keepAliveTimeoutBuffer`; this surface configures the values, while deadline enforcement remains a separate server behavior.

## 0.0.25

### Fixes

- **Busy sockets no longer starve the native event loop.** Readable wakes now yield after a bounded batch, allowing timers and other descriptors to keep progressing even while upgraded connections are continuously flooded.

## 0.0.24

### Features

- **Everyday filesystem work stays static across more of the file lifecycle.** `fs.rename`, `fs.renameSync`, and `fs/promises.rename` lower with Node's callback, promise, replacement, and platform error behavior; `fs.writeSync` covers the Buffer-window and UTF-8 string overloads with current-offset and positioned writes; and `fs/promises.open` returns a native `FileHandle` with `fd`, `read`, `write`, `readFile`, `writeFile`, `appendFile`, `stat`, and idempotent `close`. The three-argument `fs/promises.writeFile` accepts the supported UTF-8 and creation-mode options, while filesystem stats expose `blocks`, `nlink`, and `atimeMs` through path, promise, file-handle, and dynamic-bridge results.
- **Native text decoding covers the WHATWG encoding families.** A statically labelled `TextDecoder` recognizes the standard aliases for the legacy single-byte, UTF-16, Chinese, Japanese, and Korean encodings, including BOM handling and malformed-input recovery matching the pinned Node runtime. Runtime-valued `BufferEncoding` arguments also work in `Buffer.toString`, with case-insensitive aliases, optional defaults, range behavior, and Node's unknown-encoding errors.
- **`util.parseArgs` compiles statically.** Boolean and string options, short and clustered spellings, repeated values, defaults, negative options, positionals, token output, permissive parsing, the live default `process.argv`, and Node's coded validation errors lower through both backends.
- **Array mutation and bounded string splitting grow their static surface.** `Array.prototype.unshift` and `reverse` preserve mutation, spread, evaluation order, and reference identity, while `String.prototype.split` accepts JavaScript limits for string and literal-RegExp separators with `ToUint32` semantics.
- **`process.stdout.write` and `process.stderr.write` accept encoding and completion arguments.** String chunks honor supported encoding aliases, byte chunks retain their bytes, and successful completion callbacks join the next-tick queue in Node's order on both backends.

### Performance

- **Canonical typed-array loops use native integer induction.** Both backends recognize semantics-safe byte loops and emit integer counters and direct byte indexes, avoiding repeated floating-point index conversion while preserving the general fallback whenever the loop shape cannot prove the rewrite.

## 0.0.23

### Features

- **Read-only `Date` values compile statically.** Zero-argument and single-value construction, storage and passing, `getTime`/`valueOf`, `toISOString`, UTC and host-local calendar getters, and `getTimezoneOffset` lower through both backends. Construction applies ECMAScript TimeClip behavior, the supported ISO and certificate-date strings parse without an embedded engine, and valid extreme years retain calendar answers even beyond a platform CRT's native range.
- **The native web surface grows response construction and fetch cancellation.** `new Response(body, init)` covers the supported `BodyInit`, `ResponseInit`, header mutation, conversion, validation, and stream-error semantics, while `AbortController` supplies shared native signal state, abort events and reasons, and preflight or in-flight `fetch` cancellation across the static and dynamic tiers.
- **`fs.readSync` accepts positioned reads.** A numeric position reads without advancing the descriptor, while omitted, `null`, and `-1` positions preserve current-offset behavior; validation order, zero-length reads, EOF, and partial Windows reads match Node.

### Fixes

- **Top-level `await` marks an implicit ES module.** TypeScript and JavaScript files without an explicit import or export now follow Node 24's syntax detection, package-type precedence, module scoping, and `require` diagnostics instead of being misclassified as CommonJS.
- **Cycle collection stays fast on large live heaps.** The runtime now collects cycles generationally, promotes survivors, and schedules bounded mature passes, avoiding repeated whole-heap walks while retaining full sweeps for cross-generation garbage and shutdown auditing.
- **Typed-array reads, writes, and lengths use specialized native lowering.** Both backends emit operations directly from the IR element kind while preserving numeric coercion, bounds behavior, and receiver lifetime across side-effecting index and value expressions.

## 0.0.22

### Features

- **Coverage can analyze projects with embedder-provided module surfaces.** Repeatable `--external-types <specifier=file.d.ts>` mappings give the checker a local declaration for an otherwise unresolvable bare specifier, so project-owned statements remain measurable. The mapping is coverage-only and never invents execution semantics: value imports and uses stay explicit SC1010 external-host blockers, while type-only structural use can remain fully static.
- **Production and library builds persist compilation work.** A bounded content-addressed cache is enabled by default: unchanged executables and library archives skip native code generation/linking, while source edits reuse separately keyed runtime objects (including library mode's `-DSCR_LIB` flavor) and rebuild only the program translation unit. Identities include resolved system-header dependency bytes plus linker/assembler identities, and checksums protect complete artifacts as well as runtime objects. The compiler remains required so every cache-enabled invocation rediscovers dependency selection; metadata-probe failures fall back to an ordinary build, and the configured size cap is enforced after writes. FFI builds with archive/object inputs or ambient `system_libraries` deliberately relink on every invocation so a transitive or in-place native rebuild cannot return stale code; their runtime objects remain cached. Mutable compiler input paths such as `CPATH` and `SDKROOT`, and opaque compiler wrappers, conservatively bypass persistent artifacts and objects; opaque archiver wrappers rebuild library program members and archives while retaining runtime-object reuse. Direct Clang, Apple's system Clang shim, `zig cc`, trusted platform archivers, and `zig ar` retain their applicable persistent tiers. Complete binary hits are checked before any missing vendor prerequisite is rebuilt. Library graphs with no npm package to opt in also retain the auto-detection frontend instead of loading the same graph twice. `SCRIPTC_CACHE_DIR` overrides the platform cache root, and `SCRIPTC_NO_CACHE=1` preserves a fully uncached path.

## 0.0.21

### Fixes

- **Contract integer attestations cover synthesized tagged-record payloads.** Integer slots declared on lowered payload paths such as `TextInputEvent_set_composition.cursor` and `Msg_audio_event.at` now carry compile-time write obligations, so fractional writes refuse instead of surviving until runtime encoding. Distinct inline records whose underscore-joined synthesized names collide now refuse instead of reusing the wrong table entry and dropping an obligation.
- Same-shaped contract integer slots with the same declared class now share one lowered proof obligation while retaining every source slot path in refusals. Differing-class collisions remain SC4009 until arm provenance can keep their assumptions distinct.

## 0.0.20

### Features

- **Contract sidecars accept TypeScript's read-only and named scalar vocabulary.** `readonly T[]` and `ReadonlyArray<T>` project as the same mutability-neutral slice as `T[]`, while aliases of `number`, `string`, `boolean`, and `Uint8Array` dissolve recursively to their primitive wire types across models, messages, helpers, and integer slots without adding phantom type-table entries.

### Fixes

- A local declaration, import, or type parameter named `Array`, `ReadonlyArray`, or `Uint8Array` remains the user's type instead of being mistaken for the same-spelled global and publishing the wrong slice or bytes contract.

## 0.0.19

### Fixes

- **Library integer slots compose with optional numbers.** A declared `number | null` or optional-number slot projects as `optional<i64>` and proves only its present numeric values across records, tagged-message payloads, and helper parameters/returns. When two sidecar paths collapse to the same structurally interned record field, the build now refuses with both paths instead of silently overwriting one proof obligation.

## 0.0.18

### Features

- **Top-level `await` compiles across the program's ESM graph.** Module evaluation follows Node 24's dependency ordering, one-time promise caching, cycle rooting, rejection precedence, and unsettled-module exit status 13 in both the LLVM and C backends. Dynamic imports of compiled modules await the same evaluation verdict.

### Fixes

- **`https.request(options, responseCallback)` compiles on the LLVM backend.** The options-object row now lowers the TLS verification and CA arguments through the same runtime ABI as the C backend, including response-callback ownership and event-loop liveness. The already-supported `http.request(options, responseCallback)` row is pinned alongside it.

## 0.0.17

### Fixes

- **The CLI builds and runs programs on Windows.** TypeScript's virtual filesystem now sees consistently slash-normalized Windows paths, default executable names carry the required `.exe` suffix for both native and cross-target Windows builds, and the workspace build command survives Windows shell quoting. A Windows CI lane pins the path regressions and drives `scriptc run` end to end.

## 0.0.16

### Fixes

- **Console output is visible promptly.** `console.log`, `process.stdout.write`, readline prompts, and writes from dynamic islands now submit their bytes before returning instead of retaining piped stdout until a later flush or normal exit. Live consumers see output as it happens, and output written immediately before `SIGKILL` matches Node instead of disappearing.
- **Native Linux builds link with host clang.** Linux host builds now expose the glibc declarations the runtime uses and place `libm` after every link input, fixing compile failures from missing declarations and link failures from GNU ld's left-to-right archive resolution. A native Ubuntu clang lane pins the complete static build.

## 0.0.15

### Features

- **Outbound native FFI.** `scriptc build --ffi <manifest>` binds exact signature-only TypeScript declarations to C ABI symbols and links the manifest's archives, objects, and system libraries into the executable — no runtime symbol lookup and no dynamic engine at the boundary. The strict versioned manifest covers numeric, boolean, UTF-8 string, and byte-span parameters plus scalar and void returns; both backends lower the calls, and `scriptc coverage` recognizes the same bindings.

### Fixes

- FFI profiles validate every configured binding before emit, including unused and shadowed declarations, and reject uninhabited `never` slots instead of letting TypeScript's control-flow assumptions disagree with a returning native function. A same-named local function remains ordinary TypeScript, while missing symbols and other native link failures surface as bounded SC5004 diagnostics rather than internal compiler errors.

## 0.0.14

### Fixes

- **Clients resolve hostnames.** The http, https, TLS and HTTP/2 clients resolved nothing before dialing, so a request to any name came back ENOTFOUND and only literal addresses worked. Only the dial takes the resolved address — the original name stays on the request, which is what the Host header carries and what SNI and certificate verification see. `net.connect(port, hostname)` still refuses to resolve: Node's async lookup semantics on that surface are their own piece of work.
- **The URL-string form of the http and https clients compiles**, along with the URL-object form, which reads as its href through the same parse. The declarations only described the options record, so `http.get("http://host/path")` — the first thing a client written from scratch reaches for — was a type error rather than a request. An unparsable input is the WHATWG `Invalid URL` TypeError and a scheme that is not the calling module's is `ERR_INVALID_PROTOCOL`, both catchable, both matching Node instead of silently upgrading the dial. Both rows run on the LLVM backend, as do the TLS CA-store entries, which moves the CA-store corpus off the C lane with identical output.
- **`scriptc -v` prints the version** instead of crashing on an attempt to read `-v` as an entry file, and an unknown flag or a missing flag value prints one line naming what was wrong followed by usage, in place of a Node stack trace.

## 0.0.13

### Features

- **Dyn values run the engine's own operations**: a value held in `unknown` that came from the embedded engine now answers keyed reads and writes, calls and method dispatch, the `Object` statics, and `??` by running them in the engine — so it answers exactly what Node answers instead of meeting a fence. Scalars normalize at the wrap, composites stay engine values by reference, and a value that crosses into the checked-dynamic tree and back is the same value it was.
- **`http.Agent` and `https.Agent` compile**, with real connection accounting: literal option parsing, `getName`, `destroy`, the `sockets`/`requests`/`freeSockets` snapshots, a settable `defaultPort`, and `maxSockets` that actually holds — over-limit requests defer their dial and queue. The request path threads the agent on both emissions. `keepAlive: true` refuses with the pooling fence named.
- **The HTTP and socket compatibility surface widens**: `flushHeaders`, `getHeaders`, `setTimeout`, `cork`/`uncork` with a real `writableCorked` counter and coalescing flush, `writeHead`'s raw-array form, `write`/`end` encodings and deferred callbacks, `pause`/`resume` with buffered drain, `destroySoon`, `end(cb)`, `setNoDelay`, and the `destroyed`/`readable`/`bytesWritten`/`res.req` reads — on both the typed lane and dyn receivers. Strict equality over runtime handles is pointer identity, as it is in JS.
- **Crypto introspection, the TLS CA store, and the http2 tail**: `getFips` and the cipher/hash/curve name lists bake at the call site; `getCACertificates`/`rootCertificates`/`setDefaultCACertificates` land in their own unit behind their own link gate, so a binary that only reads the trust anchors never pulls mbedTLS; `http2.createSecureServer` grows the eager request handler and the runtime options record; `process.on`/`off` cover `unhandledRejection` and `rejectionHandled`.
- **Library archives are verified across targets** (`SCRIPTC_CROSS=1`): every library profile cross-builds for aarch64-linux, x86_64-linux, x86_64-windows, and x86_64-macos on both emissions, and each archive is checked for symbol exactness, the ambient audit in both spellings, and probe linkability against the target's libc.

### Fixes

- `process.env.PORT || 3000` compiled and then threw at runtime. tsc builds a logical operator's result by dropping the left's falsy arms, so coercing the left into that result before the truthiness test retagged an arm the test was about to rule out; `||` now tests the left in its own type and retags only on the truthy branch, where those arms are gone. The left still evaluates exactly once and the right stays lazy.
- Windows library archives carried undefined references no embedder link could resolve — the win32 libc shim unit now joins the archive for windows triples. Host archives are unchanged byte-for-byte.
- Bytes written to a socket whose dial had not started — the agent's `maxSockets` queue, or a caller lookup still in flight — were silently dropped, hanging the exchange. They buffer and flush at establishment.
- The CA-store surfaces demote the determinism attestation and can now be denied by a profile: three rows, one per Node spelling, since denying a read of the trust anchors is a different decision from denying their replacement.

## 0.0.12

### Features

- **Engine-held values iterate**: `for-of`, destructuring, and spread over values born in the embedded engine ride the engine's own iterator protocol with V8's exact error spellings, and `for-of` over any dynamic value lowers generally. Compiled promises cross into the engine as thenables; `Promise.all` over mixed compiled-and-engine entries runs the engine's own combinator, and engine-array fulfillments settle by reference.
- **Bare `module` resolves the builtin** exactly like `node:module` — the builtin wins over any same-named installed package, matching Node.

### Fixes

- `stream.pipeline` argument validation throws Node's synchronous `ERR_INVALID_ARG_TYPE` for provably-invalid stages in every position instead of crashing the compiler on an internal marker; accepted-but-uncompiled sources refuse naming what Node accepts.
- Integer-slot attestations record `u64` as `u64` (the wire-format flattening now applies only where the frozen schema requires it), and declared model-field classes obligate every write — init, update arms, helpers — to the same prove-or-refuse check as export slots.
- The 0.0.11 restore's written-binding decline was wider than its rationale, and two carve-outs bring the lost shapes back: a written binding whose declared type has no static mapping keeps the compiling no-storage trap claim, and a statement-position assignment whose right side provably throws before the write no longer counts against the claim.
- A class extending a base the compiler itself rejected now fails the build eagerly with the base's real blocker — the deferred fence compiled a binary that refused at startup where Node runs on. Leaf rejected classes keep the runtime-deferral story.
- A stale remnant of the island-literal fence answered `typeof` and `.length` wrongly for poisoned members; reads now fail with the captured diagnostic.

## 0.0.11


### Features

- **Profiles declare integer boundary slots**: library exports may class parameters and returns `i64`/`u64`, and the compiler proves integrality and range for every value that can reach them — or refuses with the slot path, the failed obligation with evidence, and the concrete fix. Proven returns cross as exact machine integers; a bounded counter loop proves its exact range; `x | 0` is a proof by the ToInt32 contract. Semantics stay f64 everywhere inside the program.
- **Library fences cover the whole ambient surface**: the Date, performance, and process families join the surface manifest as fenceable ids, so a profile can deny every surface the determinism attestation knows — full fences now imply a deterministic attestation by construction. The attestation itself tightened: six live ambient reads it previously missed now demote it. Profile roots refuse unknown keys.
- **Subclasses override `emit`**: the wrap-and-forward pattern (`emit(event, ...args)` delegating to `super.emit`) compiles with Node's dispatch, error-event, and super-chain semantics, monomorphized per event.
- **Stream timing matches Node's tick order**: stream emissions interleave with `process.nextTick` in enqueue order — Node's order — instead of draining after user ticks; stream emitters model the event-key shape that governs `eventNames()` order; `push(string)` honors `defaultEncoding` with Node's unknown-encoding errors.
- **`node:stream/consumers` compiles statically** (`text`/`json`/`buffer` with Node's settle timing and rejection set), and **`createRequire` erases at compile time** — builtin specs become static imports, relative JSON bakes as the validated document, npm packages resolve their CJS arms under `--dynamic`, and unresolvable names throw Node's catchable `MODULE_NOT_FOUND`.

### Fixes

- The two 0.0.10 crash classes are fixed and its seven behavior regressions restored: collect-phase probes recover from rejected constructs instead of crashing, and the no-storage binding families claim statement declarators only.
- `Buffer.slice`/`subarray` and `TypedArray.subarray` are true aliasing views — mutating through a view silently computed wrong bytes before.
- Math.trunc and Math.ceil compile statically.


## 0.0.10

### Features

- **Engine-held values flow through dynamic code**: values born in the embedded engine now cross into `unknown`/`object`-typed slots and back — `typeof`, strict equality, `String()`, keyed reads and writes, calls, and method dispatch route through the engine (its own prototypes run, JS-exact), with reference-preserving identity on the round trip. Unions like `string | object` compile wholesale into the checked-dynamic representation, and nullish coalescing and optional chains work on every dynamic value. Operations not yet routed fail loudly by name — the boundary's silent wrong answers (`typeof` misreporting, phantom `.length`) are gone.
- **`Object.create(null)`, array `entries()`/`keys()`, and variadic `Object.assign`**: real null-prototype dictionaries with Node's inspect/`toString`/comparison behavior (the dynamic tier delegates to the engine's own `Object.create` for live prototypes); live index-walking pair iterators; `Object.assign(target, ...sources)` with JavaScript's exact evaluation order and V8's position-dependent error texts.
- **Erased ambient declarations behave like Node**: chains rooted in `declare`d values compile and throw the catchable `ReferenceError` Node produces at first touch; never-read unmappable bindings vanish; nullish-cast bindings answer Node's exact `TypeError` on member access; assertion-shaped generic signatures monomorphize per call.
- **Misuse of fs, net, dgram, tls, and stream APIs throws Node's validation ladders**: argument checks run in Node's order with `ERR_*` codes and message-exact texts; `fs.exists` is genuinely async (including its no-error-argument wart), and `mkdtempSync` and `lchmod` are real.
- **Keyed writes land on dynamic receivers** (`bag[key] = value` on objects built up dynamically, with `ToPropertyKey`-exact key handling), and array destructuring walks dynamic sources with V8's exact non-iterable error wordings.
- **Library mode: profiles deny surfaces by manifest id** — a `fences` array refuses fenced surfaces reached by the compiled graph, with the profile's guidance attached as a visibly-attributed note; teachings generalize to any refusal; fence evaluation reads the same dead-stripped graph as the determinism attestation, so full fences imply a deterministic attestation by construction.

### Fixes

- Mixed engine-vs-native `deepStrictEqual` comparisons fence loudly instead of fabricating a failure result.
- The LLVM code generator marshals dynamic values in `jsMarshal` positions identically to the C backend (a latent gap).
- Concurrent plain and sanitized test-suite runs no longer race each other's scratch directories (a test-infrastructure fix).


## 0.0.9

### Features

- **API misuse throws Node's exact errors**: argument-validation ladders on Buffer (`compare`/`equals`/constructors), URLSearchParams (WHATWG brand checks, arity, ToPrimitive coercion running user `toString`/`valueOf`), the max-listeners family, and range checks across bytes/fs — `ERR_INVALID_ARG_TYPE`, `ERR_OUT_OF_RANGE`, and `ERR_MISSING_ARGS` with Node's message texts, catchable and assertable.
- **Strings destructure**: array patterns over strings split by code point (positions, holes, defaults, rest, nesting, for-of heads); destructured built-in globals (`const { subtle } = globalThis.crypto`) bind with Node-agreeing identity.
- **Spread arguments land anywhere**: `f(...args)` outside typed rest slots builds the argument list with JavaScript's exact evaluation order on both backends, including under `--dynamic`, with V8's spread-TypeError texts for non-iterable sources.
- **Record shapes widen further**: hybrid declared-plus-index-signature records width-coerce in both directions; index signatures carry function, Map, and Set values (the command-registry pattern); per-field lifts cover `unknown` destinations, upcasts, and function adapters.
- **DataView setters, `Object.is`, and an exact Intl slice**: the full DataView setter family; fresh ArrayBuffers erase into zero-filled views; `Object.is` with the spec's SameValue; `new Intl.NumberFormat("en-US").format()` and `toLocaleString("en-US")` print byte-identically to Node without linking ICU.
- **`stream/promises` compiles statically**, and out-of-scope modules (`v8`, `domain`, `node:sqlite`, Node's underscore-internals) refuse with reasons instead of a generic unsupported-module message.
- **Bundler interop**: esbuild's `__toESM(require(...))` external-dependency wrapper compiles statically under `--npm-static`, with build-time `.default` semantics matching Node's interop rules; unrecognizable variants degrade to the embedded engine with the construct named.
- **Library mode**: runtime-detected traps deliver the structured teaching encoding unconditionally (code, trapping symbol, optional profile remediation); bare npm specifiers compile statically when eligible or refuse with the failed bar named.

### Fixes

- The C code generator compiles with strict aliasing disabled: the refcounted object header is accessed through base- and derived-typed views by design, and optimizer type-based alias analysis could elide refcount updates, freeing objects still in use. The LLVM lane was unaffected.
- `Promise.reject` with an untyped reason no longer crashes the LLVM code generator; rest-parameter arrows forwarding their rest via spread no longer trip an internal error.
- Two readable-stream lifecycle bugs: the `emittedReadable` flag now clears at Node's moment, and absent-size reads clear pending state correctly.
- String-typed `'data'` listeners (the `setEncoding` shape) received raw byte headers as string content on sockets, http requests, and http2 streams; they now decode UTF-8 correctly.


## 0.0.8

### Features

- **Destructuring completes its static surface**: nested patterns and property/element targets in assignment position (`[c.x, c.y] = arr`, `({ a: rec.f } = o)`) with JavaScript's exact evaluation order, destructuring from class instances (getters called once per element), rest over class instances packing the inheritance chain in Node's key order, and defaults on destructured accessor results.
- **The monomorphization frontier widens**: `keyof`-constrained generics specialize per literal key (`pick<T, K extends keyof T>` and keyed writes), generic methods called through interface-typed receivers compile against the proven class, and generic-signature annotations, aliases of generic functions, and generic arrow initializers all monomorphize per pinned signature.
- **`#private` statics resolve through class values**: `X.#m()` calls, const-bound class expressions with static initializers, decorated class names, and aliases of the class all reach static private members when the receiver provably holds the declaring class.
- **Named type-shape diagnostics**: the former catch-all "unsupported type" diagnostic splits into SC2005 (generic call signatures), SC2006 (index-signature shapes), SC2007 (overloaded function types), SC2008 (unresolved intersections), and SC2009 (a supported shape whose named component is the blocker — the message points at the exact offending piece).
- **Library builds speak the structured trap encoding**: trap messages carry a diagnostic code, the trapping export's symbol, and optional profile-supplied remediation inside the frozen sink signature, degrading gracefully to plain text; contract sidecars refuse order-ambiguous type declarations (multi-site merging, conditional/mapped types) with teachings naming every site, and spread-composed unions pin depth-first declaration order.
- **Broader dynamic-tier interop**: `Object.hasOwn`/`Object.assign` on records and engine values, runtime-keyed writes to fixed shapes, regex union arms with `instanceof RegExp` narrowing, tagged templates receiving a real `TemplateStringsArray`, getters and spreads in island object literals, and JavaScript variadics binding the engine's arguments array.

### Fixes

- Arrays that grow from an empty `any[]` no longer break compilation under `--dynamic` when they flow into typed array methods (`map`/`filter`/`forEach` and family).
- A latent double-getter-call in destructuring defaults over accessor results is fixed.


## 0.0.7

### Features

- **Library builds emit a contract sidecar**: a profile that declares a sidecar path gets a deterministic `*.contract.json` beside the archive — exported symbols with marshalled signatures, record/union type tables in declaration order, and a 64-bit build id that is also readable from the archive itself through synthesized constant getters (safe to call before init and after a trap). Two builds of the same tree produce byte-identical sidecars, so embedder tooling can diff contracts mechanically.

### Fixes

- Comparing a union value against `null` or `undefined` when the union has no such arm now answers the constant the type system already knows (`false` for `===`, `true` for `!==`) instead of trapping at runtime; `switch` cases on absent unit arms fold the same way. The scrutinee is still evaluated exactly once.
- Programs using `net` auto-select-family timeouts no longer fail at link on the default backend: the code generator's symbol table spelled two runtime symbols differently than the runtime defines them. The ABI audit now verifies every runtime symbol the code generator can emit against the runtime header, so this class of skew fails in CI rather than at a user's link step.

## 0.0.6

### Features

- **Recursive types compile statically**: self-referential interfaces (`interface TreeNode { label: string; children: TreeNode[] }`), mutually recursive types, and recursive unions — the AST/tree/linked-list class — now map to native representations. Cyclic values are collected by the cycle collector; `JSON.stringify` on a cyclic value throws V8's exact circular-structure error; `console.log` prints Node's circular reference markers; `JSON.parse(x) as T` validates recursive shapes with path-exact failures.

## 0.0.5


### Features

- **Library mode**: `scriptc build --lib --profile <profile.json>` compiles a TypeScript module set into a linkable static archive exporting profile-declared C symbols — marshalled scalar/string/bytes signatures, a re-runnable init entry, panic-to-sink routing instead of aborts, and a cycle-collection entry. The emitted archive links against nothing but libSystem, creates no threads, and installs no signal handlers; conformance fixtures drive both code generators from a real C host.
- **Bundler-emitted CommonJS packages work with `--npm-static`**: getter-table and star re-export plumbing now types its named exports from the same name set Node's lexer sees, and a package whose shipped code still breaks the typecheck falls back to the embedded engine with a note naming why — never a failed build.

### Fixes

- Two compile-time crashes on unusual shipped-JavaScript shapes (probe reads that mutated locals, captures through non-lifted functions) now compile or fence with a named diagnostic.

## 0.0.4


### Features

- **`console.log` prints every inspectable shape**: arrays, records, Maps/Sets, class instances, `undefined`/`null`, Buffers, and unions — each non-scalar argument renders through the same machinery as `util.inspect`, matching Node's console semantics exactly (string union arms print raw, format-string first arguments keep `util.format` behavior).
- **The `#private` members chain**: private fields, instance and static methods, accessors, generator methods, and `#x in obj` brand checks all compile, with Node's lexical binding and brand semantics.
- **`node:querystring` compiles statically**: the full legacy surface (`parse`, `stringify`, `escape`, `unescape`) with Node's exact separator, `maxKeys`, and malformed-escape behavior.
- **Command-table and generic-member patterns**: `as const` option tables with `String`/`Number`/`Boolean` constructor values, generic arrow instance fields, async generic methods and statics, and definite-assignment (`field!`) declarations all lower.
- **Object literals widen per-field into union arms**: the reducer-action pattern — a literal whose fields fit exactly one arm of a contextual union — now compiles.
- **The `performance` global**, `Response.headers`/`arrayBuffer()`/`bytes()`, and `Math.max`/`Math.min` at any arity.
- **Workspace members install-agnostic**: monorepo siblings classify identically whether the package manager symlinks or copies them into `node_modules`.

### Fixes

- Whole-program IR validation over large mixed static/dynamic graphs no longer surfaces internal errors: island values entering typed intrinsic slots are validated at the boundary, and `any`-typed values dispatch through the checked-dynamic machinery.
- `JSON.stringify` of a dynamic value holding `undefined` now prints identically on both backends.
- Loose equality between same-kind operands lowers as strict equality.
- The limitations page documents the type surface: where scriptc's ambient world is narrower than stock TypeScript's, and what diagnostics point at instead.

## 0.0.3

### Features

- **Surface manifest**: each release now ships a machine-readable `surface-manifest.json` — the language and stdlib surface the static tier compiles at that version, with stable per-entry ids so tooling can diff two releases mechanically. Every non-static entry carries the diagnostic code the compiler raises for it. Attached to the GitHub release and shipped inside `@scriptc/compiler` as `@scriptc/compiler/surface-manifest.json`; regenerate with `pnpm manifest`.

## 0.0.2

### Features

- **`Number(aString)` compiles statically**: the full ECMAScript ToNumber string grammar (whitespace forms, hex/octal/binary literals, `Infinity`, exponents, trailing-garbage → `NaN`), verified bit-exact against Node on one million fuzzed strings. Unary `+` on strings and `%d` formatting over strings ride the same lowering; `parseFloat(aString)` compiles statically with its own longest-prefix grammar.
- **`Array.from(aString)` and `[...aString]` compile statically**: strings split by code points, so astral characters stay whole — exactly the string iterator's walk.
- **Bare `'.'` and `'..'` import specifiers** resolve as relative directory imports, and default imports of supported Node builtins (`import fs from "node:fs"`) pass type checking under the project's own interop settings.
- **Workspace-linked packages** register before the type-check gate, so pnpm-workspace monorepos analyze without their sibling packages' shipped JavaScript gating the build.

### Fixes

- `scriptc coverage` now renders the same diagnostics a build prints — code frames included — when analysis stops on type errors or import fences, instead of a bare summary line.
- The LLVM backend's runtime declarations are now mechanically checked against the C runtime's prototypes at test time; two latent signature mismatches were found and fixed.
- Import-cycle admission accepts declaration-only initialization windows whose calls resolve entirely to declaration files, widening the set of legal ESM cycles that compile statically.

## 0.0.1

### Features

- **The CLI**: `scriptc build` compiles a TypeScript or JavaScript entry point into a self-contained native executable, `scriptc run` builds and runs it in one step, and `scriptc coverage` reports statement by statement what compiles statically and which specific constructs block, each with a diagnostic code.
- **The static tier**: programs compile to native code with no JavaScript engine in the binary. Type checking is the real TypeScript compiler; what compiles behaves byte-for-byte like Node, enforced by a differential test corpus.
- **`--dynamic`**: an embedded JavaScript engine (quickjs-ng) executes what cannot compile statically. Values crossing back into static code are validated at runtime, so a mismatched type throws a catchable `TypeError`. Static remains the default; a binary never silently grows an engine.
- **npm dependencies** (with `--dynamic`): packages resolve with Node's own resolution algorithm, typecheck against their shipped `.d.ts`, and their JavaScript is embedded into the binary at build time. Binaries never read `node_modules` at runtime.
- **Platforms**: macOS arm64 is the primary platform; Linux and Windows binaries build by cross-compilation, each verified by its own differential test lane.
