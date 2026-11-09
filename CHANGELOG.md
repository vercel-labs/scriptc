# Changelog

All notable changes to scriptc will be documented in this file.

## Unreleased

<!-- release:start -->

## 0.4.10

### Highlights

- **Faster programs:**
  - A function literal written where a function with more parameters or other parameter types is expected is lowered once with that slot's parameter list instead of being wrapped in a signature adapter: a loop that calls a two-parameter callback 12 million times takes 154 ms instead of 1,544 ms.
  - Typed-array conversion between integer kinds stores each element directly instead of routing it through a double: `set()` of 131,072 elements from a `Uint8Array` into a `Uint16Array` takes 1.9 ms instead of 61.2 ms, and the `typed-array-convert` workload runs at 0.65x Node's time instead of 1.29x.
  - Loop-bound versioning covers loops that write record fields, so `advance` in `n-body` drops its double counter and its double-to-integer round trip per index: scale 1 under `--layouts=4 --runs=16` takes 132.5 ms instead of 158.4 ms.
  - `new Error(message)`, `Error(message)` and `super(message)` into a builtin error base use the typed constructor when the message is a native string or `undefined`: a throw-and-catch `new Error("too big")` executable is 96,760 bytes instead of 307,392, and 774 of the 779 changed corpus executables are smaller.
  - A same-shape clone snapshots its source's own keys only when the source keeps keys the plain copy would not reproduce: a tree rewriter over `Expr` values built by literals runs in 311 ms instead of 3,769 ms once the program also parses one `Expr` and prints it.
  - A boxed function's name lookup sorts the module's closure-name table once and binary-searches it: with 5,178 named functions, 600,000 boxes take 166 ms instead of 1,349 ms.
  - A regular expression's character class is collected, sorted and merged into the class once: six patterns of two properties and 60 ranges each compile in 1.19 ms instead of 7.20 ms.
  - A start of a program with Node islands no longer parses the manifest or reads and hashes the island module tree: a warm `--version` of pi takes 560 ms and 157.7 MB instead of 1,050 ms and 171.6 MB, and makes 14,000 system calls instead of 232,000.
  - A regular expression anchored at the start is searched with one attempt when every path through the pattern meets a non-multiline `^` first, a non-ASCII subject is matched on the bytes its string holds instead of being converted to UTF-16, and `s.slice(k)` on a non-ASCII string no longer reads the whole string to find its end: a tokenizer over non-ASCII text takes 12.9 ms instead of 4,876 ms against Node's 90.3 ms, a loop over a 600,000-character text takes 0.30 s instead of 381 s, a slice of one takes 10.3 µs instead of 59.1 µs, and a regular-expression call on a new non-ASCII string takes 0.04 µs instead of 64 µs at 100,000 characters. The 260 programs that link the regular-expression unit grow by 832 to 18,880 bytes.
  - `x instanceof C`, `new C()` and `C.member` with `C` an untyped value, and a computed read on an untyped value, index a table from eight class values, sixty-four for computed reads, instead of walking every class of the program: a 240-class program takes 696 ms instead of 2,183 ms.
  - A list `Object.values` makes over a checked-dynamic object stays a native list through `map`, `filter`, `flatMap`, `reduceRight` and `findLastIndex`, and the callbacks are called directly: the `catalog-tables` workload takes 95.0 ms instead of 186.7 ms.
  - A record that is one arm of a union stays the same object in a checked conversion, so a write through the union value reaches the record: collecting a 300-record table takes 0.223 ms instead of 37.6 ms, and the `stream-buffered-drain` workload takes 44.7 ms instead of 59.8 ms.
  - A loop over rows of numbers or numeric class instances runs the rows as masked lanes, each lane running its own inner loop with the instance methods inlined: the `value-objects` mandelbrot workload takes 0.7571 of its former wall time, and every other runtime workload's generated code is unchanged.
  - A loop's carried values are packed only when the pack gains more than it costs, so a break-even pack stays scalar instead of adding insertion and extraction to the loop's carried dependency chain: a Mandelbrot sampling loop whose periodicity test is `|dx| + |dy| < eps` runs 17% faster with the same output, and the runtime benchmark set is neutral.
  - A program's start-up code is emitted first, ahead of everything else in the image, and its symbols and the runtime functions they call are ordered first at link time: a program that uses fx-ts reports 186 to 191 minor faults instead of 227 to 230, touches 16 text windows instead of 37, keeps 229 to 234 resident text pages instead of 538, peaks at 3.0 to 3.1 MB instead of 4.2 to 4.5 MB and takes 0.877 to 0.886 of its former wall time.
  - A program with island packages it does not use starts in 2.2 ms instead of 75.1 ms, one that uses them starts in 71.6 ms instead of 87.7 ms and cold in 60.5 ms instead of 76.0 ms, for executables 1.15% larger.
  - `Math.random()` draws from a per-thread xorshift128+ generator seeded once per thread from the system's secure source instead of asking the secure source for every number: 5,000,000 calls take 20 ms instead of 184 ms, a call takes 3.4 ns instead of 36 ns against Node's 11 ns, and the `misc:math-random` workload takes 3.0 ms instead of 36 ms. `node:crypto` and WebCrypto keep the secure source for every call.
  - A captured binding that is filled once before a closure over it is created and that nothing rebinds afterwards is captured by value instead of through a heap box, and a binding whose every capture is of that kind has no box: the compiler's own emitted module has 10,422 boxed captured bindings instead of 43,472, `cyclic-graphs` runs 12.3% faster, and the compiler's own executable is 106,875,664 bytes instead of 108,383,576.
  - A typed call of a method that an untyped write somewhere could replace is the declared call, direct or virtual, while the receiver has no own dynamic property and no prototype object of its class family exists: a loop of one-line method calls takes 4.3 to 4.4 ns per call and 58 instructions instead of 93.7 to 102.4 ns and 1,215, and its executable is 545,432 bytes instead of 572,528.
- **Faster builds:**
  - A comment or whitespace edit reuses the cached frontend only when every recorded text read answers the same: a comment appended to a typed CLI that imports commander rebuilds in 0.372 s instead of 8.53 s. A build with a literal `require.resolve` is cached, so the compiler's unchanged rebuild takes 11.8 s instead of 1,143.6 s, and `SCRIPTC_TIMING=1` reports why a build is not cached.
  - A build whose `tsconfig.json` lists the output's directory restores the executable from the cache, so the second and third builds take 0.39 s instead of 1.33 to 1.38 s.
  - A call chain of 12 links lowers in 37 lowerings and 1.2 s instead of 24,584 lowerings and 3.7 s, and a 30-link chain builds in 1.5 s where it previously exceeded 60 s at 19 links.
  - `--emit-lowered <file>` writes the lowered program a build produced, and `--from-lowered <file>` builds from it without starting a type checker or lowering anything: the compiler's own source builds in 311.7 s instead of 770.8 s, and a changed source, option or compiler build is refused by name with `SC3002`.
  - The canonical-type walk maps each object node once per depth instead of once per path, and the type mapper answers each type once per depth: `scriptc coverage` on json-schema-to-typescript finishes in 113 s at 2.0 GB where the previous build was stopped at 420 s, and pi's first lowering fixpoint takes 9.4 s instead of 147 to 153 s.
  - Lowering drops lifted functions the module no longer reaches: about 12,600 of the 54,700 functions in the self-hosted compiler's module had no caller, the phases after lowering take 8% less, and its executable is 41,520 bytes smaller.
  - A run of more than 64 consecutive literal items that differ only in numbers, strings and booleans is built from columns in the program image: a 20,000-row record table builds in 15.5 s instead of 1,114 s with a 1,465 KB executable instead of 7,519 KB.
  - A lowering pass that a later pass replaces ends where it asks for the next stream mode instead of lowering the rest of the program: the compiler's own lowering falls from a mean 656 s to 471 s, and its self-hosted build is 19.26% faster. A class that extends `Array` keeps its `arrayFields` and `arraySpecies` functions on the pending flag, so 20 corpus programs that emitted twice now emit once.
  - Lowering interns each finished function's long string literals, so one string is held per failure-message text: the compiler compiling its own source has a largest heap of 4,105 MB instead of 6,424 MB and builds 2.7% faster.
  - A typed program with a generator records the ambient receiver only when the module reads a generator's `this`, which removes a dynamic receiver read, 3 KB and 15 symbols from every such program: 111 of the 239 changed executables in a corpus build shrank, up to 4,920 bytes.
  - An npm-static build no longer computes diagnostics nothing reads, so its frontend loads fall by 19 to 56 s in five of six measured pairs (median 31 s).
  - A build sends the LLVM codegen helper's `version`, `emit` and `merge-profiles` commands to a resident server over a Unix socket and falls back to a process per build when no server answers; cold native builds of the Benchmarks Game programs run 3.9% to 8.8% faster, with executables identical to those of a build without the server.
  - Ending a stream program's push-down pass once both of its stream flags are set shortens a build of `packages/coding-agent/src/cli.ts` with 15 `--npm-static` packages from 1070.3 s to 882.5 s, 17.5% faster.
  - Nursery bypass statistics are kept per closure body, in a per-thread table keyed by the closure's function, instead of one family each for closures and for boxes holding closures, so a program's long-lived closures no longer keep its short-lived closure cycles in the nursery: a cold build of the TypeScript compiler's sources is about 2% faster and compiler peak memory 17% to 18% lower, and the runtime benchmarks are unchanged.
  - The runtime pack builds `scr_events.c` once per flavor instead of 16 times, and the four runtime units that reach Node islands build once per flavor and worker mode instead of having an island build of their own: the linux-x64-gnu pack falls from 241.59 MB to 233.90 MB and holds 155.2 MiB of object bytes instead of 183.5 MiB, the wasm32-wasi pack falls from 57.40 MB to 55.57 MB, and builds beyond the default executable flavor fall from 56 to 49, while executables that link the merged units grow by up to 9 KB and no program's IR or LLVM changes.
  - A program whose async-iteration protocol types hold a value that is not a compiled generator decides those types from the program's flows before lowering, so it lowers once instead of twice and only the slots over the implementor's element type become dynamic: a program with an `AsyncIterable<string>` implementor is 724,856 bytes instead of 778,608.
  - A class's dynamic key tables are keyed by class and operation instead of one copy per dispatch helper, so helpers that differ only in the key's form or in `optional` share a table: pi's first lowering round builds 4,968 tables instead of 8,073 and 796.1 MB of serialized IR instead of 910.0 MB, paired pi builds take 1,596.5 s instead of 1,643.8 s, and the compiler's own executable is 100,789,952 bytes instead of 101,760,800. Computed access on class instances through an untyped value is up to 2.7% slower and typed code is unchanged.
  - An expression's operands are lowered once for the same request and the value reused while that expression is lowered, so `Object.keys(Object.keys(…))` nested nine levels takes 21 lowerings instead of 349,533, and two emitter passes walk the module once instead of once per item: the compiler's own build is 9.8% faster and its build of its own source 1.25% faster, with emitted code unchanged.
  - A typed program that reads a closed record through `Object.keys`, `values`, `entries`, `for...in`, `in`, `JSON.stringify`, string conversion or inspection links no dynamic object model, so a program that enumerates a record of records falls from 397,184 bytes and 37 dynamic-tier symbols to 124,256 bytes and none, and an ELF partition object gives each function and datum a section so the link drops a promoted definition nothing refers to: 1,646 of 5,402 corpus programs are smaller, and the compiler's own executable falls from 103,560,232 to 101,104,024 bytes.
  - The compiler's own build is 7.18% faster: `pause()` on a child's stream compiles, so the build makes one lowering pass where it otherwise aborts a pass and lowers again.
  - A rebuild after a comment-only edit is answered from the frontend cache, including in a program that declares an enum another file can name, where a rebuild of a 241-file fixture takes 1.7 s instead of 146.5 s, because import elision decides from the syntax tree and the type checker alone and a file that loses no import reads no text.
  - Frontend and whole-program work that repeated per file, per import declaration or per pass is done once per load or per lowering round: import elision is decided once per project load, so the frontend load of a 400-module program takes 2.93 s instead of 3.49 s and of a 1,200-module program 7.56 s instead of 9.94 s; three whole-program answers are computed once per round, so lowering takes 25% to 43% less and the compiler holds 2.2 to 2.9 GB less on a large program; the type-only import check reuses the type-check gate's diagnostics; and the variadic check returns without walking a program that cannot need it, taking 21 ms instead of 1,150 ms on the compiler's own source.
  - A type mapping walks each type it reaches once instead of once for every path that reaches it, so a chain of records that each name the next one in two members no longer costs 2^depth: a graph reduced from a real library's types builds in 2.2 s at 20 levels and 2.7 s at 40, against 92.1 s at 20.
  - A mapping that passes 500,000 steps ends the build with `SC2016` at the declaration of the type it was mapping; record graphs deeper than the depth limit that ran for minutes or without end now end the build in 3.8 s to 6.9 s.
  - `--coverage=reached` skips the unreached remainder pass for a large program, and the report states that the unreached code was not analyzed.
