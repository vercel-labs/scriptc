# Changelog

All notable changes to scriptc will be documented in this file.

## Unreleased

<!-- release:start -->

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

<!-- release:end -->

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