- **Node.js parity:**
  - `node:sea` is a supported builtin module under the `node:` prefix only: `isSea()` is `false`, and `getAsset()`, `getRawAsset()`, `getAssetAsBlob()` and `getAssetKeys()` throw Node's `ERR_NOT_IN_SINGLE_EXECUTABLE_APPLICATION` when their arguments do not fit.
  - In a JavaScript source, a call to `path.join`, `path.resolve`, a synchronous `fs` function or a timer function with an argument of the wrong type throws Node's `ERR_INVALID_ARG_TYPE` with Node's message instead of a codeless `TypeError`, and a timer whose callback is not a function throws it synchronously, after every argument expression evaluated.
  - A child launch whose file, command, argument, `cwd` or environment key or value holds a NUL, or whose file is empty, throws Node's `ERR_INVALID_ARG_VALUE` from the call before a process starts, across `spawn`, `spawnSync`, `exec`, `execFile`, the synchronous and promisified forms, and `fork`.
  - Node's error shapes apply to a relative `require()` that names no file (`MODULE_NOT_FOUND`), a failed spawn's `'error'` event (`errno`, `syscall`, `path` and `spawnargs`, one object for every listener) and a failed directory read, whose message and error carry no path.
  - `http.request`, `http.get`, `https.request` and `https.get` check the names and values of the `headers` option and the derived `Host` header before a socket is taken, throwing `ERR_INVALID_HTTP_TOKEN` or `ERR_INVALID_CHAR` as Node does, and a `Content-Length` or `Transfer-Encoding` field in the trailers of a chunked request is refused.
  - A TLS client refuses a server's finite-field Diffie-Hellman group under 2048 bits, as Node does: the compiled client agrees with Node on connect-or-refuse for all 29 public TLS endpoints tested, against 28 of 29 before.
  - Named imports of the `process` data members `argv`, `execArgv`, `execPath`, `platform`, `arch`, `pid`, `versions` and `allowedNodeEnvironmentFlags` read the same value as `process.<member>`, and a JavaScript read of a builtin data member with no lowering is refused by name with `SC2020`.
  - `spawn` and `spawnSync` accept a union-typed `stdio` slot, `spawnSync`'s `result.stdout` and `result.stderr` without an encoding are branded Buffers that answer the same object on every read, `Object.entries`, `keys` and `values` enumerate a union of record shapes, and `Reflect.getPrototypeOf` lowers like `Object.getPrototypeOf`.
  - `fs.promises.writeFile(path, data, { mode, flag })` and `fs.appendFileSync(path, text, { encoding })` lower with the creation mode, the exclusive flag and text, `Uint8Array` or `Buffer` payloads, so `fs.promises.writeFile(path, bytes)` truncates instead of appending. `fs.Dir` implements `read(callback)`, `close(callback)`, `Symbol.dispose` and `Symbol.asyncDispose`, `fs.opendir` has its callback form, `Dirent` answers all seven entry-type probes, and a compiled directory walk runs 15 ms against Node's 152 ms for 200 walks of 200 entries.
  - `process.execPath`, `process.env`, `os.tmpdir()` and `os.userInfo().username` read and write through the Win32 W APIs, so non-ASCII text survives a non-UTF-8 ANSI code page such as CP932 or CP1251 and `fork` from an executable in a non-ASCII path works.
  - The ES2025 Set methods `union`, `intersection`, `difference`, `symmetricDifference`, `isSubsetOf`, `isSupersetOf` and `isDisjointFrom` follow the set-like protocol on dynamic Sets, `Set.prototype` answers brand checks and `Symbol.toStringTag`, and `new Set(iterable)` calls a patched `add` for each value: Test262's `test/built-ins/Set/` passes 563 tests instead of 341.
  - `in`, `Object.keys`, `hasOwnProperty` and `typeof` over a builtin module namespace answer Node 24's member census for both the CommonJS exports object and an `import * as` namespace, and `Object.keys(namespace)` lists names forwarded through `export * from` in Node's code-unit order; 500,000 mixed `in` and `hasOwnProperty` probes take 12.2 ms against Node's 87.2 ms.
  - In `node:events`, symbol event names key the listener registry by identity, so two `Symbol("s")` names are different events and `Symbol.for` names meet across call sites, and the `MaxListenersExceededWarning` a compiled program reports carries Node's `emitter`, `type` and `count` for a compiled emitter and for one built through an untyped constructor. `eventNames()` keeps the `_events` key order, the warning prints `Symbol(description)`, and a replaced `process.emitWarning` receives the warning object as its only argument.
  - `util.inspect`, `console.dir` and `util.formatWithOptions` accept `numericSeparator` as a literal or a run-time option and group a number's digits in threes, the integer part from the right and the fraction from the left, with a bigint's digits before its trailing `n` and the sign outside, at every depth and inside arrays, objects, `Map` keys and values, `Set` entries, typed arrays, Buffers and custom inspect options, for `%s`, `%d`, `%i`, `%f` and `%o`. Short integers, exponent forms, `NaN`, `Infinity` and `-0` are unchanged, and a non-boolean value is refused at compile time and at run time.
  - `writeFileSync` and `appendFileSync` accept the documented option records (`encoding`, `flag` from Node's full `stringToFlags` table, and creation `mode`) for string, `Buffer` and `Uint8Array` data with Node's validation order and error shapes, and `fs.promises.writeFile(path, bytes)` applies the creation mode and the exclusive flag, so it truncates instead of appending. `fs.existsSync` accepts a Buffer path, a union of strings and Buffers, and `any`-typed values, answering false with Node's one-time DEP0187 report for anything that is not a path.
  - `await import("node:<builtin>")` lowers to the builtin namespace token behind the import's microtask hop for every supported module, with member calls dispatching on the awaited namespace and a destructuring pattern going through the static namespace alias handling, and a require-typed `node:path` binding answers `path.parse` and `path.format` through the runtime's checked forms, including a value the compiler cannot see and a record held through a checked value.
  - `worker_threads.Worker` implements Node's `env` option, with object entries coerced by `String()`, `null` and `undefined` copying and `SHARE_ENV` sharing, and `Sign` and `Verify` streams have the Writable surface Node gives them: `write()` applies `update()`'s bytes, `end()` finishes at once and `pipe()` can pipe into one, while the Readable side stays absent.
  - `ReadableStream.from` steps any iterable, and a `type: "bytes"` source builds a byte stream whose BYOB `read(view)` detaches the destination as Node does. The writer, controller, transform, reader, byte controller, request and queuing-strategy constructors build in a typed program, `pipeTo`, `pipeThrough`, `TextEncoderStream` and `TextDecoderStream` answer as Node does, `key in handle` reads a class handle's getters, and `node:stream/consumers` collects a Node Readable, a web `ReadableStream` or any async iterable into text, JSON, a buffer, an ArrayBuffer, a Blob or bytes.
  - In a JavaScript source, a function value answers the `caller` and `arguments` reflection questions: `f.hasOwnProperty("caller")` is false, and `f.caller` and `f.arguments` throw Node's `TypeError` for a strict-mode function. The operators coerce their operands through ToPrimitive and ToNumeric, so `"6" / 2`, `true - null`, `s << "1"` and unary `-`, `+` and `~` follow Node, own-key probes over lib-declared builtin functions answer `length` and `name`, and an array-literal hole in a tuple position lowers as the position's `undefined`.
  - Computed `import()` specifiers are bounded at build time from literals, no-substitution templates, `const` and never-reassigned `let` bindings, `+` and template-span products capped at 256 values, `?:`, `??`, `||` and the parameters of module-local functions that are only ever called, and an unbounded specifier is refused at build time with the source that stopped the analysis. In an ES module, `require` throws `ReferenceError: require is not defined` and `typeof require` is `"undefined"`, as in Node 24.22, and `fs.access` and `fs.truncate` read through the bounded `node:fs/promises` namespace box as function values.
  - `server.listen` reads its arguments as Node does: an `undefined` or `null` port is an unused port, an `undefined` host is every interface and an `undefined` callback is no callback, a union with `undefined` is decided at run time, and a `string | number` port goes through the run-time port check. `JSON.stringify` of an untyped value that Node maps to `undefined` answers `undefined`, and `new RegExp("/").source` is `\/`.
  - A container that holds itself through an `unknown` slot prints as Node prints it, so an untyped array that contains itself prints `<ref *1> [ 1, [Circular *1] ]`, through `console.log`, `util.inspect` with `depth: 0` and `util.format` with `%o` and `%O`. `in`, `hasOwnProperty` and `Object.keys` over a builtin namespace answer from the namespace the program loaded instead of a census generated for one platform, so `node:constants` reports a member that comes from the platform's C library, such as `O_SYMLINK`, and `process.features` answers booleans that describe the compiled binary.
  - `Object.defineProperties` reads a descriptor map held as a typed record, a class instance or an array, defines symbol-keyed descriptors, accepts a class instance held as an untyped value as a receiver, and throws Node's `Cannot convert undefined or null to object` for a map that is `null` or `undefined`: Test262's `built-ins/Object/defineProperties` passes 742 of 1,264 variants instead of 726.
  - A child's `stdout` and `stderr` `'data'` listeners run in the order Node delivers them, `'spawn'` and `'exit'` events fire in spawn order, a failed spawn's `'error'` fires before its streams' `'end'`, and the `'close'` events of children whose pipes end in their exit turn follow every `'exit'`: of 25 measured shapes, 20 match Node in 50 of 50 runs instead of 8. A promise resolved with a value of unknown type adopts it, in the executor of `new Promise`, `Promise.withResolvers()`, the value `util.promisify` hands on, `Promise.resolve(p)` for a `p` typed `any` or `unknown`, and an async generator's `yield` and `return`, and `promise.finally(() => cleanup())` waits for the promise the callback returns.
  - `node:net`, `node:http`, `node:dgram`, `node:stream` and `node:crypto` report Node's error codes and system error fields. `node:http2` matches Node's events and state, so `session.ping` answers `true` for a PING that left, `false` past ten unanswered pings and nothing while connecting or after `close()`. An `Expect` request's head is sent at construction, a `ClientRequest` emits `'information'`, `on("connect")` on a request held as an untyped value installs Node's tunnel listener, `agent: false` is Node's throwaway agent, and `'unpipe'` and `'pause'` are emitted through a pipe's lifecycle as Node emits them.
  - `maxBuffer` is enforced in child_process and the pipes close when a capture is killed, `pause()`, `resume()`, `isPaused()` and `readableFlowing` lower on the child stream handle, a computed `maxBuffer` is evaluated in source order with the other launch options, and a paused output stream of an `exec` or `execFile` child holds 65 MB where it held 766 MB. Fatal error exit, `NODE_NO_WARNINGS`, port validation and `process.disconnect` follow Node, and five Node value reads that compiled programs got wrong now answer as Node does, among them `in globalThis`, `execArgv`, `typeof exports` and the zlib namespace.
  - `structuredClone` of an error gives a new Error of the class Node picks, with the source's own `message`, its `stack`, a clone of its `cause` and nothing else, and a DOMException clones to a DOMException. `module.enableCompileCache()` answers `{ status: DISABLED, message }`, creates no directory and writes nothing, with `getCompileCacheDir()` `undefined` and `constants.compileCacheStatus` available, and chalk 4.1.0 compiles natively, with named styles never starting Node and the color models starting it at first use.
  - An empty array literal takes its element type from its context, so `const [name = "none", count = 0] = table["missing"] ?? []`, `cond ? xs : []` and a nullable `any[]` beside a typed arm compile where they were refused or threw at a later push.
  - `Promise.all` and `Promise.allSettled` take values, promise-or-value entries and tuples, `Promise.allSettled` gains its tuple form, and the order of turns against neighbouring `then` chains matches Node. A cast of an unknown value to `undefined` or `void` checks the value and throws on anything other than `undefined`, `a ?? b` over a left side that can only be nullish answers `b`, and `instanceof URLSearchParams` and `instanceof Buffer` are tested at run time.
  - A function is one value with its own properties: `fn.call = f`, `Object.defineProperty(fn, "bind", …)` and `delete fn.apply` create, define and delete own properties as in Node, and a function merged with a namespace or a `mock.fn()` keeps its members, so `Object.keys(fmt)` and `"digits" in fmt` answer as Node does. An untyped call reaches the function behind a typed slot instead of throwing before it starts.
  - `Intl.NumberFormat`, `Intl.DateTimeFormat` and `toLocale*String` with options compile over ICU 78 for the default locale, `"en-US"` and `"en"`: options are read when the program runs, an invalid option throws Node's error, and other locales and formatter members stay refused by name.
  - A built-in global called or read through the global object (`globalThis.parseInt`, `global.Number`, `new globalThis.URL`, the timers, `queueMicrotask`) compiles to the built-in, a program that writes one of those members on the global object is refused by name, and a `createRequire` loader can be stored, passed, returned and used as a shorthand member, with a request that does not resolve throwing Node's `MODULE_NOT_FOUND` where it is called.
  - A stream held in a variable writes through the stored stream as Node does, the built-in undici gains `ProxyAgent` and a global `fetch` whose init carries a dispatcher goes through the package's fetch, while an object that is no dispatcher of the package is refused by name, and the built-in undici compiles beside Node types that declare neither the web stream classes nor `DOMException` as globals.
  - `writable.end(chunk)` takes a `string | Buffer` chunk and a chunk that may be null or undefined, and `spawnSync`, `execFileSync` and `execSync` evaluate a call or getter given as `windowsHide` (and `execSync`'s `shell`) where the member sits, in Node's order.
  - `fs.createReadStream`, `fs.createWriteStream`, the stream constructors and a `FileHandle`'s `createReadStream`, `createWriteStream` and `readLines` apply a `signal` option as Node 24 does: an abort destroys the stream with an `AbortError` whose `code` is `ABORT_ERR` and whose `cause` is the reason, emits `'error'` then `'close'`, and closes the descriptor, and an already aborted signal destroys the stream when it is created.
  - `assert` strict, loose and partial deep comparisons read an accessor through its getter and compare enumerable own properties only, and the failure message shows accessors as Node's inspection does; a run-time `%s` runs a record's own `toString`, and a string conversion of an untyped value that is an instance of a class declaring `toString` is refused with `SC2020` where it produced `[object Object]`.
  - A workers program releases what its emitted conversion and call helpers made before returning on a thread that was told to stop (`worker.terminate()`, `process.exit()` in a worker, shutdown): a string leaked in up to 26 of 30 runs and leaks in 0 of 100.
  - A function value prints by its own name and call kind wherever it is held (in an array, a record, a class field or a typed slot, and as a static method, a bound method or a method of a JavaScript class): an async function prints as `[AsyncFunction: f]`, a generator as `[GeneratorFunction: f]` and an async generator as `[AsyncGeneratorFunction: f]` where the inspector printed `[Function: f]`. `??=`, `||=` and `&&=` on a member of a Node island object compile in JavaScript's order, and testing an island value as a condition, under `!`, `typeof` or strict equality with a primitive needs no conversion.
  - A class that extends an island class may declare optional parameters on its constructor and its methods and answers its constructor's `length`, and a function passed by name as a child's `'exit'` or `'close'` listener may declare the code as `number` and stays findable by `removeListener`; a method `length` that cannot be read and a `string` signal parameter are refused by name.
  - A `child_process` launch gives the child the signal state a Node child starts with: signals 1 to 31 are at their default action with an empty mask, so `child.kill("SIGINT")` reaches a child of a program started with SIGINT ignored or under `nohup`, and `SIGCHLD` returns to default so exit codes are reported. A child's `ref()` and `unref()` answer `undefined`, and a socket's `'close'` listener is called with `hadError`.
  - A stream destroyed with a reason that is not an `Error` keeps that value: a falsy reason destroys the stream without an error, a reason given to an untyped `write`, `final`, `flush` or `transform` callback stays that value, and a value thrown by the source of `Readable.from`, an operator function or a pipeline stage is the reason once rather than an `AggregateError`. An `'error'` listener whose parameter admits the value receives it, a listener that declares an `Error` fails its checked conversion by name, and an untyped emitter with no listener throws `ERR_UNHANDLED_ERROR` for a primitive.
  - Type arguments on a base class the runtime provides are erased, and extending a built-in class that has no subclass layout (`Map`, `Set`, `Promise`, `URL`, `AbortController`, the web streams) is refused with one error that names the class and states what compiles instead, with or without type arguments.
  - A promise used as a `WeakMap` or `WeakSet` key is found by its identity, and a thrown promise is still a promise where it is caught (`x instanceof Promise`, `x.then(...)`); a function read through a parameter, a field, an element, a `Map` or a reassigned binding reports the name of its definition instead of the name of the binding it was read through.
  - A project that lists `dom` in the tsconfig `lib` can name a DOM type or global even from a module imported only for a type: the name is admitted as a type and absent as a value, so a read throws a `ReferenceError` and `typeof` answers `"undefined"`, while a global Node 24 defines is never admitted this way; `Object.entries` and `Object.values` over a record with run-time keys answer every value to a callback parameter or a `for...of` binding where a value that does not fit the literal's own members ended the run with a `TypeError`.
  - `http.Server` lowers `off`, `removeListener`, `listeners` and `newListener` for the request-side event lists, and the fallback types declare `uncaughtException` and `uncaughtExceptionMonitor`.
- **TypeScript parity:**
  - `console` and its output methods are usable as values in both type worlds: `const { log } = console`, `console.log.bind(console)`, a method in an object literal or a class field and a `Map` of sinks compile, `console.log === console.log` holds, and a stored method formats through `util.format`.
  - `x.constructor` on an instance of a program class answers the instance's own class, so `.name`, identity comparisons, static reads and `new (x.constructor as T)()` compile, and static accessors of a TypeScript class collect as ordinary module functions.
  - `delete rec.k`, where the record's type does not declare `k` and the record can keep a source, removes the key from that kept source, so `in`, `hasOwn`, `Object.keys`, `JSON.stringify`, spread and the untyped read stop seeing it, and `"k" in instance` on a class receiver answers from the class declaration.
  - `promise.catch(handler)` accepts a handler that is not an inline function expression, including a declared function, a `const` arrow, a field or method, a call result, `console.log` or an executor's `reject`, while an absent handler is ignored so the rejection passes on.
  - A JavaScript file that reads an undeclared name another library declares, such as `document` or `window`, compiles and throws Node's `ReferenceError` when the read runs instead of being refused, and a dotted write of a property the static type does not declare lowers: 370 of the 692 Test262 variants that met `assignment to non-variables are not supported yet` now pass.
  - A `for…of` loop over a union of array types runs the array walk with the length and the read dispatched on the tag, an async function value called with a possibly missing argument keeps its promise as its result, and a call that chooses between a function value and a loader's `resolve` resolves the request at build time: the pi build reports 63 diagnostics instead of 66.
  - Non-Unicode regex literals whose decimal escape names no group or sits in a character class (`/\1/`, `/(a)\2/`, `/\8/`, `/[\1]/`) compile with Node's legacy octal and identity meaning, and `@param {T} [name]` on a JavaScript setter reads as documentation rather than an optional parameter.
  - `AsyncIterable<T>`, `AsyncIterableIterator<T>` and `AsyncIterator<T>` as value types hold the checked-dynamic value, so `for await` steps a compiled async generator natively and awaits a synchronous iterable one value at a time: the pi build log falls from 96 errors in 56 files to 90 in 51.
  - A class field typed by a type parameter (`T`, `T | null`, `T[]`, parameter properties, inherited base fields) compiles when the instantiation binds the parameter to `unknown` or `object`, and a declaration-only package's config type with method or callback members maps structurally: the pi coverage run reports 1275 diagnostics instead of 1288, 13 cleared and 0 added.
  - The library `ArrayBufferView` interface maps to the checked-dynamic value by its type wherever a value of it flows, and its `buffer`, `byteOffset` and `byteLength` reads lower from the typed array or DataView behind it, with `buffer` keeping Node's ArrayBuffer identity.
  - `Number.isFinite`, `Number.isNaN`, `Number.isInteger` and `Number.isSafeInteger` of a value that is never a number evaluate the argument and answer `false`, and `new Function(...parts)` evaluates each argument, converts it to a string and throws Node's `EvalError` where Node does.
  - An object literal that flows into a checked-identity view holds the members its declared type declares, so a `current: undefined` member can take a value later and `items: []` can take an element: 193 literal shapes match Node, against 144 matching on main. An optional chain the checker narrows as a whole compiles as the narrowed result, and `++` and `--` on a `bigint | undefined` slot narrowed to bigint throw the catchable `TypeError` for `undefined`.
  - An absent optional checked-dynamic field keeps its absent state through a width copy and the hybrid key walk, and a `.filter(predicate)` that narrows a record to a wider type converts through the checked cast, which throws a catchable `TypeError` for a value that does not carry the wider members.
  - An untyped receiver whose value is a compiled function boxes into the checked-dynamic tree, so `apply`, `call` and `bind` dispatch on the runtime kind, and a generic function's capture scan skips identifiers in member-name positions.
  - An annotated `const` or `let` initialized from an existing record keeps that record's layout, so both names stay one object; the conversion becomes a copy only when a declared field cannot hold what the value stores, and a write through such a binding, a written parameter or an annotated literal is refused with `SC2021` instead of losing the write.
  - A value with extra members, an index signature, a class instance or `process.stdout` binds to a narrower record type without a copy and reads and writes through either name, `.concat` and spread over arrays of records with different field sets keep each element's own layout, `new Map([...])` keeps its seeded entries' value arms, `typeof` guards on the process credential readers narrow on every target, and a project is checked with the `lib` its tsconfig names, the target's default library when it names none, and the declaration files `include` adds, matching `tsc -p`.
  - `Reflect.getOwnPropertyDescriptor`, `has`, `deleteProperty`, `get`, `set`, `ownKeys`, `isExtensible` and `preventExtensions` read as function values with Node's `name` and `length`, over the same argument-list lowering the direct call uses, with `get`/`set` receiver substitution and Reflect's target-first check.
  - `process.stdout` and `process.stderr` flow into a record type of methods such as `interface Sink { write(s: string): void }`, calling the stream's current method as Node does (200,000 writes through the record take 44.0 ms against Node's 91.9 ms), and `Promise.all` results hold `undefined` only where an entry is a hole or an `undefined` value, so `rows = await Promise.all(rows.map(load))` no longer widens every array of the row type.
  - A conditional spread whose two arms both carry keys compiles and builds the taken arm's record, a call to an override that takes more arguments than the inherited slot compiles when no class below overrides the method again, a member receiver the checker types by a generic constraint reads through the stored union, `slot as Extract<Slot, { type: T }>` maps to the member the bound literal selects, a value enters a union with a catch-all arm or a shared discriminant by the arm its discriminant value names, and a record beside `undefined` asserted to a subtype is checked into it.
  - A TypeScript `enum` used as a value has a run-time object: `Object.values`, `keys` and `entries`, `for (k in E)`, `JSON.stringify(E)`, passing `E` to typed, generic, untyped and island code, and `E[n]` with a run-time number compile and match Node, while an enum read only through its members compiles as before.
  - A `{} as T` assertion that later writes fill in lowers to a partial record view when `T`'s values may be frozen, including a type a generic deep freeze makes freezable, and in a program that starts worker threads: `Object.freeze` of a view freezes the record it views, `Object.isFrozen` answers for that record through every reference, and a write to a frozen object throws Node's `TypeError`. An asserted type that is one arm of a union, can be part of a reference cycle, is published, or keeps several property orders is still refused at the assertion with `SC3001`.
  - A member call on a typed record, dictionary, tuple or array passes its holder as the receiver in every spelling (`x.f()`, `x["f"]()`, `x[k]()`, `x[i]()`, optional, asserted and parenthesized calls), so a function that reads `this` sees the object it was called on, while calling the value by itself passes no receiver: of 592 probe programs, 192 answered wrong before the change and none do now.
  - A read that TypeScript types `undefined` from an assignment in another function keeps its declared type after a call that may have undone that narrowing, so `"abcd".slice(start)` prints `cd` and `mustache@4.2.0` renders its templates instead of the empty string, and a missing array element passed to a generic method, a static method, a private member or a field holding a generic function arrives as `undefined` instead of taking the checker's type parameter.
  - A static member read through a class name, through `this` in a static method or through `super` resolves at the nearest class that declares the name, whatever its kind: a getter redeclared over an inherited method is called, and a func-typed field over a getter, a getter over a method and a getter with no inherited method of the name resolve to their own declaration.
  - Chained array exports, a destructured `require()` of a rebuilt export object, destructuring into untyped members, and an empty array, `Map` or `Set` passed through a generic call that takes its element type from the destination all compile.
  - A TypeScript file whose nearest `tsconfig.json` does not set `verbatimModuleSyntax` is compiled with import elision, so an import whose bindings the file never uses as values, a clause of `type` specifiers only, an empty clause and a re-export of a type create no run-time edge, while a file with no `tsconfig.json` above it, a file under `node_modules` and a project that sets `verbatimModuleSyntax` keep Node's type-stripping rule. The project's own declarations join the program, and the order of class field initializers follows `target` and `useDefineForClassFields`, so a field initializer may read a parameter property.
  - `typeRoots` reach the type checker, a module with no declarations in `node_modules` is looked up under the type roots, and in a project that compiles under node10 a specifier in a declaration file or in an import Node erases may name a file the package's `exports` map does not list, while a value import of a file the map does not list is refused as before.
  - Array reads over a union of tuple types from an `as const` table run in place: a method runs on the arm the value holds, `for...of` walks the value, `xs[i]` evaluates the receiver then the index and reads the position, `.length` is the arm's own length, and a spread keeps the conversion, while a method a tuple cannot run in place, a method that writes its receiver and a read in place where the binding is also handed to a mutable array slot are refused by name.
  - A class that declares `[key: string]: any` or `[key: string]: unknown` compiles, with the signature declaring no storage and a name the class does not declare becoming an own property of the instance, and a catch binding narrowed to anything but a record, a union or an object type is the checked-dynamic value that any `unknown` value takes, so `typeof` on the binding answers all eight kinds. Assigning a declared field through a computed key checks the value against the field's type, and assignments to a catch binding stay refused.
  - A class method that is a generator with its own type parameters compiles, sync and async, instance, static and private, and a generic generator method reached through an interface runs; a generic async generator method and a field holding a generic generator function expression keep their refusals.
  - A type derived from a built-in handle class through an interface, `Omit`, `Pick`, `Partial`, `Required`, `Readonly`, an alias or an intersection holds the built-in object itself, with members read by name and checked against their declared type, while a required member the derivation adds throws a `TypeError` at the checked read and an instance of a subclass of `EventEmitter`, `Error` or a stream class passed where a record type names fields the program's own classes declare converts to a view of the instance.
  - `const { isTTY, columns } = process.stdout`, the same over an alias or a parameter of the stream type, and an object pattern in a parameter list are the member reads of the stream, in TypeScript and in JavaScript. In a file where an import is elided, values a compiled package with declarations produces are converted to their declared types at the boundary as in every other file, and a generic function that fills a string-keyed dictionary key by key and returns it through an assertion to a mapped type of its type parameters compiles when the dictionary is a `const` of that function that nothing else can hold.
  - `+` and `+=` take their type from both operands together, so `"m" + i` is a string and `this.x += dx` stays a number, and a short array pattern's positional element carries `undefined` unless nothing shrinks the literal.
  - A call that selects one of several declared overloads of a package compiled from its JavaScript is checked against the result of the signature it selected, and where the declaration is wrong for the input the call throws a `TypeError` that names the package, the declaration with its file and line, and the command that patches the declaration.
  - A member read keyed by a template literal reads through the fields the key's text can spell, a generic instance's pattern names bind to the record the call passed, and a `const` key that is not a literal over same-typed members is refused (`SC1090`, `SC2004`) instead of building and printing `undefined`.
  - JavaScript of a package called with typed values (numbers, Dates, Sets, Maps, RegExps, bigints, URLs, records with methods) compiles its uses of the argument's members, and a write to a member the package's JavaScript never builds is refused by name, with `--node-island=<package>` as the way out.
  - `JSON.stringify` of a wide JSON-like union with `bigint` or `symbol` arms takes the run-time traversal, and a union of scalars converts by value, so programs that were refused now build and match Node.
  - A class with a member whose signature has no mapping is no longer refused as a whole: its other members, its construction, `instanceof` and its subclasses compile, and a use of the refused member is refused at that use by name. An override may declare a narrower parameter or fewer parameters than the member it overrides, an argument past the last parameter is still evaluated, a value the narrower override does not accept throws a `TypeError` before the body, and a method value's `length` is that of its own declaration.
  - An `Error` subclass that keeps `code` itself as a field, an index signature or a `declare` field reads the value it writes, `.find` and `.findLast` with a written type predicate run the callback as a test and convert the accepted element with a check, a predicate that accepts an element it cannot convert throws a `TypeError` at run time, and `forEach`, `reduce` and `reduceRight` work on tuples.
  - A position read over a union of tuples joins the arms into a checked-dynamic value where that value holds every other answer itself: `const [missing, found] = await page()` with `page(): Promise<[Error] | [null, Response]>` compiles, and a handle beside a record, an array, a promise or a class instance at one position stays refused with the same diagnostic.
- **CommonJS and islands:**
  - A marked TypeScript module runs in a Node island with its types stripped, and a mark the build cannot honor stops it with `SC8006`: the entry module, a TypeScript module Node cannot strip, a path or glob that matches no module of the program, or a package the program does not load from `node_modules`.
  - A function exported by a Node island package can be used as a value: `versions.sort(rcompare)`, `forEach(note)`, `{ compare }`, `new Set<F>([f])` and timers reach it, and every view of one function is one function to `===`, `indexOf`, `includes`, `Set` and `Map` keys.
  - Awaiting an island promise that is an instance of a `Promise` subclass whose constructor does not take an executor resolves it through the subclass's own `then`, so `await client.messages.create(…)` completes instead of rejecting with `TypeError: Promise resolve or reject function is not callable`.
  - Island values answer as Node does where they differed: a comparison to `undefined` on a missing key follows the island's value, spread and `Object.assign` copy the own enumerable keys, `instanceof` and `Object.prototype.toString.call` report the class or tag, and `structuredClone` clones an island object instead of throwing `DataCloneError`; the crossing matrix matches Node in 331 of its 1,030 cells instead of 292.
  - A workspace package whose bare import resolves to its TypeScript source compiles its JavaScript modules with it instead of fencing their bindings with SC1090, and the issue's program runs natively in 3.3 ms against Node's 67 ms.
  - A CommonJS module whose whole export is one value answers that value to a plain `require()` binding, an ES default import and a `createRequire` binding: `module.exports = Object.getOwnPropertyDescriptor` gives a binding that is the function itself, with Node's `name` and `length`, and a binding exports the value it held at the export statement.
  - `--define` fixes a `process.env` value at build time (`--define='process.env.NODE_ENV="production"'`): `if` statements the value decides are resolved before type checking, so only the taken branch compiles and modules that only the other branch requires never join the program. Conditions built from defined reads, string literals, `===`, `!==`, `==`, `!=`, `!`, truthiness and `&&`/`||` whose left side decides the result are resolved, including `else if` chains, nested `if`s, `switch` cases and several defines at once, and the executable sets the variable when it starts, so the program, its child processes and its worker threads see the build's value.
  - `--define` values must be JSON strings with `process.env.NAME` keys, and defining the same variable twice, assigning or deleting a defined variable, and `--lib`, `cache warm` and `merge-profiles` with the flag are errors.
  - The `@scriptc/libnode-<platform>` packs publish as opt-in packages: `npm i @scriptc/libnode-<platform>` installs the Node.js library a Node island loads, while `scriptc` and `@scriptc/compiler` depend on none of them, and `SC8005` names the file, the `@scriptc/node` API that reached into Node, and the host's install line. Linux packs carry their own C++ runtime, and a pack that still references a `GLIBCXX_` or `CXXABI_` version is refused when it is built.
  - A checked conversion accepts an island handle: a record reads each field through the handle, an array, tuple or index-signature record walks a native view released at every exit, and `JSON.stringify`, `Object.keys` and object spread and rest read an island object's own properties in Node, so `toJSON`, accessors and function-valued members keep their meaning. A value crossing whose type comes from an `@types` package or from a payload union of copyable and native shapes crosses as a handle at the type the program observes, so ws, express and hapi compile.
  - A refused package that only a Node island imports stays inside the island that loads it instead of getting an island of its own, so mocha, hapi, express, koa and the apps whose islands pulled in refused helpers compile. A dotted `node_modules/.prisma` directory resolves as a package directory, a CJS barrel's export expression is a dependency edge, surplus arguments to a JavaScript-implemented callee evaluate and go unused, and a method call a class does not declare is a checked-dynamic read and call.
  - Compiling one package no longer changes how another package is typed: packages that are not compiled are read as they are, so adding a compiled package leaves a neighboring island package's typing and the program's diagnostics unchanged.
  - A program record nested in a record type that receives an island value becomes a live view whose members read from the island at any depth through unions, intersections, optional members, promises and nested literals, while a member declared as an array, tuple, `Map`, `Set`, `Date`, `RegExp`, `Error` or `URL` is refused at the crossing with `SC8010` naming the member path and declared type. A native I/O handle passed into a Node island is refused at build time with `SC8010` where it crosses, alone, as an arm of a union or as a member of a literal: `ChildProcess`, `FileHandle`, the http, net, http2 and dgram handles, `Dir`, `SpawnSyncReturns`, `Hash` and `Hmac` are runtime handles the island export table does not take.
  - A native `AbortSignal` or `AbortController` that reaches a Node island crosses as a twin, a real object of the island's own class: `aborted` and `reason` agree in every listener of either side, an abort from either side runs both listener lists, the program's signal comes back unchanged when the twin crosses out, and a signal the island made is adopted natively, so `fetch`, `AbortSignal.any`, `timers/promises`, `events.once` and a listener's `signal` option accept it.
  - A native `WeakMap`, `WeakSet` or `FinalizationRegistry` keyed by an object a Node island made keeps its entries inside the island keyed by the island object, so two handles for one object are one key and an entry is found after the program drops its handle while the island keeps the object. `FinalizationRegistry#register` and `#unregister` take island targets and tokens, and a value that is not an island value is held in a native cell that crosses by reference, so `map.get(key) === value` holds.
  - `--node-island` reads a bare value as a package name, so a package named like a file (`highlight.js`, `chart.js`, `three.js`) can be marked by name, by `<pkg>/` or by a subpath, while `./x.js`, an absolute path and a glob mark the program's own modules, and `--node-island=<pkg>/sub` together with `--native=<pkg>` is refused. `--native=<name>` and `--npm-static=<name>` are held against the packages the program loads, so a name the program does not load is `SC8006` with a hint, and `scriptc coverage` no longer lists an unloaded `--npm-static` name as compiled.
  - A Node island's modules are probed in the order the program evaluates them: loads that share a file answer for each other's reads and effects, a module-level constant whose initializer is closed over an island package is evaluated inside the island, a program module that runs in an island defers when its top level does nothing, and resolution is answered from a load plan computed at build time with a deferred refusal reported on stderr the first time it fires. On 50 small programs about the order and set of loads, 21 answer wrongly before and none after.
  - A TypeScript module marked `--node-island` that binds a type without `type` is refused with `SC8006` for a default import and for `export { X }`, `export { X } from` and `export default X` of an interface, naming the binding and the `type` form to write.
  - Island code sees `process.argv` and `process.stdout.write`, the `uncaughtException`, `unhandledRejection`, `rejectionHandled` and `warning` registries and `process.exitCode` are one value across native code and a Node island, so a replacement installed by either side is seen by both, and a native error keeps its identity, class and fields through island frames. A thenable is awaited as Node awaits it, an island promise only island code handles is not reported as unhandled, and an unreferenced island timer does not fire.
  - A build-time warning, `SC6007` "divergence: island value crosses as a copy", reports where a checked conversion copies an object or array a Node island made, and the cross-heap collector releases a record or class instance without a cycle header that an island was handed, which stayed a root for the rest of the run: 90,000 records handed to an island left 90,000 exports held, and two major collections freed none. 3,681 dynamic programs become 256 to 744 bytes smaller by testing the island table once and calling it.
  - Typed arrays, Buffers, DataViews, ArrayBuffers and symbols keep one identity across the Node island boundary: a program view that goes into an island and comes back is itself, island code sees one object for one program view, and a `unique symbol` handed to island code is the same symbol there, which removes the `SC8010` refusal. `Buffer.isBuffer` of a Uint8Array an island made answers false, as in Node, and a resizable or detached program ArrayBuffer, and a view of one, are refused by name at the crossing.
  - A JavaScript constructor that returns an object of another kind answers it for a construction whose result is an untyped value, and `Object.defineProperty(module, 'exports', { get })` in a package becomes the whole export of the getter's value, with the getter run as often and in the same order as Node's loader. `fn.constructor = value` on a function is an own property of it, and a `require()` inside a function of a compiled package that names a package the program does not compile runs that package in a Node island the call loads.
  - A worker thread that calls into a Node island works: each island operation is posted to the thread that started the island and the worker waits for the answer, so a synchronous island call from a worker runs where the program ended in V8 with `Fatal error in HandleScope::HandleScope`. A worker can hold island objects, functions and errors, while a native function, object, promise or error, an island promise, a typed array, `Buffer`, `ArrayBuffer` or a symbol crossing between threads is refused by name with `ERR_SCRIPTC_ISLAND_WORKER_VALUE`.
  - A value that came from a Node island keeps the island's object under the type the program reads it through: an assertion or a declared type on an island value no longer makes a native copy, and a name bound to an island export, `this` in a native subclass of an island class and a parameter handed to an island keep their origin, with `SC6007` reported where a view cannot hold the type.
  - A union arm that fits several arms of the destination converts by its own discriminant and is refused by name (`SC2003`) where another value can still reach it, `Headers` supports iteration, a binding that a native module imports from an island package and exports again stays an island binding, and `Object.hasOwn` on an island object answers as Node does.
  - A UMD package and a package that only a literal `import()` reaches run in a Node island under the automatic policy, and a CommonJS function export keeps its own name.
  - `clearTimeout`, `clearInterval` and `clearImmediate` of an island's timer call Node's own function, so clearing an interval started in an island lets the process exit; in a program with islands the program's timer ids start at 2^52 so a number names one timer whichever side created it, an immediate takes its id from the timer sequence so `clearTimeout` on an immediate no longer cancels a timeout with the same number, and `process.chdir` goes through the island unit so island code resolves relative paths against the current directory.
  - A child process an island started can be held at the `ChildProcess` type: listeners register on the island's emitter, properties, methods and streams are the island object's, adoption happens at the checked conversion, and a listener that an earlier listener removes during an emit is still called in that emit.
- **Fixes:**
  - An `http.get` response with status 101 switches protocols only when it carries an `Upgrade` header and `Connection: upgrade`; any other 101 is an ordinary final response, and an upgrade with no `'upgrade'` listener closes the request instead of never settling.
  - `Promise.all` over promises of nothing fulfills with a real array holding one `undefined` per entry wherever the array can be read, and a missing array element passed to a function declared inside another function arrives as `undefined` instead of throwing `undefined is not representable in the target union`.
  - An uncaught `Error`, and an unhandled rejection whose reason is an `Error`, print the stack frames the Error captured, one `at` line carrying the function name and file, as Node prints its stack trace.
  - Four lowering bugs that emitted ill-typed IR, each ending as an `SC9001` internal compiler error on ordinary TypeScript, are fixed, and the final module of a 31,070-function program goes from 17 validator errors in 14 functions to 0.
  - An `in` test on a value that still has a union type answers from the value when no arm declares the key, and an instance of a program class that extends `Error` keeps its identity, class and fields when it is boxed from a union arm, so `key in view` and `Reflect.has` reach the error's own `stack` and `cause`.
  - A record argument is bound at its own layout when the callee writes through a narrower parameter or compares it by identity, so the callee's writes reach the caller's object as under Node, and `+=` on a string member of a checked-dynamic value lowers instead of reporting `SC1043`.
  - `typeof` of a value called through a `%call` slot answers `"function"` instead of `"object"`, so `typeof chalk`, `typeof chalk.green` and a union narrowed by `typeof x === "function"` match Node.
  - A recursive function or union type reached again through its own function arm ends the checked-dynamic conversion walk instead of overflowing the stack: compiling `yaml` 3.0.0-2 with eight casts for library declarations finishes in 11.7 s at 589 MB.
  - `new Proxy(target, handler)` is refused at compile time with `SC1090` when the handler arrives as typed storage, or the target is a class instance or an array, which were refused only once the statement ran.
  - A value that checker flow narrows to `never` is lowered as the live dynamic value, so a read no longer throws `TypeError: expected number`, and `switch (null)` and array or object destructuring from `null` or `undefined` follow Node's behavior instead of failing with an internal compiler error.
  - An LLVM backend refusal reports the statement and the function it was raised for, with the refused type, instead of the entry file's first byte.
  - A child handle wrapper is requested from a program's `childProcess` module fact rather than a text scan, so a corpus program's binary drops from 693,800 to 112,720 bytes.
  - Each shard object names its compilation units after itself, so a Darwin debug map tells one object's symbols from another's, and the island's pthread record names Node's stack for the life of each job, so `process.report.getReport()` no longer kills a program on macOS.
  - A build with `--optimization dev` reports the file, line and column of every stack frame, names the class members of a frame and prints the position for module-level code, for 16 bytes of every call and a 3.8% higher geomean over 57 benchmark workloads.
  - The executable cache keys a `--tier=static-only` build, so `scriptc build --tier=static-only` and `run` report SC2003 when the default build of the same file is cached, as a cold build does.
  - A comparison with `undefined` or `null` that folds to a literal still evaluates its other operand: calls, `await`s, getter reads, assignments, constructions and sequence expressions run once before the literal, `(f(), undefined) === undefined` is true, and `Object.is(f(), undefined)` runs the call. A missing array element at a slot the instance cannot widen throws the `TypeError` that slot throws instead of answering false.
  - `scriptc build` with `--optimization=speed` prints one warning per runtime pack built without the host LLVM codegen helper, naming the missing `speed` flavor and the release objects it links instead, and a dev build with `SCRIPTC_CONVERSION_TRACE=1` reports each failed checked conversion on stderr with the conversion's file, line, column and error, whether or not the program catches it.
  - A two-argument call whose callee resolves through `const` aliases to `Object.defineProperty`, `Reflect.defineProperty` or either `defineProperties` counts as a possible child addition, so `const define = Object.defineProperty; define(child, …)` no longer throws a `TypeError` at run time, and a keyed record write whose receiver can be `undefined` accepts a `null` or `undefined` value instead of failing with an internal compiler error.
  - An async function whose declared result is a concrete type adopts a returned checked-dynamic value that is a promise at run time: the caller receives the settled value converted to the result type, a rejection rejects the function's promise, and a value that is not a promise converts immediately.
  - Every runtime refusal for an operation that is not implemented carries a scriptc diagnostic code, so the 111 that named none print with the nearest compile-time code, and `DataView.prototype`'s `byteLength` and `byteOffset` accessors throw Node's `TypeError` for a view over a detached buffer or one that shrank below it instead of answering 0.
  - A write or `delete` through `(value as View)`, `!`, `satisfies` or `<T>` addresses the operand's object as Node does for dotted writes, dotted updates with `+=` or `++`, `delete` and a keyed write whose literal key names a member the operand's layout holds at the asserted type, while every other keyed write, update or short-circuit assignment through a converting assertion is refused by name with `SC1090`. `(p as any).k = v` writes a slot the record declares, and a write through an assertion to a record beside `undefined`, which was written to a converted copy, is refused with `SC1090`.
  - A `let` or field read before its assignment reads `undefined` as Node does instead of `0`, `false` or a fault: an unsettled binding takes `T | undefined` storage, a field takes the checked deferred-init slot, `??` and string conversion see the undefined slot, and a binding or field that is provably assigned first compiles as before.
  - `scriptc coverage` lists every checked conversion whose value is typed by something no build can verify, under `trusts unverified types` and as `typeClaims` in `--print=diagnostics`, one row per declaration, package, parsed-data type or untyped binding with the sites that trust it, and each declaration row prints the `scriptc types patch` command that fixes it; `--fail-on=type-claims` fails on them.
  - Every executable starts its small-object heap at a different address in every run, glibc executables bind their imports at load and keep the table read-only, and musl release executables carry no debug payload: a musl hello is 86,632 bytes instead of 1,835,384 bytes.
  - A record converted from a checked object keeps a declared property non-enumerable when the object held it that way, so `Object.keys`, `values`, `entries`, `for...in` and `JSON.stringify` leave it out as Node does, and a package boundary accepts a non-enumerable data property instead of refusing it.
  - A caught island error is read on the Node stack and released once the program drops it: a loop of 30,000 caught island errors prints the same counts in five runs of five instead of exiting 133 in four of five, and 100,000 caught errors hold 104,768 KiB with 49 island objects at exit.
  - Five wrong results of partial record views are fixed: an empty `{} as T` that is dropped no longer leaves its keys on the next view allocated at the same address, a write to a record-typed property the literal did not write keeps its value, a record or array stored in such a property is kept by reference, and a heap use after free in `scr_record_view_extras` is fixed.
  - In a program with a partial assertion, reading a required property that nothing wrote throws a catchable `TypeError` that names the property for a computed-key read, `??=` and `+=` on a keyed property, the `(groups[key] ||= []).push(x)` idiom and a spread, where these forms ended the process with exit 134.
  - `Reflect.set(instance, { toString() { … } }, v)` runs the key's `toString` once, a builtin function used as a value keeps one identity through every container and reports Node's `name` and `length`, and six meaning-preserving rewrites of 318 corpus programs that produced 17 internal compiler errors now compile and match Node or are refused by name with a source position.
  - `Readable.from` and `Duplex.from` over an instance whose `[Symbol.asyncIterator]()`, `async *[Symbol.asyncIterator]()` or `[Symbol.iterator]()` comes back through an untyped member build and match Node instead of reporting `SC9001`, and a program that holds a `node:http2` session or stream type and calls nothing from `node:http2` or `node:http` links, where it failed with `SC3004` and undefined references.
  - A union that flows whole into one of its own record arms converts each arm the checker still sees at the site, so an async function that returns `promise.then((r) => ({ ...r, extra }))` answers the callback's record instead of throwing a representability `TypeError`: of 455 cells, 394 match Node's output and exit code instead of 283. An arm with no conversion is reported where the flow is written with the diagnostic that arm's plain flow into the record gets, and a typed object with a callable `then` that is not a promise is refused with `SC1090`.
  - A build answered from the executable cache reports every warning the original build reported, and the launcher answers only the options a command takes: a cached `--fail-on=blockers`, `--range`, `--dry-run`, `--wasm`, `--explain-dynamic=x`, an unknown `--tier` or `--windows-subsystem` on another target now reports the full CLI's usage error instead of printing the path and exiting 0, and `scriptc coverage main.ts --tier=static-only --fail-on=blockers` no longer replays the default tier's verdict.
  - A class method read as a value checks its receiver whenever its source mentions `this`, so a call through `const f = logger.error` with no receiver throws a `TypeError`, and `(c.m)()`, `c.m!()` and `(c.m as F)()` call the method on `c`. `Object.create(...)` where a record type is expected is refused with `SC1090`, a program that holds `process` as a value is not compiled in workers mode unless its source names a worker API or `process.getBuiltinModule`, and `"code" in error` for an Error subclass that declares `code` answers true.
  - A file-scope JavaScript binding whose initializer is a computed read of `globalThis[KEY]`, a literal of plain data beside a checked arm of a conditional or logical expression, or an assignment into an untyped member is stored in its module and read by separately declared functions, including through an object shorthand and an export entry: in a family of 26 programs, 23 match Node against 16 before. A file that uses its own `import type` binding as a value and also has an import that elision drops reports `SC0001` at the use.
  - An internal compiler error or a checker panic in the body reports `SC9001` at the innermost expression being lowered and the build goes on with the rest of the program, a panic in a speculative whole-program analysis gives `any` for the node instead of ending the build with `SC0004` at line 1, `x instanceof C` where `x`'s type is a union with a class the compiler rejected is refused by name at the test, and a rest parameter typed as a fixed tuple and only forwarded into a method that some code replaces on an instance is built from its slots at the read.
  - The build-time load recorder reads only the arguments whose answer the engine gives without running program code: an options object that is not a proxy and holds no accessor, locales that are a string, an `Intl.Locale` or a plain array of those, the receiver and compared value of the String methods as primitives, and the parts and name of `new File()` as strings or buffers. `crypto.createECDH`, `crypto.getDiffieHellman`, `crypto.createSign`, the ECDH, DiffieHellman, DiffieHellmanGroup and Sign classes, and the `async_hooks` async id counters are not treated as functions that compute from their arguments, so a package that generates a key pair when it loads gets a fresh key in each run.
  - A spread of a record that kept its source object into an index-signature record copies every own key in the object's order, as Node does, and a build that stops at packages it can neither compile nor run in a Node island reports the program's own errors in the same attempt, with each refused package's hint naming the setting that would run it in Node.
  - A reference read out of a freshly made value keeps that value's group out of an arena, so `new Slot(rows()).held`, `rows()[1]` and the same read through a call's arena no longer read released memory in fully typed code, and the memory a `splice`, a `fill` or a push into an arena list held is released.
  - A compound assignment in a function specialized for a typed record argument keeps its operands in a release build: a record field is no longer stored as `NaN`, a right-hand-side call is no longer dropped, and a string `+=` no longer ends with SIGSEGV when a class also implements the parameter's interface. The specialized clone is made only where its operands evaluate in the same order and with the same effect as the original sequence.
  - A class that implements an interface with an optional member it leaves out is held in a union as the interface, so an instance of another class of that interface keeps its identity and its methods run with the real instance as receiver, and a class method read as a value answers its own name.
  - A function that a natively compiled package declares inside a function is a new object each time the outer function runs, so two instances are no longer `===` and a property set on the second no longer replaces the first.
  - A union type that reaches itself (`type Json = string | Json[]`, `type Nest = Nest[] | null`, or two aliases that hold each other) compiles where the compiler ended with `RangeError: Maximum call stack size exceeded` and no diagnostic.
  - A promise that settles while a collection runs no longer reads freed memory: the settle detaches its callback list before it runs the first waiter and frees the list at the end, so a program that holds several dynamic views of a typed promise and drops one before the promise settles matches Node where a release build exited 139 and a sanitized build reported a heap use after free. Executables that link the promise runtime grow by at most 0.05%.
  - An element or key read with `??` or `||` takes a result type that holds both sides, so `names[at] ?? null` answers the default when the read is absent instead of throwing that `null` is not representable in a `string` slot, and a default of a wider type is no longer converted into the left side's type. Where only a copy could place the default in the element's layout, a missing element stops with a `TypeError` that names the default and the build reports the site once (`SC6001`), and passing a class instance that has a base class to a record parameter no longer reports `SC6001`.
  - A module that re-exports a `const enum`, or a namespace of const enums, keeps the export a value export in import elision, for a specifier that names a local binding and for one that names another module's, and for `export default`, so a program that imports the re-exported name and uses a member as a value compiles. The names kept as values are reported in an `inlinedExports` field beside `inlined`.
  - A value that a callee builds out of the members of a freshly made list no longer outlives the list's arena: a holder that keeps two of the group's members stays valid, so a sanitized build no longer reports a heap use after free under `scr_arena_drop` and a plain build no longer writes into reused memory.
  - Executables link vendored zlib, brotli, zstd and mbedtls built with bounds traps, stack canaries and fortified libc calls, and the runtime units are built with zero-initialized small locals and stack-clash probes, so a read of an uninitialized small C local yields zero. Every executable grows, from 0.02% to 3.04% (median 0.33%), and run time is unchanged.
<!-- release:end -->

## 0.4.9

### Highlights

- **Faster programs:**
  - Typed-array and dense `number[]` loops run as lane loops: elementwise stores and dense sums, counts and stores run whole vectors and finish the remainder with the scalar loop. The typed-array benchmark runs 1.83x faster, and integer sums and counts 1.56x.
  - Typed arrays copy in bulk where the element kinds allow it: construction, `set()` and `TypedArray.from(view)` between typed arrays move same-width integer pairs with one `memmove` and convert every other pair in one loop. A `Uint8ClampedArray` over a decoded buffer runs 1.9x faster, at 1.19x Node's time instead of 2.39x.
  - A callee called in a loop with an array parameter of one known length is compiled for that length, so the loop loses a per-element hole guard: n-body at 50,000,000 iterations is 5.0% faster.
  - Byte loops that count a constant product and byte loops that index downwards are versioned on their trip count: 1.31x and 5.98x on probes of those shapes (1,305 ms to 1,000 ms and 1,140 ms to 190 ms).
  - Dynamic computed access has a faster path: the fasta benchmark port runs at 1.73x Node's time instead of about 3.2x, a byte-array store falls from 63.3 to 20.4 ns per operation, and an indexed `charCodeAt` from 172.0 to 90.2 ns.
  - `Buffer.write` with a latin1 or ascii encoding uses the word-wise encoder: a 16 MB write is 55% faster, from 3.9x to 1.75x Node's time. Indexed scans of long non-ASCII texts are 47-51% faster.
  - Untyped `process.stdout.write(text)` and `process.stderr.write(text)` calls reach one runtime call: 10,000,000 writes to `/dev/null` take 1.38 s instead of 3.13 s. The opt-in `--stdout-buffering` keeps console output in the 64 KiB buffer when stdout is not a terminal: 10,000,000 `console.log` lines to a pipe take 0.54 s instead of 6.3 s.
  - The collector does less work at collection points and sizes its nursery window from what it collects: channel-messages is 12.4% faster and worker-messages 5.9% faster. Object chunks of 1 MiB or more come from huge pages, an async function's statement frame stays out of a group when nothing in it awaits, and depth-21 binary-trees runs at 0.84 of its former wall time with 199 MB of peak memory instead of 253 MB.
  - Large immutable number tables are built in the program image, so a small CLI program starts in 1.21 ms instead of 1.51 ms. An optional-element array read skips the runtime getter (13% faster, 35% fewer instructions), and 200,000 calls through builtin function values take 4.6 ms against Node's 75.3 ms.
  - `--cpu-dispatch` copies only the functions whose body has a loop: 1.305x on mandelbrot and 1.068x on n-body against the default build.
- **Faster builds:**
  - A failing program's whole-slot relower runs on the pass whose result is kept, after the general-streams relower: a large program that takes the general-streams relower builds 1.22x faster (1,141.9 s to 932.5 s cold).
  - A build whose inputs did not change returns the executable already on disk, without reading a source, lowering, emitting LLVM, generating objects or linking: a no-change build takes 16.6 ms instead of 71.9 ms, 17.6 ms instead of 426.8 ms with an LLVM helper set, and 58.6 ms instead of 959 ms with a profile and an FFI manifest.
  - Runtime-pack selections and link-driver jobs are kept in the build cache: cold builds take 16.3 ms less on average over 369 paired builds.
  - Partition groups are numbered from the file name relative to the entry module, so a warm one-function edit that adds a module recompiles 3 of 64 partitions and the module-init pass is 19.5% faster.
  - A build's repeated frontend loads share one checker project, so parsed files carry between passes: a large multi-package program builds 15.9% faster (652.96 s to 549.05 s). Source parses are cached and declaration type queries batched (59,075 source-parser requests become 2,595), alias answers are memoized for one load (573,047 requests become 190,448), and npm-static package selection is memoized per build: in a separate pairing on the same program the build falls from 634.0 s to 404.6 s and the island reloads from 222.4 s to 188.1 s.
  - Lowering a large program reads each mapped symbol name once, builds union arm keys once per sort and answers the library-file question once per file: a large compiler build's coverage analysis falls 20.2%, from 1,360.20 s to 1,085.14 s.
  - A build of the compiler's own sources loads a 3.1-3.8 MB frontend graph instead of 15.7 MB, and one analyze and compile of a fixture falls from 111.9 s to 24.6 s. The bundled-library scan asks once per directory, 1.2 ms to 0.1 ms.
  - Windows release executables request no debug info: hello world is 146,432 bytes instead of 1,803,264 bytes. Analysis peak memory falls 8.7% on a 1000-module graph and from 1207 MB to 1053 MB on 3000 modules, and a macOS type check's peak memory falls 19.0-21.5% with compact class references.
  - Large shared buffers get a mapping of their own: a 16-checker type check's peak memory falls from 2856 MB to 2805 MB.
- **Node.js parity:**
  - node:dns lowers `lookup`, `lookupService`, `getServers` and the default result-order functions with Node's argument ladder, error codes and error properties, and its address, hint and error-code constants come from the target libc.
  - node:tls accepts `tls.createServer({ SNICallback })` without a default `cert`/`key` pair.
  - node:readline interfaces have `prependListener`, `prependOnceListener`, `removeListener`, `off`, `removeAllListeners`, `listenerCount` and `eventNames`, with removal by the registered function, and `question(query, { signal }, callback)` cancels on abort.
  - `process.allowedNodeEnvironmentFlags` is the target's `NODE_OPTIONS` flag names, `process` emits `'beforeExit'` and has `abort()`, and `ChildProcess` reports `spawnfile` and `spawnargs`.
  - child_process accepts stdio arrays past fd 2, `detached`, `options.signal` and `stdio: "inherit"`, and spawnSync's error carries Node's errno, code, syscall, path and spawnargs fields.
  - `Buffer#toJSON` returns Node's snapshot, `Blob#stream()` and `Blob#textStream()` return real ReadableStreams, `URL.createObjectURL`, `URL.revokeObjectURL` and `buffer.resolveObjectURL` share Node's table, and fetch sends Blob and File bodies as their bytes with the blob's type.
  - `url.Url` is Node's legacy constructor, strict-mode property writes name bigint and symbol receivers, `util.format` walks Error values for `%j`, and typed emits reach listeners registered through untyped values with `errorMonitor` first.
  - Native handles accept own properties, and a class instance's getter-backed fields read through its checked view.
  - `process.report` is answered by the Node island, node:test's context has `t.runOnly` and `t.waitFor`, and static builds read `/etc/passwd` for `os.homedir` and `os.userInfo` and throw Node's catchable `SystemError`.
  - The compatibility ledger records the implemented web globals, the `Headers` class and the node:diagnostics_channel surface against the programs that exercise them.
- **TypeScript parity:**
  - Every dynamic-to-typed conversion asks one predicate, and an optional record field whose type maps to the checked-dynamic slot can be absent, so `delete` works and an omitted field is absent to `in`, `Object.hasOwn`, `Object.keys`, `util.inspect`, `JSON.stringify` and spread.
  - `new Set(x)` and `new Map(x)` seed from a checked-dynamic iterable, and a Map or Set arm of a class field's undefined-armed union lowers.
  - A function's own properties use one representation, a class instance passed to a callee that reads its fields keeps its record shape, and accessor literals for intersections, unions and mapped types keep their checked-identity view.
  - Method calls on a union receiver with a primitive arm lower, `&&` spreads that drop the left operand's widened arm lower, `Promise.all` over a mixed armed-union array literal lowers, and `Object.assign` takes dynamic sources into index-signature records.
  - Overrides that append trailing optional or defaulted parameters, optional captures, computed keys and variadic function values lower.
  - Builtin members read as values compile: `Function.prototype`'s `call`, `apply` and `bind`, `RegExp.prototype`'s `exec`, `test` and `toString`, `DataView.prototype`, builtin functions carrying Node's `name` and `length`, and an `http.request` alias or a client chosen at run time.
  - Packages that declare their data shapes in declaration files compile, as do package module edges reached through literal `require()` and `import()` calls, a package's own JSON documents, and rest bindings from a CommonJS module's export names.
  - More JavaScript semantics compile in typed sources: BigInt operands of the arithmetic, shift and bitwise operators, symbol to string coercion, `Object.prototype.__proto__` on dynamic receivers, rest bindings over index-signature sources, and `delete` through an erased assertion.
  - Five diagnostics are admitted for JavaScript sources, and a project that checks its JavaScript still reports them.
- **CommonJS and islands:**
  - A constant-decided top-level `if` exports what its branch exports, a failed CommonJS initializer retries on the next `require()`, and a shared module's exported function exists before the module evaluates.
  - A local JavaScript import answers its runtime sibling through a typed sidecar, and shared exports publish between declarators.
  - An island's module tree stops at a type-only import, and type-only island edges ship as the no-ops Node erases.
  - A union type alias a package declares over Node data types lowers as the checked dynamic value, and a callable type from a types-only package stays the island's function handle.
- **Fixes:**
  - A nested marker table is a brand marker, so branded primitives stay `Map` keys. A parameter that shadows a builtin module alias is no longer reported as a patched module, and a generator declared to return `any` lowers instead of reporting SC2001.
  - A boxed union map value widens into a pointer-union `Map.get` result, a `TypeError` for a non-callable callee names the callee as V8 does, and the unwinding ABI check no longer counts a source-frame push as a pending-flag test.
  - The LLVM context is declared before the target machine in every partition compiler, which removes the intermittent aarch64 macOS dev build crash and timeout.
  - An own property written through a checked view of an `Error` subclass is kept, and a member read that only an asserted intersection declares answers what the object carries.
  - The child handle wrapper is installed only when the program links the child-process unit, and the stdio slot order program spawns `/bin/sh` so it runs on macOS.
  - SC3004 reports the LLVM helper's exit status or signal together with the output it wrote.
  - Reflection on a `Proxy` value answers its own keys again, and builtin prototypes and array-like `concat` match Node.

## 0.4.8

### Highlights

- **Faster programs:**
  - Counted loops run two iterations at a time where the iterations are independent: a single-file mandelbrot port is 39% faster.
  - A class whose instances form a tree, each node owned by one parent, keeps its nodes in the group arena that holds the rest of the tree, at 16 bytes per node instead of 24: a class-based binary-trees program is 20% faster and uses 33% less peak memory.
  - A dictionary update fuses its second hash probe into the write that follows (4.5% faster on dictionary walks), and number and identity-word map keys hash with one multiply instead of two (6.9% faster on number-key maps).
  - A run of dynamic property reads on one object shares one guard, untyped code calls typed records' dynamic parameters through specialized calls, and dynamic class tables dispatch on an indexed class key.
  - Compact class fields store 32-bit references to arrays, maps, sets and instances, so programs that keep many objects use less memory.
  - musl executables use an allocator built for the program they link into: across the runtime benchmarks they are 2.9% faster, line-by-line reading is 39% faster, and an HTTP server's peak memory falls from 34.6 MiB to 2.4 MiB. musl executables also use musl's string comparison and a faster `getenv`.
  - x86-64-v3 builds keep baseline copies of the program's functions.
- **Faster builds:**
  - The thin-LTO pre-link runs at the build's optimization level: a cold build of a large program is 2.4% faster, with the LLVM stage 10% faster and the same runtime speed.
  - The partition cache also covers builds that name their LLVM helper with `SCRIPTC_LLVM_HELPER`: a warm one-function edit of a large program rebuilds 13% faster in that setup.
  - A build shares one frontend services scope across its loads, memoizes type mappings per generic binding context, shares type-memo entries that read no type-parameter binding, and computes its preflight diagnostics once. Island rounds share their program facts across lowering passes.
  - LLVM partitions are sized from the host's threads as well as the module, the emission passes read their node scans from one recorded walk, and IR functions decode without a whole-document number reviver.
  - The LLVM helper's identity is checked once per install, the installed compiler package digest is reused, and edit builds keep less per-build bookkeeping. The native compiler's optimization profile is refreshed.
- **Node.js parity:**
  - node:path, node:url and node:os match Node 24. node:buffer matches Node 24's Buffer members, encodings and module surface. node:zlib adds the zstd API.
  - `util.inspect` supports `showHidden`, `numericSeparator`, `maxStringLength`, `maxArrayLength` and the `getters` option, `console.dir` supports `showHidden`, and errors print from their stack in `util.format`, `util.inspect` and `console.log`.
  - child_process lowers the shell forms, typed `spawnSync` options including `cwd` and `input`, the `cwd` option of the exec and execFile callback forms, and child stdio pipes typed as node:stream streams.
  - node:http applies Node's HTTP/1 parser checks, answers ClientRequest listeners, reports late Transfer-Encoding errors, and lowers the server `'clientError'` event and the URL-plus-options request form with `protocol` and shorthand `headers`.
  - `process.stdin` has its readable surface, readline accepts `process.stderr` output and runtime question options, and `getEventListeners` answers for EventTarget receivers.
  - ArrayBuffer transfer, detach and resizable or growable buffers compile. A cgroup CPU quota below one CPU is floored at one.
  - Node.js is pinned to 24.22.1.
- **JavaScript semantics (Test262):**
  - More early errors are reported, `RegExp` coerces its constructor arguments, and the async-generator `yield*` delegation protocol is implemented.
  - Class values honor `Symbol.hasInstance`. Promise statics accept a foreign constructor. Iterator helpers run on a live `Iterator.prototype`.
  - BigInt typed arrays work in the checked-dynamic tier, and builtin global functions and classes have values in JavaScript sources.
  - Generator parameters bind at the call, higher-order functions honor `thisArg`, pattern defaults take their binding's name, and object literals accept `__proto__` with any prototype value.
- **Node islands:** coverage lowers once with the islands the build proves, packages that are not opted in keep their JavaScript out of the inferred surface, and npm-static packages are classified only from real loads.
- **Correctness:** a record reached through an alias keeps writes made through either name when its shape widens under the shape overlay.
- **TypeScript:** more record, union and generic patterns compile, among them overload sets held as values, class overload declarations, unions of a class and its subclasses, `Object.assign` over a narrowed record arm, and partial record views that gain keys through dynamic writes.

## 0.4.7

### Highlights

- **Node.js parity:**
  - `Intl.Segmenter` splits text into graphemes and words, and `toLocaleString` uses the default locale, on Linux x64 (ICU 78.3). Malformed UTF-8 in directory entries and command-line arguments decodes to U+FFFD, as in Node.
  - node:http emits Node's abort events, matches Node's outgoing header behavior, and checks `http.request` options before a socket opens. Sockets after `setEncoding` pipe decoded strings, untyped listen ports are validated, and net errors carry Node's system properties.
  - node:querystring and node:string_decoder match Node 24 for values known only at run time, and node:path matches Node 24's path tests. `TextDecoder` matches Node's errors, options and printing.
  - `structuredClone` copies Maps and Sets. `SharedArrayBuffer`, `DataView`, `BigInt64Array`, `BigUint64Array`, `Proxy` and `Intl` can be read as values. `process.memoryUsage()` counts ArrayBuffer storage.
  - `import()` of a specifier that cannot be resolved rejects with `ERR_MODULE_NOT_FOUND`. fs reads return Buffers in programs that can observe the difference. Values held from `process.env` read the live environment.
  - EventEmitter and stream listeners are called with the emitter as `this`, listeners that read `arguments` receive every argument, and the leak warning is delivered at exit. `'error'` events accept non-Error payloads.
  - readline accepts listener values and ends lines at U+2028 and U+2029. `fs.watch` names the changed entry. `assert.throws` reports validation-object failures as Node does.
  - Executables ignore SIGPIPE and SIGXFSZ, as Node does. Timer deadlines hold on macOS, and intervals re-arm as in Node. Timeout delay warnings are emitted, and untyped timer delays convert with ToNumber.
  - `process.emitWarning`, `process.kill`, `process.chdir` and `os.userInfo` behave as in Node. Replacing `process.stdout.write` or `process.stderr.write` receives the arguments, Buffers and whole writes that Node passes.
  - JavaScript semantics from Test262: each evaluation of a class expression creates its own class, private static members check their brand, wrapper objects for strings, numbers and booleans work in JavaScript sources, and Set, Map and weak-collection methods can be read as values.
  - `for...in` runs over a value that may be null or undefined. A null or undefined destructuring source throws Node's TypeError. Functions held in records and arrays keep their names.
- **Node islands:**
  - Sloppy-mode modules and modules that patch builtins run in Node islands automatically.
  - Islands can `require` CommonJS modules and hold builtin classes, and garbage cycles are collected across the program's heap and Node's.
  - Island modules whose load is deterministic are deferred until first use, and shared modules resolve by real path, so caches reached through symbolic links work.
- **Faster programs:**
  - Untyped code calls methods of compiled class instances inline.
  - Integer arithmetic: sums built on unsigned shifts stay in 32 bits, and loops are versioned on the range of locals they write as remainders. Saturating loops that run together test their exit every fourth iteration.
  - Number-key map lookups test the direct index once and inline the probe in loops.
  - Streams: taking from a Readable's buffered queue is constant time, object-mode stream callbacks do less work per chunk and keep typed records unboxed, and a line goes to a single line listener directly.
  - fs streams read and write cached regular files on the loop thread, worker threads that allocate large blocks no longer reread the process's memory map, and constructors store their own fields without releasing a previous value.
  - `--cpu-dispatch` keeps x86-64-v3 code from running slower than the baseline.
  - Profile-guided builds compile the functions a profile never ran as cold code, and weigh profile matches by the profile's counts. The runtime profile is refreshed.
  - x86_64 musl executables use SSE2 memory routines and the runtime's rounding and libm definitions.
- **Faster builds:**
  - The native compiler's optimization profile is refreshed: its code is 63.0 MB instead of 73.9 MB, so builds use less memory and run faster.
  - Optimized partitions of builds without a profile run a lighter simplification before they are linked, and builds that use a profile keep the full one. Partition placement stays stable when an edit adds a small helper, so more partitions stay cached.
  - A compile reads and stats each file once and reuses its type checker across module loads, and finished checker processes no longer stay as zombies.
  - The type checker executable is written once, and builds with an empty cache no longer hash the runtime pack's artifacts again.
  - Large modules decide in one pass whether fs reads must return Buffers.
- **Memory and size:**
  - Programs return freed memory sooner: large strings are freed when they are released, writes of large shared views go out in chunks, and the main thread returns free pages when its event loop waits.
  - An HTTP response whose socket closes releases its completion callbacks, and the web view of an abandoned fetch body is released while its transfer runs.
  - Intl executables ship ICU data without the categories no Intl form reads (21.5 MB smaller), and the runtime pack is 24 MB smaller on Linux x64.
- **TypeScript:** an `import source` clause from TypeScript 7.1 is reported as unsupported instead of failing the build, and more record, union and generic patterns compile: spreads of unions with an absent arm, literal-union keys of one field type, partial record assertions, records cast from `unknown[]` elements, and `entries().filter` in generic bodies.

## 0.4.6

### Highlights

- **Node islands:** programs can load Node.js in-process on first use and run npm packages that scriptc doesn't compile in Node islands.
  - Native values, closures and promises pass into islands by reference, and island handles, classes and collections can be used from compiled code.
  - Modules are shared between a program and its islands, and island modules are evaluated only when the program uses them.
  - Once Node loads, the runtime's event loop runs on Node's libuv, and programs exit cleanly with Node loaded.
- **New options:**
  - `--exceptions=rare` unwinds through recursive functions instead of checking a status after each call.
  - `--static` builds static Linux executables (opt-in).
  - `--large-pages` moves executable code onto huge pages; `--cpu-dispatch` adds x86-64-v3 copies of hot functions.
  - Type patches replace a package's declaration files or supply missing declarations.
  - The shape overlay types JavaScript from facts the compiler proves (opt-in).
- **Faster programs:**
  - Exceptions raise through cached unwind plans on x86-64 Linux, and every native function has an unwind table entry.
  - Ordinary objects are stored as a layout plus value slots; unions of classes are the instance pointer itself; class instances that stay in their frame use frame storage.
  - Object groups that die together are allocated in arenas, and the cycle collector does cheaper trial deletion and adapts its nursery trigger.
  - The speed runtime is optimized with a committed runtime profile, and Math functions are computed as V8 does, with libm linked only when needed.
  - Loops: short constant-count loops run together, for and while loops are versioned on the ranges their locals enter with, counted loops unroll by the period of a guard, and small leaf functions called from loops are inlined.
  - Typed arrays: header fields are read once at a speculative loop's entry, products under bitwise operators stay in 32 bits, and shared typed-array elements are read and written with plain accesses at a counted loop's counter.
  - Strings: UTF-16 indexes of long non-ASCII strings map in constant time, ASCII case converts eight bytes at a time, template literals allocate at their exact length, and strings iterate over their bytes.
  - Untyped code: class instance fields are read inline at dynamic property sites with two inline-cache entries, native arrays iterate without type-name scans, and numbers pass to directly called untyped functions as JavaScript values.
  - I/O: fs thread-pool completions and pool-thread writes make fewer syscalls; sockets, clients and agent entries register in constant time; fetch() reuses keep-alive connections; web streams, WritableStream and TransformStream run natively.
  - Large executables map their text with 2 MiB pages, and freed heap pages are returned to the system after the frontend is disposed.
- **Faster builds:**
  - Small release and speed programs compile in balanced partitions, the entry module's top-level code gets its own partition, and unchanged partitions stay cached across edits.
  - Optimized executables that stay one partition generate code concurrently, and emission's workers stay busy.
  - The native compiler is laid out by context-sensitive profiles collected in two phases.
  - Type checking uses a shared tsc-ts server by default on Linux and macOS, and lib diagnostics are reused across options and module sets that cannot change them.
  - Rebuilds skip the helper version probe and the digests of unchanged files, and the CLI links without huge text pages, so cold builds use less memory.
- **Node.js parity:**
  - `Error.captureStackTrace`, Node's navigator, builtin globals read through the global object, and unhandled rejections reported in programs without async work.
  - node:zlib is built on the zlib Node bundles; `Response.clone` and `Request.clone` work on typed values; fetch bodies have the members of a web ReadableStream; redirects whose chunked body has not ended are followed.
  - Classes that extend Array compile; strings spread into their code points; frozen checked records stay frozen; sloppy-mode `this` is the global object.
  - `util.format` runtime format strings, `inspect.custom` and colors, and untyped `promisify`.
- **TypeScript:** scriptc reads TypeScript 7.1's binary AST format and API server beside 7.0's, and tsc-ts is updated to 0.0.10.

## 0.4.5

### Highlights

- **Fixes:**
  - Release builds read a typed array's length without a header load that could read a freed view.
  - `net.Socket` `write()` returns Node's backpressure boolean and fires `'drain'`.
  - Super calls in JavaScript method values call the declared base method.
  - Calling a non-function through an asserted callee throws Node's TypeError.
- **Faster programs:**
  - Exceptions propagate by unwinding from directly called functions on Linux, instead of status checks after every call.
  - Typed-array loops prove their bounds and keep their views disjoint in more cases, including views over shared memory in worker programs; integer loops stay in integers across nested counted loops, pure helper calls, powers of two and byte reads.
  - Lone array callbacks run as loops with their bodies inlined, and row sums run two rows per pass.
  - Number-key maps look keys up on their integer view and write updates through the entry the read found; small number-key maps use a direct index.
  - Strings: base64 decodes eight characters at a time; Buffers fill, swap byte order and decode `utf16le` a word at a time; readline splits input in one scan; string scans over non-ASCII strings use their UTF-16 units.
  - Untyped code: property caches also cache absent properties, object literal members go through the store caches, calls on plain arrays skip the method ladder, and dynamic values dispose without key-cache walks.
  - JSON parses into discriminated unions, and dynamic values convert into nested unions, in one pass.
  - BigInt division settles quotients from the top limbs, and limb shifts are vectorized.
- **Faster builds:**
  - Function bodies are emitted on up to eight workers, including in dev builds, and repeated work in LLVM module emission is cut.
  - Linux executables link with lld when the driver finds it, and unchanged executables are reused without selecting the runtime pack.
  - Dev builds reuse their frontend output after edits that keep token positions, and unchanged frontend inputs are checked by file identity before hashing.
  - Lowering fetches only the syntax trees it reads, and the large compiler tables are built on first use.
  - Release builds of the native compiler use a profile collected on the release commit.
  - Type checking can use a tsc-ts server shared by later builds (opt-in).
- **Node.js parity:**
  - Crypto: RSA key generation lengths, RSA-PSS keys, encrypted private keys, `X509Certificate` fields and methods, and TLS certificates and `tls.Server` contexts.
  - zlib: Brotli compression and decompression.
  - Dates are mutable objects with Node's setters and conversions; URL hosts and paths parse as the URL Standard does, including non-ASCII hosts with UTS #46.
  - `Math`, `JSON` and `Reflect` are real objects in JavaScript; objects can inherit from JavaScript class prototypes; typed arrays held as untyped values support named properties and `Symbol.species`.
  - Error messages: `JSON.parse` syntax errors use V8's messages and positions; `Object.getPrototypeOf` of an Error answers `Error.prototype`.
  - `util.inspect` of dynamic classes, functions and `%o` arguments, and `Symbol.toStringTag` fields and getters, match Node.
- **npm packages:** more npm and CommonJS dependencies compile statically, including namespace-style packages with guarded declarations and `var` exports, and untyped Maps, Sets and arrays are typed from their uses.

## 0.4.4

### Highlights

- **Fixes for 0.4.3:**
  - Unchanged rebuilds hit the frontend cache again. An unchanged rebuild of a 23-module program takes 93 ms instead of 1.26 s, and of tsc-ts (dev) 1.6 s instead of 58.2 s.
  - The native compiler builds programs with several typed-array accesses at one masked index in a loop again, including tsc-ts's release build, which failed with SC3004.
  - `x!` returned from a function, used as an arrow function's result, or passed as an argument keeps null or undefined when the destination type holds it, as JavaScript does. `x!` operands of `+`, `+=` and other conversions that hold undefined or null convert as Node does.
  - Effect 4 programs whose generators yield clients built by other generators run again.
  - The cache for untyped property access in programs that declare classes is reverted, fixing a crash in Effect 4 observability programs.
- **Faster:**
  - Number compares and typed-array indexes use the exact integer of sums like `i + 1`: a heap sift-down over an `Int32Array` runs 17.5% faster.
  - glibc's per-thread heaps use huge pages: the VS Code type-check runs 3.4% faster.
  - Mid-size executables (over 1 MiB of LLVM text) build in at least eight partitions: the LLVM backend phase takes 34 to 74% less time for three.js programs of 1.4 to 7.8 MB.
  - JavaScript class instances are boxed at their exact class, and stores into nested string-keyed dictionaries keep class method calls direct.
  - `--target-cpu` selects an x86-64 microarchitecture level.
- **Node.js parity:**
  - X25519 keys and `crypto.diffieHellman`; `existsSync` and `fs.promises` accept `file:` URLs; `Buffer.from` ranges over ArrayBuffers, the deprecated `Buffer()` constructor and `Buffer` as a value.
  - Dates are objects with identity; `Promise.all` over different entry types settles on Node's turns; completion callbacks run in their call's AsyncLocalStorage context.
  - TypedArray methods run on typed arrays held as untyped values, and unions of typed-array classes compile. Borrowed `TypedArray.prototype.set` calls compile and throw Node's TypeError for other targets.
  - Split CommonJS `require` bindings, `__`-prefixed exports, string-key destructuring of `any` values, and record key order for values JavaScript built.
- **npm packages:** zod 4 and `@hono/zod-validator` values are projected at the declaration boundary.

## 0.4.3

### Highlights

- **Faster checking and smaller builds with tsc-ts 0.0.9:** scriptc checks with tsc-ts 0.0.9, and builds reuse the bundled declaration files' diagnostics instead of checking them again. Small IR builds are 10.6 to 16.0% faster and small executable builds 5.5 to 7.6% faster, with identical output. A native build of tsc-ts with this release checks 0.4 to 6.6% faster than with 0.4.2 and peaks 4 to 16% lower.
- **Integer arrays and loops:**
  - Number arrays that only hold int32 values use 4-byte slots in locals, across direct calls and in module globals, and loop-carried locals written from their elements stay int32. A workload that walks arrays of cursors runs 54.5% faster.
  - Loops with two counters closing in on each other (`for (let i = lo, j = hi; i < j; i++, j--)`) and element copies through `a[i]!` run without per-element checks, and two-counter `while` loops run on integer counters.
  - Loops over typed arrays and charAt scans are versioned on their bounds, and ASCII strings are scanned as bytes.
- **Less work for untyped and dynamic code:**
  - String-keyed record reads under `??` and `!` no longer allocate: a dictionary-walking workload makes no union boxes instead of 363,359 and runs 12 to 15% faster.
  - Checked-dynamic method calls dispatch on method ids, observed class methods call natively while their slot is unchanged, and calls on bag-tracked class instances skip building their views.
- **Node.js parity:**
  - `crypto.getCipherInfo`, AES-CCM, AES key wrap, the legacy `createCipheriv` modes, `checkPrime`/`generatePrime`, and Node's argument checks for `generateKeyPair`.
  - Streams: `construct`, `writev`, `decodeStrings` and `defaultEncoding`, including `writev` on `Transform` and `PassThrough`.
  - `FinalizationRegistry`, `new.target`, `String.prototype.at` on untyped values, `Error.stackTraceLimit`, `spawnSync`'s `env` option, and class constructors called through `call`/`apply` throw Node's TypeError.
  - Records enumerate in the key order their object literal wrote, and objects converting to a union with an empty-record arm keep every field.
- **npm packages:** zod 3 compiles natively and zod 4's core runs, minified packages such as marked compile, chalk 5 and hot-shots 8 build from built-in shims, and `@hono/node-server` 2.x is built in. User code types npm package declarations at a checked, identity-preserving boundary.
- **Builds:** the cached build is reused after whitespace and comment edits, function bodies are emitted on forked workers, and the LLVM emitter reads its analyses from one recorded walk of each module.

## 0.4.2

### Highlights

- **Faster builds of large programs:**
  - scriptc checks with tsc-ts 0.0.7, which answers contextual types and resolved signatures in batches, so lowering asks for them in one request per chunk instead of one per node. A native build of tsc-ts is 7% faster (110.5 → 103.5 s on 8 vCPUs, lowering 12% faster), with an identical executable.
  - The native compiler is built with profile-guided optimization, so tsc-ts builds 6.9% faster cold and 10.7% faster after an edit.
  - The native compiler's optimization profile is refreshed, so a native build of tsc-ts is a further 10% faster (124.7 → 111.7 s on 16 vCPUs), with lowering 17% faster.
  - The class dispatch passes index their receivers by name instead of testing each one, and they reuse their per-function scans while a function's body is unchanged.
  - Checker replies resolve objects the compiler already holds from their ids without decoding them.
- **Leaner builds:**
  - The frontend of an optimized executable's first build runs in a child process, so the native code generator starts after its memory is released. The cold build of tsc-ts peaks at 2.21 GB instead of 3.30 GB.
  - The compiler collects its heap as lowering and LLVM emission grow it.
- **WebCrypto:**
  - The `crypto` global, `node:crypto`'s `webcrypto` and `crypto.subtle` are one object.
  - `generateKey`, `importKey`, `exportKey`, `encrypt`, `decrypt`, `deriveBits`, `deriveKey`, `wrapKey` and `unwrapKey` cover HMAC, AES-GCM, AES-CBC, AES-CTR, AES-KW, PBKDF2, HKDF and JSON Web Keys.
  - `crypto.subtle` signs and verifies with ECDSA, RSASSA-PKCS1-v1_5, RSA-PSS and Ed25519.
  - All of it follows Node 24's argument conversion, algorithm normalization and `DOMException`s. jose's symmetric JWE paths run as in Node.
- **JSX:** `.tsx`, `.jsx` and JavaScript files with JSX compile under the project's `jsx` options.
  - `react`, `react-jsx` and `react-jsxdev` lower to the factory calls TypeScript emits, with the same keys, fallbacks and source positions.
  - `preserve` and `react-native` are refused with a named diagnostic.
- **Faster worker messages:**
  - A message is encoded into one block sized to its contents.
  - A typed record is posted from its fields.
  - A `'message'` listener with a typed parameter builds it from the message, without a checked-dynamic copy.
  - Messages between `MessageChannel` ports take 90 ms where they took 250 ms in 0.4.1 (Node: 337 ms), with a peak RSS of 45 MB instead of 115 MB.
- **Loops over typed arrays vectorize:** a loop to a typed array's length keeps one bounds test for every typed array it indexes.
  - Index temporaries such as `const j = i * 4` are computed as integers.
  - Uint8ClampedArray stores convert inline.
  - Row-major index terms such as `r * cols + j` are tested once before the loop.
  - Typed-array callback methods call a literal callback directly on an integer counter.
  - An 896 × 896 matrix-vector product with four accumulators takes 55 ms instead of 396 ms (Node: 275 ms). `Uint8Array.map` is 4.5 times as fast and `Int32Array.some` 7.8 times as fast as in 0.4.1.

### Features

- **Asymmetric keys and signatures in `node:crypto`:**
  - `generateKeyPair`, `generateKeyPairSync`, `createPrivateKey` and `createPublicKey` handle RSA, EC and Ed25519 keys in PEM, DER and JWK.
  - `sign`, `verify`, `createSign` and `createVerify` sign and verify with those keys, with Node's output and errors.
  - Ed25519 verification matches Node on 2,083 test vectors, including small-order and mixed-order keys.
- **`crypto.createDiffieHellman`, `crypto.getDiffieHellman` and `crypto.createDiffieHellmanGroup`:**
  - The modp1, modp2 and modp5 to modp18 groups, explicit primes and generators, and generated safe primes are supported, with Node 24's key widths, `verifyError` bits, key range checks and errors.
  - Secrets of 0, 1 and p − 1 are rejected, and so are peer keys outside the RFC 5114 subgroups.
  - Primes longer than 8192 bits are refused.
- **TLS:**
  - `tls.connect` and `tls.createServer` negotiate `ALPNProtocols`, and both sockets report `alpnProtocol`. `minVersion` and `maxVersion` bound the handshake, and `getProtocol()` reports the version it picked.
  - `tls.createServer` takes an `SNICallback` that answers a `SecureContext` synchronously or later.
  - `new tls.TLSSocket(socket, { isServer: true, ... })` and `tls.connect({ socket })` run the handshake on an open socket, such as an HTTP `CONNECT` tunnel.
  - A client whose peer closes before the handshake completes fails with Node's `ECONNRESET`.
- **Streams:**
  - Readable, Writable, Duplex, Transform and PassThrough streams take `objectMode`, `readableObjectMode` and `writableObjectMode`, and an object-mode side carries any value through `push`, `write`, `pipe`, `pipeline`, `for await` and `'data'` listeners.
  - `_write` and `_transform` receive the encoding argument as Node passes it.
  - `Cipheriv` and `Decipheriv` are Transforms: they can be piped, used as `pipeline()` stages, read and iterated.
  - `pipeline()` accepts function stages anywhere among its streams, and an array, a string or a synchronous generator as its source.
- **Packages compiled from their JavaScript:**
  - js-yaml and smol-toml compile statically and match Node: ES5 error constructors (`Object.create(Error.prototype)`, `Error.call(this)`, `Error.captureStackTrace`) and classes extending `Date` behave as in Node.
  - TypeScript's UMD module wrapper compiles as the module body, and tsc's `__importDefault` and `__importStar` helpers around builtin modules compile as plain `require()` calls.
  - Interfaces, type aliases and enums that only a package's `.d.ts` declares keep their types.
- **JavaScript sources:**
  - Error constructors can be read as values, so `err.constructor === TypeError` works.
  - `workerData` can be destructured.
  - Unary `+` converts unions of strings, numbers, booleans, `null` and `undefined` as `Number()` does, so `+process.argv[2]` compiles.
  - These compile and behave as in Node:
    - chained readline listener registration;
    - `Number.parseInt` without a radix;
    - `match` and `search` with a possibly undefined regular expression;
    - `Buffer.from` over an untyped `ArrayBuffer`, with its byte offset;
    - Atomics on untyped arrays.
  - Buffer methods run on Buffers held as untyped values.
- **`fs`:**
  - The synchronous functions (`readFileSync`, `writeFileSync`, `statSync`, `readdirSync`, `mkdirSync`, `rmSync`, `openSync` and the others) accept `file:` URLs wherever they accept a path, with Node's conversion errors.
  - `fs.promises.rm` takes `recursive`, `force`, `maxRetries` and `retryDelay`, and removing a directory without `recursive` throws Node's `ERR_FS_EISDIR`.
- **`TypedArray.of`** creates a typed array of its arguments, and a dynamic iterable spread into `Array.of`, `push` or `TypedArray.of` is drained through the iterator protocol.
- **Global `isFinite` converts its argument with ToNumber,** as `isNaN` does. The Math functions and `String.fromCharCode` evaluate every argument before converting any.
- **`Object.freeze`, `Object.seal` and `Object.preventExtensions` of a function** act on its own properties, and `Object.isFrozen`, `Object.isSealed` and `Object.isExtensible` answer for functions. @noble/hashes' frozen hashers work.
- **EventEmitters used through both typed and untyped references** share one listener list. An untyped `emit` reaches typed listeners, an untyped `emit('error')` follows Node's contract, and `listenerCount`, `eventNames`, `listeners`, `rawListeners`, `removeAllListeners`, `setMaxListeners` and `getMaxListeners` work on untyped values.
- **Template literals, `join`, `Array.prototype.toString` and the default `sort()`** call an object's own or inherited `toString`, as `String()` does, instead of printing `[object Object]`.
- **Classes and generics:**
  - A generic factory declared to return a constructor type can return one of its local classes, including an anonymous class expression, and `class X extends factory(...)` extends it.
  - Static methods of a function-local class compile.
  - Constructor types declared in the program (`new () => unknown`, types that also name static members, construct overloads) hold class values.
  - Members typed by a conditional type over a literal class type argument (`Field<string, "required">`) resolve.
  - Object literals under an erased generic member may hold callbacks with optional or defaulted parameters.
- **Assignment and update targets wrapped in parentheses or non-null assertions** (`(x) = 1`, `h.sums[k]! += 10`) compile.
- **Untyped values keep what JavaScript code adds:**
  - Properties that untyped code adds to a typed object literal stay on it.
  - Named properties written to an array through an `unknown` view stay on the array, and `for...in` visits them after the indices.
  - An `unknown` value asserted to a structural type with methods keeps its class's methods.
  - The type inferred from an empty object literal holds any non-nullish value, as TypeScript's `{}` does.
- **A WebAssembly module the build finds but does not translate** rejects with a `CompileError` that names the reason, for example a proposal outside the translated feature set.
- **SC6101 names the functions that likely run often and use untyped values:**
  - It shows up to five, most likely hot first, with why their values are untyped: an `any`, an untyped `JSON.parse` result or an untyped JavaScript file.
  - `scriptc coverage --fail-on=dynamic` fails on it, and `--no-dynamic-tier-warning` leaves it out.

### Performance

- **Regular expressions skip start positions that their leading character sets rule out,** testing 16 positions at once. Searching 50 MB of text for nine case-insensitive alternations takes 0.83 s instead of 3.88 s (Node: 4.38 s).
- **Loop counters stay integers in more loops:**
  - Counters that step beside a counted loop's counter (`for (let i = 0, p = 0; i < n; i++, p += 4)`) stay integers: a pixel-stride loop takes 114 ms instead of 340 ms (Node: 190 ms).
  - So do two counters that close in on each other (`lo++, hi--`), 17% faster on a permutation-reversal loop.
  - So do counters of loops bounded by a string's length or by an invariant limit other than an array's length, and while-loop counters that nested scans advance. A non-ASCII lexer is 9.5% faster.
- **Loops that call a known callback** test its closure once before the loop and call the function directly, so captured `let` bindings stay in registers. `forEach` sums with a captured accumulator are 25 to 55% faster.
- **A speculative integer loop whose check fails** finishes the iteration outside the ordinary loop, which stays optimizable, and a loop site that keeps failing stops trying. With the hole-free-prefix test that element reads now take first, a pairwise loop over an array of class instances with number fields is about 1.25 times as fast as in 0.4.1.
- **Typed arrays over a SharedArrayBuffer** read and write elements inline as relaxed atomic accesses. A numeric kernel over shared `Float64Array`s takes 0.78 s instead of 1.56 s (Node: 0.84 s).
- **`Math.pow(2, n)` for integer exponents** builds the result from its bits. A counter that masks with `Math.pow(2, length)` takes 11.0 s instead of 20.4 s.
- **Async calls that never suspend run in place,** and so does `await Promise.all` of such calls, with Node's microtask turns and rejection handling. An async pipeline takes 5.5 ms instead of 9.7 ms.
- **Strings:**
  - `Number()` of a short integer string returns the integer directly.
  - `split` builds its result in one inline block, and `indexOf` and `slice` on ASCII strings skip the UTF-16 index map. A log summary is 20% faster.
  - `charAt` and `s[i]` on ASCII strings read the character from a table.
  - Chains of one-character `replace` calls (the HTML-escape idiom) replace a block of 16 bytes at a time, 12.8% faster on a template renderer.
- **`JSON.parse` and `JSON.stringify`** scan whole words and append parsed typed arrays in bulk, 22% faster to parse and 10% faster to stringify records.
- **Smaller arrays, maps and program-lifetime instances:**
  - The array header is 32 bytes instead of 48.
  - Arrays of up to 16 known elements keep their slots in their own block.
  - Arrays of a known final length get exactly that capacity.
  - Small map entry arrays grow in finer steps.
  - On Linux, `ProgramLifetime` instances take a 32-bit header and are referenced in 4 bytes.
  - They lower the peak memory of a large TypeScript type checker: the 4-byte references alone take a large project's check from 4.13 GB to 3.75 GB, and the 32-bit header saves a further 5%.
- **Worker messages queued together are delivered in one batch** before immediates run. 20,000 messages interleaved with a worker's output drain in 0.5 s instead of 5.6 s (Node: 0.57 s).
- **The cycle collector** never buffers instances of classes whose fields hold nothing cycle-capable, and its per-object paths are shorter. A workload of cyclic graphs is about 5% faster.
- **Array helpers specialized for a callback that cannot throw** skip the pending-exception test, 4.5% faster on a functional pipeline.
- **Compile time:**
  - A file's function declarations are walked once for their references, so lowering a 10 MB single-module bundle takes 69 s instead of 219 s.
  - LLVM emission computes its module facts once, 6.9% faster on tsc-ts.
  - AST walks visit subtrees by their node ranges and read node words through a `Uint32Array`.
  - Program builds no longer import runtime bitcode, so builds through Node and through the native compiler produce identical executables.

### Fixes

- **Member reads and method calls on an array hole** held in a binding narrowed to one arm of a wide union throw Node's `Cannot read properties of undefined` TypeError.
- **`AsyncLocalStorage`:**
  - A store entered before an async function's first await, or in a body that never suspends, is the caller's store after the call.
  - Each synchronous generator step runs in its resumer's context, as in Node.
- **Generic arrow and function-expression bindings used before their declarations** behave as in Node, including the `ReferenceError` of a `let` or `const`.
- **Assignment expressions into a module `let` declared without an initializer** (`new Promise((r) => (resolve = r))`) store the value instead of throwing a `ReferenceError`.
- **The `extends` expression of a class defined inside a function** is evaluated each time the definition runs.
- **A `super()` call that leads an `if` condition's comma chain** compiles.
- **A catch binding tests `instanceof`** correctly for values thrown as `unknown`, rejected promises and runtime errors.
- **zlib callbacks receive `undefined` as their result when the operation fails,** as in Node, and a callback may assign a fallback to it.
- **`Readable.push` and `Writable.write` with `string | null` or `Buffer | null` chunks** no longer crash.
- **Object literals keep their key order** through compiler rewrites and on shapes a typed `JSON.parse` also builds, so `JSON.stringify`, `Object.keys` and `console.log` match Node.
- **`console.log` prints class instances with their class name** in programs that test `instanceof` on unknown values.
- **`String`, `Number` and `Boolean` passed to array methods** convert as their direct calls do, and nested array literals in a recursive JSON-style union build.
- **A dynamic method call that the program also reads through a prototype** finds the method when the instance's property bag does not hold it.
- **Storing an element on `Array.prototype`** fails with SC2020, because holes in native arrays do not read inherited elements.
- **A recursive type alias in a generic signature** no longer crashes the compiler.
- **A `Buffer` view of an untyped typed array** compiles.
- **JSX programs checked with tsgo** compile as they do with tsc-ts.
- **Two programs whose entries share a name and build into one directory** no longer share a cached translation unit, so a later cache hit always relinks the right program.
- **A warm build whose cached LLVM exceeds the engine's string limit** reads it in parts instead of failing with `Invalid string length`.
- **The same program compiles to the same executable wherever it sits on disk** and whatever order its functions lower in, and edits outside a declaration do not rename the helpers and closures inside it.
- **Libraries that use untyped byte arrays** link.

## 0.4.1

### Highlights

- **Profile-guided optimization:** `scriptc build --profile-generate` builds an instrumented executable, `scriptc merge-profiles` (with `--sparse`) merges the profiles its runs write, and `--profile-use` optimizes a release or speed build with the merged profile. tsc-ts built with a profile from its own type check checks other projects 1.15 to 1.2 times as fast, with the same diagnostics and memory. Builds without a profile are unchanged.
- **Faster cold builds of large programs:** large class-based programs build in partitions instead of as one module, so their cold builds are 25 to 32% faster, and an edit to one function recompiles only its partition.
- **npm packages:** more packages that pass builtins, classes and promises around as values now compile from their JavaScript. Among them are execa 5, hot-shots, @opentelemetry/api, async-sema, buffer-crc32, yazl, tar-stream, smol-toml and truncate-utf8-bytes. `undici` 5.x and 7.x compile from an implementation that ships with scriptc, and `isarray`, `safe-buffer` and `process-nextick-args` compile as the Node builtins they stand in for.
- **Dynamic-tier property access goes through per-site inline caches** keyed on object shapes. On constructor-and-prototype code, the code that reads several object shapes at one site and an AST interpreter, untyped code runs 1.4 to 3 times as fast as in 0.4.0. Typed programs compile to the same code as before.
- **Smaller arrays, class instances and number-keyed maps:**
  - The array header is 48 bytes instead of 64.
  - Small arrays start with three inline slots.
  - Instances of program class hierarchies keep their class id in the reference-count word instead of a vtable pointer.
  - `Map`s and `Set`s with number keys store 16-byte entries.
  - Together they lower the peak memory of a large TypeScript type checker by 8 to 10%, with the same output and wall time.

### Features

- **`for await` iterates untyped values,** including async generators, `Symbol.asyncIterator` results and synchronous iterators, whose values are awaited. `yield*` delegates inside async generators. A JavaScript generator whose return type is inferred as `any` compiles, including one that delegates to itself.
- **`crypto.createECDH` and `ECDH.convertKey`** are supported for the 11 short Weierstrass curves mbedTLS implements, with Node 24's key formats, encodings and errors. Other curves are refused.
- **`undici` 5.x and 7.x:** `Client`, `Pool`, `Agent`, `request`, the global dispatcher, `fetch` through a dispatcher, the error classes and the `undici:` diagnostics channels follow each version's behavior. Each importing package compiles against its own installed version. The limitations page lists the parts that differ.
- **Packages marked as never loaded:** `"scriptc": { "packages": { "<name>": "unloaded" } }` in the entry's `package.json` makes `require("<name>")` throw Node's `MODULE_NOT_FOUND`, so optional dependencies take their absent branch.
- **`util.promisify` of an untyped function** returns a promise-returning wrapper at run time.
- **Destructuring with runtime computed keys** (`const { [name]: v } = source`) reads records and untyped values. A missing key gives `undefined` and the element default applies.
- **Import cycles compile when a class is used only after both modules finish initializing.** Reaching the class earlier throws Node's `ReferenceError: Cannot access 'X' before initialization`.
- **`await` of an untyped value adopts thenables,** including objects that define `then` at run time. `Promise.prototype` and `promise.constructor` can be read as values. A child process can be given new properties and awaited as a thenable.
- **Function values convert their results and arguments** when they are stored in a slot whose signature has the same structure but a different shape, such as a function returning `Promise<Message>` stored in a `() => Promise<Message | undefined>` slot.
- **Declarations from SDKs and shared type packages:** index signatures of `any`, `any[]` members, classes that a package only declares, and `Pick` views of classes compile.
- **Builtins as values:** `bind`, `call` and `apply` work on builtin functions, and `Buffer.byteLength`, `Buffer.compare`, `Buffer.alloc`, `JSON.parse`, `fs.realpathSync` and `String.prototype` methods can be read as values. `events` and `EventEmitter` can be used as untyped constructor values.
- **JavaScript sources:**
  - Bitwise operators convert boolean operands as `ToNumber` does.
  - `arguments.length` can be read in sloppy-mode functions with named parameters.
  - A function value in an untyped slot may have any signature.
  - Prototype methods take their JSDoc parameter types.
  - A top-level function declaration that its module reassigns works.
  - A `var` can be overwritten with a different kind of value.
  - A default-export object literal can hold class values.
- **Index-signature records answer `"k" in record`** for literal keys. A fresh array literal spreads into an array of a wider element type. A `const` annotated with a type that resolves to `any` holds an untyped object.
- **`Set.prototype.add` returns the Set** when its result is used, so `s.add(a).add(b)` compiles.
- **`exec` works on regular expressions held as `any`,** and a numeric enum from a package can be read by a runtime key (`DiagLogLevel[level]`).
- **`dns.lookup` answers that are decided at run time** can be read as untyped values, `net.connect` accepts Node's `lookup` option, and `dns.lookup` passes the `ADDRCONFIG`, `V4MAPPED` and `ALL` hints.
- **`util.inspect`, `console.log` and `util.format` print program-declared `Error` subclasses** with Node's constructor-name header (`[Plain [Error]: m]`).
- **Typed arrays:** `forEach`, `map`, `filter`, `some`, `every`, `find`, `findIndex`, `findLast`, `findLastIndex`, `reduce` and `reduceRight` compile on every typed-array kind. `map` and `filter` return the receiver's kind (a Buffer for a Buffer), and callbacks receive the element, index and array. `BYTES_PER_ELEMENT` reads answer the element size, including on untyped values. Reads and `in` tests of members Node 24's typed-array and Buffer prototypes lack answer `undefined` and `false`, as in Node. Destructuring assignment into typed-array elements compiles.
- **`Math.max` and `Math.min` with spreads among other arguments** (`Math.max(...xs, 5)`) compile, with Node's NaN and ±0 rules.
- **Generic arrow and function-expression bindings inside functions** compile when they use nothing from the enclosing function's frame.
- **`const xs = []` inside a function** takes the element type its later writes give it, as TypeScript evolves it, instead of `number[]`. Bindings whose reads disagree or that are reassigned become dynamic arrays, as at module scope.

### Performance

- **Loop counters stay integers in more loops:** counters compared as `i + c` with a bound, and for-loop counters that are reset or copied inside the loop. A record-boundary scan takes 104 ms (Node: 260 ms), and a typed-array scan takes 318 ms (Node: 801 ms).
- **Indexed reads of non-ASCII strings are inline in worker executables,** and strings of up to 2^24 UTF-16 units keep their unit table. A lexer over a 2.7 MB non-ASCII source takes 190 ms (Node: 327 ms).
- **Worker messages:** a thread that finds its mailbox empty spins for up to 20 µs before it blocks. 100,000 round trips between the main thread and a worker take 360 ms, a quarter of Node's time.
- **Local-time `Date` getters cache the zone offset,** UTC getters reuse the last decomposition, and integers 0 to 99 convert to strings without allocating. Local-time date formatting takes 0.81 times Node's time.
- **Untyped code:** `%` and the bitwise operators run on integers for integral operands, `o.x += d` updates a number property in place, and array `length` reads answer from the element count.
- **Sorts by several keys** (comparators that chain field differences with `||`, including optional number fields with a default) sort by key in the runtime instead of calling the comparator, about 24% faster on a benchmark of such sorts.
- **Worker executables start their threads faster:** the allocator marks its memory for core dumps only when the system would write a core, which removes about 680 calls that hold the address-space lock as threads start. tsc-ts checks tRPC 6% faster at 16 checkers.
- **The native compiler walks IR without a closure per node,** about 3 to 10% faster in the frontend and LLVM emission phases of large builds.
- **Full cycle collections that the death rule requests run at the event loop's idle moments.** Watch-mode rebuilds of large projects are 6 to 11% faster.

### Fixes

- **`a?.b.c` on an `any` value short-circuits only the guarded step,** as in Node: it is `undefined` when `a` is nullish and throws when `a.b` is undefined.
- **A failed checked cast to an optional record names the deepest failing path,** for example `expected string at $.order.owner.id, got number`.
- **Spreading a non-iterable value held as `any`** throws Node's `x is not iterable` message.
- **`process.versions` entries that the runtime doesn't have read as `undefined`** in projects that use `@types/node`.
- **Functions stored in JavaScript object literals get Node's names,** taken from the property key.
- **`monitorEventLoopDelay().percentile()` returns 511** on an empty histogram, as Node does.
- **A CommonJS `var` statement that mixes `require()` declarators with other bindings** no longer crashes.
- **Untyped async methods called through overrides or untyped receivers return their promises,** which fixes internal compiler errors in programs that use zod's `parseAsync` this way.
- **TypeScript enum exports in compiled packages stay `undefined` until they are assigned,** as in Node.
- **Element writes accept a possibly undefined index** (typed-array writes, compound and update writes, element assignments used as values and destructuring targets) and convert it with ToNumber, as element reads already did.

## 0.4.0

### Breaking changes

- **tsc-ts is the default TypeScript 7 checker** on Linux and macOS. scriptc installs it with the compiler (`tsc-ts` 0.0.5 and its platform package for the host). Programs get the same diagnostics and generated code as with tsgo, and compiling takes less checker memory. `SCRIPTC_CHECKER=tsgo` selects tsgo, which stays the default on Windows. A build cache entry made with one checker isn't reused with the other.
- **`--npm-static=auto`, the default, compiles more packages:** packages typed by their DefinitelyTyped twin (`@types/<name>`), and untyped dependencies that another package's JavaScript imports. A program whose dependencies were refused before can now compile them, and a twin whose declarations disagree with the package's JavaScript fails the build at the use. Use `--npm-static <pkg,…>` to name the packages to compile.
- **Program type errors are reported as type errors** instead of as refusals of the npm package that contains them.

### Highlights

- **WebAssembly:** builds translate every WebAssembly module whose bytes they can see into native code, and `WebAssembly.compile`, `instantiate`, `validate`, `new WebAssembly.Module` and `new WebAssembly.Instance` run them. There is no interpreter. `WebAssembly.Memory`, `Table` and `Global`, `Module.imports`, `Module.exports` and `Module.customSections`, and function references from tables are supported, and modules can be sent to workers. `scriptc coverage` lists the modules a program loads, with `--wasm <file.wasm>` for modules loaded from paths the sources don't spell out.
- **Async functions that suspend only at their `await`s run as stackless coroutines** instead of on fibers with their own stack, so a suspended call keeps only the values live across its awaits.
- **Discriminated unions of records are the record pointer itself,** with no box around each value.
- **The dynamic tier computes with NaN-boxed values:** numbers, booleans, `undefined` and `null` between operators no longer allocate. `scriptc coverage --explain-dynamic` lists the functions that run in the dynamic tier and why, and `--tier=static-only` keeps a program fully static.
- **npm packages:** esbuild's bundled CommonJS chunks, CommonJS cycles and lazily initialized ES modules compile statically, as do classic CommonJS packages (late and JSON `require`s, require cycles), class hierarchies across a package's modules, and the packages unblocked by type-only imports, `@types` packages, `punycode` and `constants`. chalk 5 and the jose root entry compile.

### Features

- **`@scriptc/experimental` adds `ThreadSlots`,** one value per key and thread on shared objects, read without a lock.
- **`node:test` adds `mock.timers`, `getTestContext`, `t.assert.snapshot` and `t.assert.fileSnapshot`,** the `TestContext` values `filePath`, `attempt`, `passed`, `workerId` and `tags`, module-level `before` and `after` hooks, the `SuiteContext` and hook contexts, and unnamed `test` and `describe` calls. A timed-out test cancels its running subtests.
- **`node:worker_threads` adds `BroadcastChannel`,** `setEnvironmentData`/`getEnvironmentData`, `receiveMessageOnPort`, `markAsUntransferable`, `markAsUncloneable`, `threadName`, `resourceLimits.stackSizeMb`, the `stdout`/`stderr`/`stdin` options and streams, and `worker[Symbol.asyncDispose]`.
- **`node:net` adds `SocketAddress` and `BlockList`,** and `net.connect` resolves host names.
- **`node:http` pools keep-alive sockets in `Agent`s,** uses `globalAgent` for default requests, reads `http.request` options at run time, and speaks HTTP over Unix domain sockets. `fetch` tunnels through `HTTP_PROXY`/`HTTPS_PROXY` with `CONNECT`.
- **`DisposableStack`, `Float16Array`, `Error.isError`, `Promise.try` and the regular expression `v` flag** are supported.
- **Iterator helpers** run on generators, `Map` and `Set` iterators, string and typed array iterators, `Iterator.from` and untyped iterators.
- **`Object.groupBy` and `Map.groupBy`** group Sets, Maps and generators.
- **`v8`, `stream/web`, `dns/promises`, `EvalError` and `graceful-fs`** are available, and `Temporal` is reported as absent, as in Node 24.
- **`util.promisify`** works over the crypto callback functions, dns lookups, `child_process.exec`'s callback forms and callback-style functions.
- **`events.once`** takes an `AbortSignal` and works over streams.
- **`AsyncLocalStorage` stores** carry into timer, immediate, `process.nextTick` and microtask callbacks.
- **JavaScript classes compile like TypeScript classes** when their layout or JSDoc types allow it.
- **Classes that extend `EventEmitter` or a stream class can be used as values,** and so can `EventEmitter`, the stream classes and the error classes themselves. Constructor functions can inherit from them.
- **Class instances can be frozen and their fields redefined.**
- **Method overrides may differ from the method they override** in parameter and result types, as long as each value converts.
- **Library profiles add the `cstring` class.**
- **An experimental young-object nursery** for compiled classes and records is available at compile time with `SCRIPTC_YOUNG_NURSERY=1`.

### Performance

- **Dense arrays have head room,** so `shift`, `splice(0, n)` and `unshift` runs cost amortized O(1), and `pop` of a packed array is inline.
- **Index loops over arrays and typed arrays are versioned on one bounds guard,** with stable lengths proven and typed-array memory tagged for alias analysis.
- **Retain and release pairs are removed** through private-array precision and last-use moves, borrowed string slices go into stack buffers, and records, tuples and spread updates stay in frame storage.
- **SHA-384 and SHA-512 use AVX2, AVX-512VL or the arm64 SHA-512 instructions,** and MD5's block function is unrolled.
- **String character tests, optional-string `switch`es, `String.fromCharCode` and long-string `length` are faster,** and `Buffer.write` widens ASCII to UTF-16 sixteen bytes per step.
- **The cycle collector walks dead cycles once,** frees large dead cycle sets in address order and no longer creates self-capture cycles on the release fast path.
- **Workers return their memory** while the event loop waits and when they finish, and default-region memory is committed as it is used.
- **Lifetime regions carry across `await`,** and freed region chunks are reused.
- **Large closure environments compile in linear time,** and two frontend scans no longer repeat.
- **Programs keep stack frames only when they can read `stack`.** Before, a computed-key read on a dynamic value kept frames in every function; tsc-ts's own check is back to 0.3.6's speed.
- **The child-process runtime unit links only into programs that spawn.**

### Fixes

- **Node 24 parity:** `util.format`, `util.types` and `util.inspect`, `URLSearchParams`, `querystring` (null-prototype results), `string_decoder`, `os`, `events` and `timers/promises` match Node 24. Class instances, iterators, iterator helper objects and holes in arrays print as Node prints them, and `%d`/`%i` format dynamic arguments as Node does.
- **Silent wrong output is fixed** for object identity, `Object.prototype` values, `Date.parse` (V8's date grammar), stored builtins, constructor returns, `arr && arr[0]`, ES5 class names, builtin function values, uninitialized `let` writes, module-export `this` and `1 ** Infinity`.
- **Strings compare in UTF-16 code-unit order.**
- **Dates format with Node's local time zone names,** convert to local time once for their local getters, and follow `TZ` changes. `Date.prototype.toJSON` gives `null` for invalid dates.
- **Errors:** thrown Maps, Sets, typed arrays, functions and arrays keep their identity. Errors list their own name where they were created, errors held as `any` have their own `stack` accessor and convert with `Error.prototype.toString`, and errors that cross into dynamic code carry Node's error properties.
- **`matchAll` rows and `exec` results have `index`, `input` and `groups`,** and named groups keep their null prototype through optional chains.
- **Unhandled rejections are reported after each timer and immediate callback,** and async generator completions settle on Node's microtask turns.
- **Missing `Record` and index-signature keys read as `undefined`,** and generic functions that read a missing element return `undefined`.
- **Sockets:** `'data'` listeners get strings after `setEncoding`, socket and stream chunks are Buffers, and an idle pooled http socket that receives data is destroyed.
- **Diagnostic code frames window long source lines.**
- **npm crashes, internal errors and false TDZ errors** found while compiling popular packages are fixed.

## 0.3.6

### Features

- **`node:readline` adds terminal mode, cursor helpers and `emitKeypressEvents`,** along with the `history` and `completer` options and the history members.
- **`node:http` supports request `signal`s, `destroy(err)`, `servername`, `Expect` events and `maxHeaderSize`.**
- **`createHash` and `createHmac` values work as streams.**
- **`node:test` adds the `concurrency`, `plan` and `timeout` options.**
- **`fs.cpSync`, `fs.cp` and `fs/promises` `cp` are supported.**
- **`util.promisify` works over `setTimeout`, `setImmediate`, `stream.finished`, `stream.pipeline` and the zlib callback one-shots.**
- **`Array.fromAsync` works over arrays,** `Readable.from` accepts Sets, iterators and class iterables, and the `Set` composition methods accept `Map` arguments.
- **`using` disposes `Disposable`-typed values,** and `SuppressedError` exposes `error` and `suppressed`.

### Performance

- **Int32 class fields stay int32 next to arithmetic on dynamic operands** and in programs that register process event listeners. A large TypeScript type-checker workload runs about 12% faster with about 5% less memory.
- **`while` loops bounded by a string's length keep int32 counters.**
- **Worker threads reserve heap growth up front** once they allocate many large blocks, and share one prefault budget.
- **Small runtime functions are inlined into release executables.**
- **Integers are speculated only where the static range proof gives up.**
- **Constant-key dynamic reads are cached per site,** and `JSON.parse` follows repeated key sequences.
- **The zlib one-shot forms run on the stream engine,** and `statSync`'s `throwIfNoEntry` option no longer builds the error it discards.

### Fixes

- **Class instances keep their identity through structural record views,** including in `switch` statements and assertions.
- **Node 24 builtin forms that ran with wrong output now match Node or are refused,** and `Object.groupBy` results have a null prototype.
- **IPv4 hosts in special-scheme URLs parse like WHATWG URL.**
- **fs paths with a null byte are refused as Node does.**
- **`Object.setPrototypeOf` returns primitive receivers,** and `createHmac` without a key throws Node's error.
- **Boxed records that hold an async function link the dynamic promise unit.**

## 0.3.5

### Features

- **`node:fs` adds read and write streams,** including `fs.createReadStream` and `fs.createWriteStream`.
- **`util.promisify` works over `child_process.exec`** and the fs callback functions that have an `fs/promises` counterpart.
- **`node:net` adds `socket.address()`, `socket.resetAndDestroy()` and `server.dropMaxConnection`,** and `node:dgram` supports the socket options and `disconnect()`.
- **`node:tls` adds `getProtocol`, `getCipher`, `alpnProtocol`** and `tls.DEFAULT_MIN_VERSION`/`DEFAULT_MAX_VERSION`.
- **`events.once` works on `EventEmitter` instances.**
- **Checked JSON records keep keys they do not declare,** and compound assignment with untyped operands compiles.

### Performance

- **`Map` and `Set` headers and small entry arrays are smaller:** an empty map takes 100 bytes instead of 188.
- **Released lifetime regions are freed without a pass over the whole heap.**
- **The cycle collector frees its large work vectors after a pass,** and intact parsed JSON documents skip cycle collection.
- **Classes keep a property bag only when something stores into it,** and class and record views without dynamic stores emit no commit adapters.
- **Integer arithmetic is proven through calls and module-level code,** pure number recursion runs on integer clones, and array lengths load with the range of a JS array length.
- **Closed virtual calls are dispatched directly,** read-modify-write operations reuse their `Map` lookup, and never-reassigned bindings are read as values.
- **Generators, user iterators and awaits cost less per value,** and promises use a smaller block allocated inline.
- **SHA-1 and SHA-256 use the SHA extensions on x86-64,** about 4 to 5 times faster than before.
- **Regex exec results, `parseInt` of captures, UTF-8 file reads, string-and-number concatenation and small `Buffer` allocation are cheaper,** and `JSON.parse` storage fits its length.
- **The main thread leaves its heap to the operating system at exit.**

### Fixes

- **Sockets read ahead without a consumer,** so a peer's close reaches them.
- **Publication walkers with more than ten pushes keep distinct value names,** and int32 field storage survives reflection reads through `unknown`.
- **Native program objects use runtime ABI v22.** External object consumers must link the matching v0.3.5 runtime pack; the versioned marker rejects incompatible runtime objects at link time.

## 0.3.4

### Features

- **`InternTable` in `@scriptc/experimental`** is a shared, append-only table of published values that every thread can read and add to, with string, number and array keys.
- **`node:zlib` adds the stream classes,** and `node:crypto` supports `createCipheriv` and `createDecipheriv`.
- **`node:stream` adds the Readable operators, `stream.compose`, `Readable.from` over generators** and the `Readable.from` options, plus async generator stages, source functions, promise destinations and `{ signal }` in `pipeline`.
- **`node:test` adds `TestContext` hooks, `plan`, `fullName`, Node's `todo` and `only` rules, `mock.fn` and `t.mock.fn`.**
- **`node:assert` adds `AssertionError`, `deepEqual`, `partialDeepStrictEqual` and the `Assert` class.**
- **`node:http` matches Node's keep-alive, header and framing behavior,** and `node:net` adds socket address fields, `write` and `end` callbacks and server connection limits.
- **`dns.lookup` supports Node's forms,** along with `lookupService`, `getServers` and the result order.
- **`fs.opendirSync`, `fs.promises.opendir` and `fs.Dir`** are supported, and the fs option checks follow Node's.
- **`util.format` supports `%f`,** and `timers/promises` resolve values and `setInterval` work under `@types/node`.

### Performance

- **`Atomics` run without a lock** on shared storage and compile to inline atomic instructions.
- **Lifetime regions are cheaper.** Programs that never create a region no longer pay for region counting, a kept region is retried only when its counted references change, and owned objects with a single reference are released without a table entry.
- **Publishing large object graphs is faster,** and dropped cyclic graphs are collected while they are still in cache.
- **fs callbacks and worker-pool completions wake the event loop directly** instead of waiting for a timer turn.
- **Number-keyed `Map` and `Set` operations are faster:** lookups are probed inline, and `set` and `add` after a read store into the entry they found.
- **Named property reads of unknown values take one receiver retain,** dyn array elements and lengths are read by number, and cyclic dyn values convert to recursive shapes.
- **Small exact arrays have room for one append.**
- **Large wasm32 programs are partitioned** like native ones.

### Fixes

- **`process.nextTick` callbacks drain before promise jobs** after every callback, as in Node.
- **wasm32 array lengths past 2^31** and the exit codes of pending top-level `await` are correct, and typed-array indices stay integral through the shared-buffer check.
- **The npm case fixtures run natively,** and the issues they found are fixed.

## 0.3.3

### Features

- **scriptc targets Node 24.22.0.** Compatibility tables, tests and behavior follow Node 24.22.0.
- **`node:crypto` covers more of Node 24:** every digest in `createHash`, `createHmac`, `crypto.hash`, `pbkdf2` and `hkdf`, every Hash and Hmac encoding and option, secret `KeyObject`s (`createSecretKey`, `generateKey`, `generateKeySync`), `randomFill`, `randomInt` callbacks, `randomUUID` options, `randomUUIDv7`, and `timingSafeEqual` over any view or `ArrayBuffer`.
- **`node:fs` adds `glob`, `globSync` and `fs/promises` `glob`,** the remaining `fs/promises` functions with Node's argument checks, complete `fs.Stats` in both lanes, and results from `mkdir`, `readFile` and `write` callbacks. `readdir` lists entries in byte order on POSIX hosts, and dynamic `Dirent` values have Node's prototype and inspect form.
- **`Blob` and `File`** are supported.
- **`readline/promises`, `stream.addAbortSignal` and the `stream/promises` options** are supported, and stream chunks made from strings reach user code as `Buffer`s.
- **The legacy `url` API, `url.domainToASCII` and `url.domainToUnicode`** are supported.
- **`process.memoryUsage`, process identity members, and `performance` marks and measures** are supported.
- **`EventTarget` and `Event` can be subclassed.**
- **Sockets and servers support `ref()` and `unref()`.** The HTTP server enforces Node's header field limits, and `util.types` has Node 24's keys.
- **`util.inspect` prints class names and dynamic Maps and Sets** as Node does.
- **`localeCompare` matches Node's collation** for `l·`, U+0130, ligatures, combining Latin letters and vulgar fractions.

### Performance

- **Comparator sorts use V8's TimSort,** and typed-array `sort` and `toSorted` are lowered natively.
- **The allocator has 8-byte size classes below 128 bytes,** so small objects waste less memory.
- **Interface calls are faster.** Class methods are called directly through interfaces, interface dispatch is inlined and borrows array elements, and arrays of interface values are stored natively with direct field reads.
- **Strings append in place** for fields, concatenation chains and character codes, and string retains are inlined in release builds.
- **Records are leaner.** Scalar-union fields are stored inline, record parameters and returns widen by flow class, nullable records use widened record slots, result-slot entries are inlined, and conversions from typed records to `unknown` are cheaper.
- **Typed `JSON.parse` matches member names against the text** and reads scalar members inline, and typed `JSON.stringify` writes arrays from their slots.
- **Map and Set iteration steps are inlined,** and `Object.values` is built natively when its result is only iterated or read.
- **Array searches over objects and strings run inline,** and array headers stay out of loops.
- **`localeCompare` is faster:** it compares without building element lists and checks ASCII strings eight bytes at a time.
- **Remainders by powers of two skip `fmod`,** number and string dynamic boxes are freed without the destroy queue, and VT control characters are stripped in one pass.

### Fixes

- **`parseInt` rounds as Node does on each architecture.**
- **New runtime globals are defined with initializers,** so library localization hides them.
- **Native program objects use runtime ABI v21.** Array, record and allocator layouts changed, so external object consumers must link the matching v0.3.3 runtime pack; the versioned marker rejects incompatible runtime objects at link time.

## 0.3.2

### Features

- **`EventTarget`, `Event` and `CustomEvent`** are supported, with Node's dispatch order, `once`/`passive`/`signal` options and listener error reporting. `AbortSignal` uses the same implementation, and `events.errorMonitor` and `events.addAbortListener` are supported.
- **`Promise.allSettled` and `Promise.any`** are supported in typed and JavaScript code, with Node's microtask order, `AggregateError`, and `PromiseSettledResult` records. JavaScript combinators adopt thenables.
- **`yield*` delegates to arrays, strings, Sets and Maps,** forwards typed `next` values, `return()` and `throw()`, and a finished generator's `.value` reads as `undefined`.
- **The global console is complete:** `assert`, `count`/`countReset`, `dir`/`dirxml`, `group*`, `table`, `time`/`timeLog`/`timeEnd`, `clear` and `profile`/`timeStamp` print Node's output.
- **`node:os` is complete,** and `path.parse`, `path.format` and `path.matchesGlob` are supported for the posix and win32 families.
- **`util.inherits`, `util.deprecate`, `util.callbackify` and `util.debuglog`** follow Node 24, including `NODE_DEBUG`, `process.noDeprecation` and `process.throwDeprecation`.
- **`LifetimeRegion` in `@scriptc/experimental`** frees `ProgramLifetime` instances one generation at a time. A watch-style compiler benchmark stays at 190 MB after 10 builds.

### Performance

- **Short-lived number records and objects live in the function's frame.** Records and small class instances with number and boolean fields that are only read, updated by their own methods, or returned unchanged are not heap-allocated, including results of functions that return a fresh object.
- **Maybe-missing number reads stay unboxed,** and directly called functions returning `number | undefined` return the tag and payload in registers.
- **Arrays and objects use less memory.** `boolean[]` stores one byte per element, small appended arrays keep their first elements in the array's own block, and cycle-capable objects carry an 8-byte header instead of 16 bytes.
- **Sorting with a recognized numeric comparator sorts by key** without calling the comparator, for `number[]` and arrays of records or class instances.
- **Regex `replace`, `match` and capture reads are faster.** Compiled matchers write replacements directly, and captures that are only compared or converted to numbers are not copied into strings.
- **`for...in`, `Object.keys` and `Object.entries` over values typed `unknown` or `any`** build native arrays from the record layout or the object's own keys.
- **Calls through function-typed class fields** box the receiver only when the callee reads `this`.
- **Indexed non-ASCII string scans, `split("")`, template literals and `join` are faster.**

### Fixes

- **Strings keep lone UTF-16 surrogates.** Strings are stored as canonical WTF-8, so lone surrogates survive literals, `split("")`, `charAt`, `slice`, `fromCharCode` and `JSON.parse`, and output streams write them as U+FFFD as Node does.
- **A `var` read before its first store reads `undefined`,** and classes used before their declaration runs throw a `ReferenceError`.
- **Reflection over typed values seen as `unknown` matches Node:** `in` sees prototype members, `for...in` walks class instances, typed records work as prototypes, and `JSON.stringify` accepts array replacers.
- **Microtask and event order match Node** for `Promise.all`, `Promise.race`, async generator returns, and fork IPC `exit`, `disconnect` and `close` events.
- **Module initializers that only `++` or `--` a binding run.**
- **Native program objects use runtime ABI v20.** Array and object layouts changed, so external object consumers must link the matching v0.3.2 runtime pack; the versioned marker rejects incompatible runtime objects at link time.

## 0.3.1

### Features

- **`node:console` `Console` instances** write to `process.stdout`, `process.stderr` or other writable streams, with Node's `ignoreErrors` handling.
- **`stream/consumers` `arrayBuffer()`** is supported, and `ArrayBuffer` and `SharedArrayBuffer` values print like Node.
- **Compound assignment and `++`/`--` work on bigint locals and fields.**

### Performance

- **Integer code stays in integer registers.** Locals proven to stay within 32 bits are stored as 32-bit integers, int32 parameters and results pass in integer registers on direct calls, integer sums that feed bitwise conversions wrap in 32 bits, and loop accumulators keep uint32 ranges.
- **Array callback chains run as single loops.** `filter`, `map`, `flatMap` and `slice` chains feeding `reduce`, `some`, `every`, `findIndex`, `forEach`, `length` or a final array no longer build intermediate arrays when the callbacks' effects allow it.
- **Array element access does less work.** Arrays track a hole-free prefix whose reads and writes skip per-slot state, compound element updates are native, dense arrays sort without a snapshot, and typed-array reads compared with numbers stay unboxed.
- **Calls and closures retain less.** Calls are devirtualized by the classes a program constructs, closure bodies borrow unchanged reference parameters, the comparator sort lends its slots, and unchanged captures are read in place.
- **Async calls and generators are cheaper.** Awaiting a direct async call that completes without suspending creates no promise, and synchronous generators run as stackless coroutines.
- **Strings and regular expressions are faster.** Comparisons and `switch` against string literals run inline, regex literals compile to native matchers at build time, literal sites reuse their compiled pattern, and plain-text patterns and string `replace`/`replaceAll` scan directly.
- **BigInt arithmetic and text conversion are much faster,** with limb-based division, chunked radix conversion and Karatsuba multiplication; literals are constants, and small-value expressions run in 64-bit registers.
- **Reflective reads of typed values** (`for...in`, `Object.keys`/`values`/`entries`, `in`, spread and `JSON.stringify` of typed records seen as `unknown`) read native fields instead of copying the record.
- **The cycle collector frees young garbage sooner and teardown is direct.** Types the collector bypasses are measured again in probe windows, and typed children are torn down without the generic release path.
- **The compiler is faster,** because its own analyses walk the IR through typed fields.

### Fixes

- **`return p` in an async function takes Node's microtask turns,** and a rejection of the returned promise reaches the caller instead of the function's own `catch`.
- **Core dumps leave out the allocator's untouched reservation,** so crashing programs no longer write gigabytes of empty memory, and glibc's heap is left to the huge-page policy.
- **Native program objects use runtime ABI v17.** Array, closure and regex layouts changed, so external object consumers must link the matching v0.3.1 runtime pack; the versioned marker rejects incompatible runtime objects at link time.

## 0.3.0

### Breaking changes

- **Compilation is native-only.** The `--dynamic` option and embedded JavaScript execution runtime have been removed. Eligible dependencies compile natively by default; unsupported packages receive build diagnostics. QuickJS remains only in the native compiler's isolated `comptime` helper and as standalone regex/Unicode libraries.

### Features

- **`process.constrainedMemory()` and `process.availableMemory()` read the process's own cgroup limits,** as Node.js does through libuv.

### Performance

- **Map and string lookups do less work.** Absent string keys are rejected before the map is probed, and multi-byte substring searches no longer call `memchr` for every first-byte hit.
- **Class property bags are read without being created.**
- **Runtime packs for Linux musl, Windows and WASI are much smaller.** Their dev runtime objects no longer carry undefined-behavior checks, matching the glibc and macOS packs.

### Fixes

- **Native program objects use runtime ABI v14.** The embedded JavaScript runtime's symbols were removed, so external object consumers must link the matching v0.3.0 runtime pack; the versioned marker rejects incompatible runtime objects at link time.

## 0.2.10

### Features

- **Contract types check extra promises at compile time.** The new types-only `@scriptc/types` package adds `NoThrow<T>`, `Int32`, `Immutable<T>`, `Acyclic` and `ProgramLifetime`. They mean nothing to TypeScript or Node.js, but scriptc proves each one or fails the build with a diagnostic that names the throwing path, the non-int32 store, the write that breaks immutability or the reference cycle. Proven `Int32` slots are stored as native integers, immutable module constants take no reference counts, and program-lifetime classes skip reference counting and cycle collection. Outside worker programs, a surrounding `try`/`catch` discharges `NoThrow`.

### Performance

- **Construction and narrowed reads do less work.** Private constructor stores drop publication guards, construction-only fields are borrowed, string-keyed `Map` reads retain inline, and narrowed member reads are rechecked only when a call can invalidate them.
- **Indexed reads and integer code are cheaper.** `charCodeAt` at proven integer indices skips the double round trip, literal `switch` statements dispatch without range tests, indexed-read helpers are inlined, identity bitwise forms over proven int32 operands return the operand, and array counters use signed conversions.
- **Allocation is faster and smaller.** Small arrays are sized exactly, map storage stays on the runtime allocator, array element reference-count entry points live in one shared descriptor per element type, glibc's large blocks use transparent huge pages, and Linux pre-faults allocator memory on a helper thread.
- **Runtime throw paths stay out of line,** so hot code around checks that rarely fail stays smaller.

### Fixes

- **Published object graphs stay immutable in more cases.** A constructor that stores `this` into its own field keeps its publication guards, and calls that may replace a field keep their own reference to arguments read from it.
- **Native program objects use runtime ABI v13.** Array headers changed, so external object consumers must link the matching v0.2.10 runtime pack; the versioned marker rejects incompatible runtime objects at link time.

## 0.2.9

### Features

- **`os.availableParallelism()` works in static programs.**
- **`--detached-exit` frees the address space after `process.exit` off the critical path,** so large programs exit sooner.

### Performance

- **Cycle-capable objects are smaller.** A 16-byte collector header, typed rest spreads, leaf capture boxes, rarely used array storage moved out of line, and tracing only types that can actually lie on a cycle.
- **The heap and cycle collector scale better.** Busy small-object slices use transparent huge pages, the collector's growth fraction widens further on large live heaps, and `Map`/`Set` `clear` and `delete` cost O(live) rather than O(peak).
- **Indexed reads are cheaper.** Typed-array reads stay plain numbers where `undefined` acts like `NaN`, unproven indexes are checked with a signed round trip, lengths and in-range indexes convert to doubles without the unsigned sequence, nullable-union array elements are read inline, and counted loops that start from an unproven value run on integer counters.
- **Worker programs pay less overhead.** Fewer termination polls, an exact per-thread pending word, a call-free macOS stack guard, and exiting worker threads return their free pages to the system.
- **More receivers and fields stay native.** Optional-chain receivers are borrowed, `int32` fields survive `Error` subclasses that forward constructor arguments, and method calls stay native when only an unrelated callback field shares the name.
- **Compiler-scale programs compile without hitting V8's string limit.** Serialized IR is streamed.

### Fixes

- **More values behave as in Node.js.** Missing array and typed-array reads stay `undefined` through number arguments, narrowed slots and lambda results, and `null` stays distinct from the temporal dead zone in forward-captured bindings.
- **Union class fields work in more shapes.** Optional base-class receivers are narrowed before shared field access, and fields declared with different types across a union can be read and written.
- **Workers share descriptor tables safely,** and live array references are accessed one element at a time.
- **Native program objects use runtime ABI v12.** Runtime object layouts changed, so external object consumers must link the matching v0.2.9 runtime pack; the versioned marker rejects incompatible runtime objects at link time.

## 0.2.8

### Features

- **Workers can share immutable object graphs without copying.** The new `@scriptc/threads` package adds `publish(value)`, which makes a graph read-only so native executables hand the same objects to every worker by reference; Node.js runs its JavaScript implementation. Deeply frozen plain data sent to workers is also shared rather than cloned.
- **Deep recursion throws a catchable `RangeError`.** Recursive functions check the native stack on Linux and macOS and throw `RangeError: Maximum call stack size exceeded` on the main thread, in workers, and inside async functions and generators, which now run on 512 KiB stacks.
- **Compile blockers and Node.js differences are easier to act on.** Diagnostics explain what stopped a compile and where native behavior differs, and a rejected declaration now reports its own diagnostic instead of only a follow-on error.

### Performance

- **Large executables compile faster and rebuild incrementally.** Code is divided into partitions that are optimized and compiled in parallel, with small functions imported across partitions for inlining, and rebuilds reuse the partitions an edit does not touch.
- **Native code does less reference-count and allocation work.** Nullable references are stored as plain pointers, release fast paths are inlined without cycle-color writes, more parameters, receivers and locals are borrowed, provably 32-bit integer fields and values use native integers, and temporary arrays are avoided.
- **Strings, collections, loops and exceptions use more direct paths.** Strings cache a proven-ASCII flag and read elements inline, number-keyed Maps and Sets index directly, loops over arrays without holes read elements directly, and exception checks run inline.
- **Programs that create workers pay far less overhead.** A per-thread allocator, initial-exec thread-local storage and a single exception alert word keep single-threaded code in worker programs close to its non-worker speed.

### Fixes

- **More values behave as in Node.js.** Out-of-range typed array reads, holes in `for...of` loops, object literals built from missing array elements, and class fields read before assignment all produce `undefined`. Optional values keep their state through callbacks, captures, `pop()` and initialization order.
- **Weak collections accept more keys.** Records and arrays reached through unions and empty object literals work as `WeakMap` and `WeakSet` keys.
- **Debuggers stop only at user code.** Shared helpers no longer appear on user source lines, so a breakpoint on a line stops only at that line's code.
- **Native program objects use runtime ABI v9.** External object consumers must link the matching v0.2.8 runtime pack; the versioned marker rejects incompatible runtime objects at link time.

## 0.2.7

### Features

- **Supported import cycles initialize in module evaluation order.** Compiled modules preserve shared instances, hoisted function calls, and temporal-dead-zone checks across cyclic imports.
- **Typed returns carry more native values.** Optional values, never-returning calls, and native collection iterators retain their supported behavior across typed function boundaries.
- **Native terminal and filesystem metadata expands.** Standard terminal stream properties and filesystem error fields are available in supported static workflows.
- **An opt-in speed mode trades executable size and build time for runtime performance.** `--optimization=speed` enables runtime inlining, inline reference counting, and x86-64 runtime alignment while preserving the default release mode.

### Performance

- **Native allocation and cycle collection do less work.** A small-object allocator serves strings, arrays, and records; safe allocations and releases are emitted inline, and cycle scans back off for long-lived graphs while keeping static executables small.
- **Arrays, collections, and callbacks avoid repeated work.** Large dense arrays avoid the former sparse-storage cliff, direct element access and callback calls reduce boxing, and string-keyed Maps reuse cached hashes. Optional element reads and captured parameters avoid temporary wrappers where safe.
- **JSON, numbers, and regular expressions use more direct native paths.** Supported typed JSON parses directly into records, common number conversions use specialized paths, and regular expressions reuse compiled patterns and subject decoding with a native matcher for supported ASCII subjects.
- **Async execution and native I/O reduce overhead.** Supported await-free async functions avoid fibers, fiber switches save only required registers, HTTP responses coalesce headers and bodies, and console and process streams write directly to descriptors.

### Fixes

- **Class, record, and callback values preserve more JavaScript behavior.** Class references retain identity through unions and collections, adapted callbacks remain the same function, and record field presence stays distinct from an explicit undefined value. Data-property writes no longer incorrectly mark unrelated class methods as replaced.
- **Console line buffers account for concatenated string parts.** Long template literals and string concatenations reserve sufficient space before output.
- **Native program objects use runtime ABI v8.** External object consumers must link the matching v0.2.7 runtime pack; the versioned marker rejects incompatible runtime objects at link time.

## 0.2.6

### Features

- **Native worker threads run statically compiled entry points in parallel.** Supported `node:worker_threads` workflows include worker data, structured messages, lifecycle events, and cooperative termination, with isolated module state and heaps.
- **Shared buffers and integer Atomics enable worker coordination.** Supported shared views preserve backing storage across messages and provide atomic integer operations plus Int32 wait/notify.
- **More generic class and interface patterns compile natively.** Concrete generic inheritance, forward references, nullable substitutions, checked class assertions, and live interface receivers preserve type and object identity.
- **Native library calls cover more text workflows.** Synchronous file reads accept supported runtime encodings, and regular-expression replacement supports callbacks.

### Performance

- **Text, collections, and byte processing avoid repeated work.** Structured output, streamed split loops, keyed storage, primitive array sorting, scalar string access, and proved numeric operations reduce intermediate allocation and conversions.
- **Reference handling does less ownership work.** Stable loop references and synchronous callbacks borrow safe inputs, while cycle collection adapts to mature graphs.
- **Compilation reuses source and type information and parallelizes large native builds.** Source discovery, checker metadata, semantic queries, and AST traversal avoid repeated work.

### Fixes

- **Deep reference chains clean up with bounded stack use.** Native teardown preserves ownership across generated objects and runtime containers.
- **Generic limits and diagnostics better match the failing source.** Independent concrete instantiations no longer share a global specialization cap; recursive demand remains bounded, and diagnostics retain source-file identity.

## 0.2.5

### Features

- **Buffer.from accepts runtime string encodings.** Native string conversion preserves encoding defaults and aliases, with catchable validation errors.

### Performance

- **Filesystem reads and typed-array processing do less copying.** File reads use owned storage directly, while typed-array conversion, copying, and filling avoid unnecessary intermediate work.
- **Collections and object properties use storage more efficiently.** Array construction and mutation, stable sorting, string-keyed Maps and Sets, and wide object lookup reduce repeated allocation and traversal.
- **JSON, regular expressions, and string operations scan and allocate less.** Shared scans, batched output, and reused byte and character positions streamline parsing, serialization, replacement, normalization, and navigation.
- **Native values and compiler queries avoid repeated work.** Safe borrowing, local tagged storage, direct collection reads, reused source metadata, and batched checker requests reduce temporary wrappers and ownership traffic.

### Internal improvements

- **Compiler code has clearer responsibilities and consistent source tooling.** Builtin, conversion, function, container, and native build code is organized into focused modules, with shared contracts and oxlint/oxfmt checks for normal JavaScript and TypeScript sources.

## 0.2.4

### Features

- **Native Maps and Sets accept boolean, bigint, and mixed-value keys.** Collection construction and storage preserve identity, insertion order, and iteration behavior.

### Performance

- **Numeric loops and byte access need less runtime work.** Integer facts flow through loops and typed-array access, while Buffer and DataView numeric operations avoid redundant conversions and proven bounds checks.
- **Native text, collection, and checked-value paths reduce ownership and allocation overhead.** String construction writes directly to final storage, and safe input borrowing, value reuse, and cycle cleanup reduce intermediate work.

### Fixes

- **Windows toolchain assets resolve through linked packages.** Native launches locate installed assets from the physical package manifest path.

## 0.2.3

### Features

- **Node 24 filesystem and URL coverage expands.** Filesystem support adds capacity queries, link handling, timestamps, and file URL byte conversion with platform options; URL handling adds authority, protocol, and mutation behavior.
- **Web Streams support covers more workflows.** Writable and readable streams add controller and reader operations, `tee`, pipelines, and streaming encoding.
- **Embedded Node compatibility adds module and utility APIs.** CommonJS and ESM metadata, diagnostics channels, deep equality, `util.types`, `util.styleText`, text and system error utilities, MIME utilities, and no-error assertions gain support.
- **Native Set construction accepts supported collection iterators.**

### Performance

- **Compiler analysis avoids repeated metadata and tree work.** AST child lookups, class and record metadata, graph propagation, and exception analysis are reused or streamlined.
- **Native array iteration does less work.** Optimized loops preserve live tuple iteration behavior.

### Fixes

- **Native values keep valid lifetimes across helper and collection operations.** Array borrowing, map reads, string concatenation, and helper calls preserve values for their full use.
- **TypeScript runtime package sources emit consistently.**

## 0.2.2

### Features

- **More Three.js CPU workflows compile natively and to WASI.** Support expands across procedural geometry, curves, animation blending, mesh deformation, material and texture data, in-memory model loading, and CPU node graphs. Compiled libraries can send geometry, material state, and resource lifecycle notifications to an external rendering host.
- **Stored Map and Set iterators compile statically.** Native cursors support `next()`, function arguments, `for...of`, spreads, and mapper-less `Array.from` while preserving live collection behavior and reference identity.
- **Native filesystem and crypto support expands.** Descriptor I/O and FileHandle vector and control operations compile statically, alongside scrypt, HKDF, and additional SHA-2 algorithms. Embedded packages gain the corresponding Node 24 behavior.
- **Node 24 URL, environment, and text utilities gain native support.** `URL.canParse`, `URL.parse`, URL JSON serialization, `util.parseEnv`, `process.loadEnvFile`, `TextEncoder.encodeInto`, and buffer validation and transcoding compile without an embedded JavaScript engine.
- **Embedded packages support more asynchronous event and timer flows.** `events.on` adds buffered iteration, cancellation, close events, backpressure, and listener cleanup; `events.once` accepts EventTarget inputs and cancellation, and abort listeners support disposal. Promise timers and scheduler operations add cancellation and reference controls, with buffered interval iteration and native timer-handle lifecycle behavior.

### Performance

- **Compilation avoids repeated queries, scans, and allocations.** Frontend type queries and JavaScript binding analysis, native IR traversal, union transformations, artifact dependency collection, and serialization do less repeated work.
- **Native build preparation overlaps independent work.** Compiler fingerprinting and native-driver discovery run concurrently, with more bounded parallel fingerprint reads while preserving cache identity and invalidation behavior.

### Fixes

- **Static JavaScript workflows preserve more class and callable behavior.** Inferred class fields, inherited members, method dispatch, callable identity, collections, and async values retain their supported state across compiled package boundaries.
- **Integer-boundary inference accounts for both zero signs.** Division and powers involving zero no longer produce unsafe integer proofs for negative-zero inputs; safely clamped results retain their supported proofs.
- **Embedded Node utilities preserve more input and lifecycle behavior.** Argument parsing and callback/promise adapters handle more Node 24 validation, metadata, and error cases. EventEmitter preserves once-listener reentrancy, symbol names, and error-monitor ordering, while StringDecoder handles more input views and split encoding boundaries.

## 0.2.1

### Features

- **More Effect 3 and Effect 4 programs compile statically.** Support expands across tested async and concurrent flows, services and layers, resource management, streams, schemas, and collections in the published packages.
- **Three.js CPU workloads cover more geometry and animation.** Geometry merging, instancing, and keyframe interpolation compile without an embedded JavaScript engine.
- **Typed-array constructors and prototype methods preserve more JavaScript behavior.** Native compilation supports constructor aliases, shared backing storage, chained indexed assignments, and mutable prototype methods with receiver dispatch.

### Fixes

- **Native installs are smaller and more portable.** GNU/Linux compiler distributions support glibc 2.34 or newer and use statically linked LLVM helpers. The compiler bundles its host runtime; cross-target runtime packs are optional project dependencies pinned to the compiler version.
- **Native values retain identity across more typed and untyped boundaries.** Collections, class instances, inferred arrays, and mixed JavaScript return values preserve their supported storage and dispatch behavior.
- **Effect platform callbacks and native streams preserve their state.** Expanded lowering retains callback behavior, and promise storage keeps the layout required by cycle collection.

## 0.2.0

### Breaking changes

- **LLVM is the only code generation backend.** C emission, the debugging C backend, and automatic C fallback have been removed. Replace `--backend=c` with the default backend, use `--emit=llvm` to inspect generated code, and change library profiles with `"emission": "c"` to `"emission": "llvm"`. `--emit=c` is no longer accepted.
- **The installed CLI is a native executable.** npm installs the matching platform package on supported macOS, Linux, and Windows hosts. Native compilation, compile-time evaluation, and native execution no longer require Node. Node 24 or newer is still required for npm installation, the JavaScript compiler API, source development, and `scriptc run` of WASI modules. Executable linking still requires the target's linker and SDK or sysroot; Zig remains required for the targets that use it.

### Features

- **scriptc ships a self-hosted native compiler.** The CLI bundles the native TypeScript 7 parser and checker, LLVM helper, precompiled C runtime pack, declarations, and compile-time evaluator. Standalone compiler archives are available alongside npm packages.
- **Published Effect generators compile statically.** With `--npm-static=effect`, the tested `Effect.gen`, `Effect.succeed`, `Effect.log`, and `Effect.runPromise` flow compiles from the unmodified package without an embedded JavaScript engine. Unsupported reachable Effect code still produces diagnostics.
- **Three.js CPU workloads compile natively and to WASI.** Static package compilation supports math, scene graphs, cameras, geometry, meshes, materials, and tested raycasting and collision queries. WebGL rendering, DOM integration, and native graphics windows remain unsupported.
- **WebAssembly libraries expose callable exports and host imports.** WASI Preview 1 reactors support library profiles, synchronous host callbacks, explicit memory ownership, and independent module instances. Browser hosts supply their own WASI adapter and rendering integration.
- **Native FFI supports more library interfaces.** Static `node:ffi` bindings add exact 64-bit and pointer ABIs, native memory views, reusable callback pools, and Darwin framework linking.
- **More ordinary JavaScript stays native.** Support expands across identity collections, numeric typed arrays, property descriptors, local class factories, callable properties, inherited fields and accessors, generator and async methods, and runtime-length argument spreads into supported signatures.

### Performance

- **Compilation does less repeated frontend work.** Syntax metadata, property lookups, library signatures, and recursive class analysis are reused, while optional-value analysis and lowering avoid redundant traversal and copying.
- **LLVM output shares recursive value converters.** Deduplicated helpers reduce generated code and the work needed to produce native objects.
- **Startup avoids unnecessary work, and release artifacts are smaller.** Host libc detection is cached, the JavaScript API loads TypeScript 5 only when needed, and release runtime packs omit development debug payloads.

### Fixes

- **Untyped JavaScript boundaries preserve more native values.** Class state, shared arrays, nullable fields, constructor results, collection identity, and typed-array backing storage retain their supported semantics across calls and storage.
- **Static library builds honor explicit package selections.** Packages named in a library profile's `npm_static` list are attempted even when they do not ship declarations.
- **Terminal and process integration handles more native behavior.** Stored process streams, terminal signals, and exception handlers that resume queued work are supported across the tested native paths.

## 0.1.7

### Features

- **Development builds support native source debugging.** `--optimization=dev` adds TypeScript and JavaScript source locations across the C and LLVM backends, with source-named variables in LLVM builds.
- **More Math operations compile statically.** Additional constants and methods include hyperbolic functions, `clz32`, `fround`, `imul`, `expm1`, and `log1p`.
- **Static Promise handling supports rejection callbacks.** `Promise.prototype.then` accepts both fulfillment and optional rejection handlers, including returned promises.
- **Static compilation accepts more package layouts.** Installed entries can compile their own TypeScript and JavaScript imports, and CommonJS packages with safe export prologues remain eligible for static compilation.
- **Fixed tuple spreads compile in tuple literals.** Const tuple inference is preserved when checked with `satisfies`.
- **Dynamic `globalThis` exposes Node host globals.** Escaping through the global object initializes the same Node globals used by embedded modules.

### Performance

- **Async and generator fibers commit stack memory on demand.** They retain their existing stack capacity while using less committed memory.
- **Development builds compute compiler fingerprints faster.** Parallel fingerprint reads preserve the existing cache identity and invalidation behavior.

### Fixes

- **Caught and rejected values preserve JavaScript object classification.** Native exception handling distinguishes objects from primitive values across catch and promise paths.
- **TypeScript project settings and Node declarations are preserved.** Built-in default imports honor effective project options, and `RequestInfo` remains available across imported sources.
- **Optional chains and dynamic option records retain supported values.** Array callbacks inside optional chains, narrowed optional receivers, and records containing abort handles compile correctly.
- **Compiler analysis handles more edge cases safely.** Deep or shared type graphs no longer overwhelm diagnostics, and property names spelled `arguments` are not treated as reads of the special binding.

## 0.1.6

### Features

- **Static Array behavior covers construction, mutation, indexing, flattening, splicing, and joining.** Array construction and iterable conversion, `fill`, `copyWithin`, relative-index coercion, `flat`, splice insertion, and join coercion now compile with JavaScript semantics.
- **Static Object and String operations expand.** Own-property checks, prototype tags, `String.prototype.at`, `codePointAt`, and `split` coercions now compile with Node-compatible behavior.

### Performance

- **Array, string, and terminal operations use fewer resources.** Array comparisons and string operations allocate less, fibers reuse stacks and release cached memory while idle, and terminal dimensions come directly from native streams.

## 0.1.5

### Features

- **Static HTTP support covers more client and server behavior.** The `node:http` surface adds request and response controls, timeout and event handling, connection shutdown behavior, and stricter header validation.
- **Static numeric APIs expand.** `Float64Array`, indexed compound assignments, and additional analytic and remaining `Math` functions compile natively.
- **Array and string search calls handle more JavaScript inputs.** Static `includes`, `lastIndexOf`, and positioned string methods accept omitted and primitive search values while preserving position coercion.
- **Published Effect modules can compile statically.** The npm-static path follows reachable exports through package modules and prunes unused package code.
- **Executable stripping is available as an opt-in build option.**

### Performance

- **LLVM emits faster numeric operations.** Proven integer arithmetic and numeric remainder use direct operations, and numeric array reads avoid redundant boxing, retains, and temporary records.

### Fixes

- **Static JavaScript coercions preserve Node behavior across more call forms.** String padding and search, `Number` conversion, and narrowed string and buffer calls now handle unions, wrappers, objects, nullish values, and omitted arguments correctly.
- **Dynamic islands load more legacy packages.** Redis 6 entry points and callable `EventEmitter` usage work with the island runtime.
- **Published LLVM helpers retain executable permissions.**
- **Switching build modes preserves reusable artifacts.**

## 0.1.4

### Features

- **Static module interoperability expands.** `node:module` coverage, CommonJS factory exports, and statically analyzable literal dynamic imports compile through the native module graph.
- **Node built-in functions work as values.** Supported `node:path`, `node:fs`, and other built-in functions can be stored and passed around while preserving static calls.
- **Static call lowering handles more JavaScript shapes.** Overloaded callable specialization, fixed-tuple argument spreads, union receiver calls, and loose equality now compile natively.
- **Compression APIs expand.** One-shot and callback-based zlib codecs compile statically.
- **Child-process APIs gain IPC and callback coverage.** `fork` supports parent-child messaging, `execFile` supports inline UTF-8 callback options, and shell output can be captured.
- **Static HTTP servers enforce Node's Host rules and support trailers.** HTTP/1.1 requests require `Host` by default and return Node-compatible 400 responses, with opt-out and HTTP/1.0 handling preserved; incoming chunk trailers expose raw and distinct values, while outgoing trailers support framing and streaming.
- **Filesystem and URL support expands.** Static filesystem support adds synchronous buffer overloads, async `realpath`, `lstat` metadata, `readdir` with `Dirent`, and descriptor operations; URLs add credential, origin, port, and hash behavior.
- **Date, process, and event APIs gain static behavior.** `Date.parse`, writable `process.exitCode`, and scoped computed `EventEmitter` names compile with Node behavior.
- **Static Set construction accepts readonly tuple seeds.** Supported readonly tuples initialize native Sets while preserving single evaluation and insertion order.

### Performance

- **LLVM bitwise operations use native integer instructions.** Numeric JavaScript bitwise operators now lower to `i32` operations on the LLVM backend.

### Fixes

- **Windows and Linux runtime builds cover more host details.** Windows executables support GUI subsystem selection and installed CMake generators, Windows runtimes include native clock and sleep shims, and GNU runtime packs preserve glibc 2.36 compatibility.
- **Static npm resolution follows package import maps.** Package-scoped imports use edge-specific conditions, and fallback Node declarations include `RequestInfo` without widening supported fetch inputs.
- **HTTP request parsing bounds and validates trailers.** Header and trailer parsing enforce byte and field-count limits, and trailer data is safely discarded when handlers respond before the request body finishes.

## 0.1.3

### Features

- **BigInt compiles natively.** BigInt literals, arithmetic, comparisons, conversions, storage, byte-buffer and `DataView` operations, and width boundaries now preserve Node behavior across the C and LLVM backends.
- **Static crypto utilities expand.** Hashes, HMACs, PBKDF2, random fills and integers, timing-safe equality, and one-shot hashing compile through the native `node:crypto` surface with Node-compatible errors.
- **Child-process stdin is writable.** `child.stdin` supports native writes, backpressure, ending, destruction, and lifecycle and error events across the C and LLVM backends.
- **Commander 15 compiles statically.** The npm-static path now preserves the declaration and runtime behavior needed by Commander 15 command actions.
- **TypeScript workspace sources compile statically.** Source-only workspace package entries now resolve through the program module graph while retaining the existing JavaScript package boundary.

### Performance

- **WASI release binaries are smaller.** Release links strip debug sections while development output retains its metadata.

### Fixes

- **Generated JSON record keys are valid.** Escaped and terminating property names now emit correctly in both native backends.
- **Windows console output preserves UTF-8.** Attached consoles use UTF-8 without changing redirected byte output.
- **Nested recursion and discarded conditionals lower correctly.** Mutual nested function references are initialized before capture, and discarded conditional expressions retain lazy control flow.
- **Library archives retain section granularity.** Per-function and per-data sections now allow consumers to garbage-collect unreferenced archive members.

## 0.1.2

### Features

- **CommonJS module graphs compile statically.** `require`, `module.exports`, `exports`, module metadata, caching, cycles, resolution, and failure eviction now follow Node semantics across compiled CommonJS graphs.
- **Async iteration parity expands.** Async generators support queued `next`/`return`/`throw` requests, promised yields, cleanup, and class, object, and private methods; `for await` closes custom async iterators and WHATWG readable streams correctly.
- **Explicit resource management compiles natively.** `using`, `await using`, `for using`, disposable Node handles, and suppressed disposal errors preserve JavaScript cleanup ordering.
- **Node module resolution introspection is supported.** `import.meta.resolve`, `require.resolve`, `require.resolve.paths`, and `module.createRequire` handle supported static requests with Node-compatible resolution and errors.
- **Static npm declarations preserve overloads.** `--npm-static` keeps overload groups from shipped declaration files while compiling package implementations, including Commander command actions.
- **Unknown values preserve native handles.** Class and child handles can round-trip through `unknown` while private fields remain hidden.

### Fixes

- **TypeScript compatibility is more faithful.** Branded primitive types, leading BOM literals, TypeScript 7 project resolution, and Node type-link behavior now retain their expected semantics.
- **Dynamic operations and runtime arguments are more reliable.** Dynamic `any`-local operators lower correctly, executable-path arguments remain intact, and URLSearchParams sorting scales without quadratic behavior.

## 0.1.1

### Fixes

- **Native package releases are more reliable.** Musl LLVM helpers build as portable static executables, downloaded helper artifacts retain executable permissions, and npm publishing reconciles asynchronous staged versions on retry.

## 0.0.37

### Features

- **Sparse arrays preserve JavaScript missing-value semantics.** Native arrays now distinguish holes from explicit `undefined` across reads, writes, callbacks, searches, sorting, serialization, destructuring, spreads, and nested consumers, with differential coverage across the C and LLVM backends.
- **Static ESM modules expose import metadata.** `import.meta.url`, `import.meta.filename`, `import.meta.dirname`, and `import.meta.main` lower to module-local constants for static ESM programs, including imported modules and WASI paths.
- **LLVM native output covers additional host and cross targets.** Matching helpers and runtime packs now support macOS x64, Linux glibc and musl, Windows x64, and WASI alongside macOS arm64.
- **Native linking is separated from C compilation.** LLVM builds can use a platform linker with program objects and precompiled runtime packs, while explicit C, fallback, and sanitizer builds retain their existing compiler path.
- **Node.js compatibility has a generated v24 matrix.** Static-native and dynamic-island support are tracked separately in a machine-readable inventory and interactive documentation.
- **`Math.PI` and `Math.E` lower to constants.** These standard library values now compile statically in programs and library profiles.

### Performance

- **Array sorting uses stable merge sort.** `sort` and `toSorted` preserve stable ties while avoiding quadratic comparator behavior on large inputs.

## 0.0.36

### Fixes

- **Library host-callback re-entry now traps deterministically.** Entering an export or library control/registration ABI symbol while a synchronous host callback is active delivers the structured `SC4026` diagnostic to the existing panic sink, attributes the attempted inner symbol, and poisons only that library instance.

### Features

- **macOS arm64 executables use release-built runtime packs.** LLVM-tier builds now emit the program object through the bundled helper and link feature-selected, hashed runtime/vendor artifacts without compiling C on the user's machine. Explicit C, LLVM fallback, and sanitizer builds retain the external C-toolchain path.
- **Builds can stop at typed IR, readable C, or textual LLVM IR.** `scriptc build --emit=ir|c|llvm` writes one primary source artifact with stable default suffixes and requires only Node—no external compiler, archiver, linker, or executable cache. `--emit=exe` remains the default, and executable builds retain the former additive `--emit-ir` flag for one release with a deprecation warning; library mode keeps its additive `--emit-ir` option.

## 0.0.35

### Performance

- **Development builds reach native output sooner.** Exact executable cache hits route through the lightweight CLI before loading the compiler, while uncached dev builds use `-O0` and split large LLVM programs and libraries into stable, parallel, independently cached objects. npm installation also warms toolchain-specific runtime, TLS, and dynamic-engine artifacts for later builds.
- **The TypeScript frontend asks the checker for less work.** Lowering batches structure, reachable-body, call, receiver, and implicit-instance queries by phase, memoizes immutable type constituents, and avoids querying dead bodies or visibly non-object array candidates.

### Fixes

- **Unsupported `Array.from` element shapes refuse cleanly.** Mapper results that the backends cannot represent are diagnosed or deferred before emission instead of reaching a C emitter crash.
- **JSDoc record equality reads preserve dynamic property behavior.** Dot and bracket reads used by strict-equality and missing-key probes now route through checked-dynamic lookup, preserving absent properties and object identity.

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
- **`Array.prototype.filter` accepts JavaScript-truthy predicate results.** Static predicates may return strings, numbers, references, or supported unions and now keep elements according to JavaScript's `ToBoolean` rules instead of requiring a boolean result. Checked-dynamic calls without a predicate reach the runtime's callback error, while predicates whose return value was erased to `void` refuse rather than producing the wrong array.

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
- **One library archive can serve an independent instance per embedder thread.** `abi.instance_per_thread` moves mutable program and runtime state into thread-local storage while keeping immutable interned data shared, preserving the existing entry family with the calling thread as the instance selector. Each thread initializes and owns its instance for its lifetime, including its collector, result arena, panic sink, and poison state. Thread instancing composes with runtime localization, remains opt-in, and leaves classic archives unchanged.

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

- **Library integer slots compose with optional numbers.** A declared `number | null` or optional-number slot projects as `optional<i64>` and proves only its present numeric values across records, tagged-message payloads, and helper parameters/returns. When two sidecar paths collapse to the same structurally interned record field, the build now refuses with both paths instead of overwriting one proof obligation without a diagnostic.

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
- **The URL-string form of the http and https clients compiles**, along with the URL-object form, which reads as its href through the same parse. The declarations only described the options record, so `http.get("http://host/path")` — the first thing a client written from scratch reaches for — was a type error rather than a request. An unparsable input is the WHATWG `Invalid URL` TypeError and a scheme that is not the calling module's is `ERR_INVALID_PROTOCOL`, both catchable, both matching Node instead of upgrading the dial to another scheme. Both rows run on the LLVM backend, as do the TLS CA-store entries, which moves the CA-store corpus off the C lane with identical output.
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
- Windows library archives carried undefined references no embedder link could resolve — the win32 libc shim unit now joins the archive for windows triples. Host archives are unchanged.
- Bytes written to a socket whose dial had not started — the agent's `maxSockets` queue, or a caller lookup still in flight — were dropped without an error, hanging the exchange. They buffer and flush at establishment.
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
- `Buffer.slice`/`subarray` and `TypedArray.subarray` are true aliasing views — mutating through a view previously computed wrong bytes.
- Math.trunc and Math.ceil compile statically.

## 0.0.10

### Features

- **Engine-held values flow through dynamic code**: values born in the embedded engine now cross into `unknown`/`object`-typed slots and back — `typeof`, strict equality, `String()`, keyed reads and writes, calls, and method dispatch route through the engine (its own prototypes run, JS-exact), with reference-preserving identity on the round trip. Unions like `string | object` compile wholesale into the checked-dynamic representation, and nullish coalescing and optional chains work on every dynamic value. Operations not yet routed throw an error that names them, and the boundary's previous wrong answers (`typeof` misreporting, phantom `.length`) are fixed.
- **`Object.create(null)`, array `entries()`/`keys()`, and variadic `Object.assign`**: real null-prototype dictionaries with Node's inspect/`toString`/comparison behavior (the dynamic tier delegates to the engine's own `Object.create` for live prototypes); live index-walking pair iterators; `Object.assign(target, ...sources)` with JavaScript's exact evaluation order and V8's position-dependent error texts.
- **Erased ambient declarations behave like Node**: chains rooted in `declare`d values compile and throw the catchable `ReferenceError` Node produces at first touch; never-read unmappable bindings vanish; nullish-cast bindings answer Node's exact `TypeError` on member access; assertion-shaped generic signatures monomorphize per call.
- **Misuse of fs, net, dgram, tls, and stream APIs throws Node's validation ladders**: argument checks run in Node's order with `ERR_*` codes and message-exact texts; `fs.exists` is genuinely async (including its no-error-argument wart), and `mkdtempSync` and `lchmod` are real.
- **Keyed writes land on dynamic receivers** (`bag[key] = value` on objects built up dynamically, with `ToPropertyKey`-exact key handling), and array destructuring walks dynamic sources with V8's exact non-iterable error wordings.
- **Library mode: profiles deny surfaces by manifest id** — a `fences` array refuses fenced surfaces reached by the compiled graph, with the profile's guidance attached as a visibly-attributed note; teachings generalize to any refusal; fence evaluation reads the same dead-stripped graph as the determinism attestation, so full fences imply a deterministic attestation by construction.

### Fixes

- Mixed engine-vs-native `deepStrictEqual` comparisons are refused with an error instead of fabricating a failure result.
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
- **The static tier**: programs compile to native code with no JavaScript engine in the binary. Type checking is the real TypeScript compiler; what compiles produces the same output as Node, enforced by a differential test corpus.
- **`--dynamic`**: an embedded JavaScript engine (quickjs-ng) executes what cannot compile statically. Values crossing back into static code are validated at runtime, so a mismatched type throws a catchable `TypeError`. Static remains the default; a binary includes the engine only when `--dynamic` is passed.
- **npm dependencies** (with `--dynamic`): packages resolve with Node's own resolution algorithm, typecheck against their shipped `.d.ts`, and their JavaScript is embedded into the binary at build time. Binaries never read `node_modules` at runtime.
- **Platforms**: macOS arm64 is the primary platform; Linux and Windows binaries build by cross-compilation, each verified by its own differential test lane.
