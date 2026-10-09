import type { IrType } from "./ir.js";
import { BIGINT_T } from "./ir.js";
import {
  arrayOf,
  BOOL,
  BYTES_U8,
  bytesOf,
  CHILD_T,
  CHILDSTREAM_T,
  CHILDWRITER_T,
  CRYPTOHASH_T,
  CRYPTOHMAC_T,
  DATE_T,
  DGRAMSOCK_T,
  DYN,
  F64,
  FILEHANDLE_T,
  FSWATCHER_T,
  HTTP2SESSION_T,
  HTTP2STREAM_T,
  HTTPCLIENTREQ_T,
  HTTPREQ_T,
  HTTPRES_T,
  JSVAL,
  NETSERVER_T,
  NETSOCKET_T,
  PROCSTREAM_T,
  REGEX,
  SEARCH_PARAMS_T,
  SECURECTX_T,
  SPAWNRES_T,
  STATS_T,
  STRING,
  SYMBOL_T,
  TESTCTX_T,
  URL_T,
  VOID,
} from "./ir.js";

/** Runtime call slots. A null argument accepts a program-dependent type;
 * VOID can mark a program-dependent result. The validator checks those
 * cases against the call and module rather than treating them as wildcards. */
export interface LibFnSignature {
  argTypes: (IrType | null)[];
  result: IrType;
}

/** Preserve the closed names while giving every entry the same slot type. */
function defineLibFnSignatures<Name extends string>(
  signatures: Record<Name, LibFnSignature>,
): Record<Name, LibFnSignature> {
  return signatures;
}

/** The closed native builtin call surface. Keep a call's semantics and ABI
 * together here; frontend coercion and IR validation consume the same table.
 * All arguments are required. Lowering supplies optional-source defaults
 * before this boundary and preserves their evaluation order. */
export const LIB_FN_SIGS = defineLibFnSignatures({
  /** Native static fetch and its Web-platform companions. fetch.start
   * answers once the response head arrives; the response body readers
   * consume the native body stream. AbortSignal and ReadableStream values
   * are opaque checked-dynamic handles. */
  "fetch.start": { argTypes: [STRING, DYN], result: { kind: "promise", inner: DYN } },
  "fetch.responseNew": { argTypes: [DYN, DYN], result: DYN },
  "fetch.input": { argTypes: [DYN, DYN], result: { kind: "promise", inner: DYN } },
  "abort.controllerNew": { argTypes: [], result: DYN },
  "abort.timeout": { argTypes: [DYN], result: DYN },
  "abort.now": { argTypes: [DYN], result: DYN },
  "abort.any": { argTypes: [DYN], result: DYN },
  "fetch.function": { argTypes: [], result: DYN },
  "fetch.requestNew": { argTypes: [DYN, DYN], result: DYN },
  "fetch.headersNew": { argTypes: [DYN], result: DYN },
  "fetch.responseArrayBuffer": { argTypes: [DYN], result: { kind: "promise", inner: DYN } },
  "fetch.responseJson": { argTypes: [DYN], result: { kind: "promise", inner: DYN } },
  "fetch.responseText": { argTypes: [DYN], result: { kind: "promise", inner: STRING } },
  "fetch.responseBytes": { argTypes: [DYN], result: { kind: "promise", inner: BYTES_U8 } },
  "fetch.abortControllerNew": { argTypes: [], result: DYN },
  "fetch.abortTimeout": { argTypes: [DYN], result: DYN },
  "fetch.abortNow": { argTypes: [DYN], result: DYN },
  "fetch.abortAny": { argTypes: [DYN], result: DYN },
  "fetch.streamNew": { argTypes: [DYN], result: DYN },
  // Program-dependent iterable: typed arrays/bytes/string stay intact so
  // the native stream can pull lazily; checked-dynamic values are the
  // fallback. The libCall validator in validate.ts checks the closed set.
  "fetch.webIs": { argTypes: [DYN, STRING], result: BOOL },
  "fetch.streamIs": { argTypes: [DYN], result: BOOL },
  "fetch.streamFrom": { argTypes: [null], result: DYN },
  // The chunk/result record depends on ReadableStream<T>; validated by validate.ts.
  "fetch.readerRead": { argTypes: [DYN], result: VOID },
  "island.eval": { argTypes: [STRING], result: STRING },
  /** Load an embedded npm package's runtime entry in the island (cached by
   * the engine's module registry) and take one export: args are the entry
   * KEY (an embedded module's key, from IrModule.embedded) and the export
   * name — "default" for default imports, "*" for the namespace object.
   * --dynamic only, like island.eval; result is an owned jsval. May throw
   * (a package's top-level code can), bridged catchably. */
  "island.import": { argTypes: [STRING, STRING, STRING], result: JSVAL },
  /** Dynamic `import(spec)`: load a module through the island's module
   * system — an embedded module's key or a builtin shim's "node:x" key —
   * and answer an ENGINE promise of its namespace object (always a
   * promise, never a throw: load and evaluation failures REJECT it,
   * Node's shape). The frontend wraps the result in jsBridgePromise, so
   * awaiting parks the fiber and a rejection crosses catchably. --dynamic
   * only; result is an owned jsval holding the engine promise. */
  "island.importDyn": { argTypes: [STRING], result: JSVAL },
  // Result is the cast's mapped PROMISE target (program-dependent) —
  // checked in the libCall case, like error.new.
  /** A checked cast the boundary can never satisfy, DEFERRED to runtime:
   * `islandValue as Promise<T>` — the value is an ENGINE promise and T
   * has no validated exit (Node-typed async APIs put class-shaped
   * interfaces there), so instead of refusing the build the cast throws a
   * catchable TypeError AT THE CAST naming the target type (args: the
   * island value — evaluated, borrowed — and the type name). The result
   * type is the cast's mapped target (a typed dummy; the exception is
   * pending). Documented divergence: JS `as` never checks — like the dyn
   * boundary, a conversion that cannot happen throws instead of lying.
   * --dynamic only. */
  "island.castFail": { argTypes: [JSVAL, STRING], result: VOID },
  "json.parse": { argTypes: [STRING], result: DYN },
  "json.parseReviver": { argTypes: [STRING, DYN], result: DYN },
  "json.stringifyReplacer": { argTypes: [DYN, DYN, STRING], result: DYN },
  "json.stringifyValue": { argTypes: [DYN, DYN, DYN], result: DYN },
  /** Keyed WRITE on a dyn value — `h.onDone = cb` / `h["k"] = v` on a
   * checked-dynamic object (args: receiver, key string, value — all
   * borrowed; the runtime copies the key and retains the value in). An
   * OBJ receiver sets the member (later writes win, insertion order
   * preserved — JS exactly); undefined/null throws Node's catchable
   * "Cannot set properties of undefined (setting 'k')"; every other kind
   * throws Node's STRICT-mode "Cannot create property 'k' on <kind>" —
   * primitives quoting their rendering, V8's "on number '5'"
   * (sloppy mode would silently ignore — suite tests are 'use strict';
   * SEMANTICS.md notes the sloppy divergence: loud, never silent). Void
   * result; in the may-throw seed set. */
  "dyn.keySet": { argTypes: [DYN, STRING, DYN], result: VOID },
  "dyn.keySetComputed": { argTypes: [DYN, DYN, DYN], result: VOID },
  /** Delete an ordinary checked-native object's own key. Borrows both
   * arguments; other receiver representations retain a runtime refusal. */
  "dyn.keyDelete": { argTypes: [DYN, STRING, BOOL], result: VOID },
  "dyn.keyDeleteComputed": { argTypes: [DYN, DYN, BOOL], result: VOID },
  "dyn.hasKeyComputed": { argTypes: [DYN, DYN], result: BOOL },
  "dyn.hasOwnComputed": { argTypes: [DYN, DYN], result: BOOL },
  "dyn.propertyIsEnumerableComputed": { argTypes: [DYN, DYN], result: BOOL },
  /** Native own properties on globalThis keyed by symbol identity. */
  "dyn.globalSymbolGet": { argTypes: [SYMBOL_T], result: DYN },
  "dyn.globalSymbolSet": { argTypes: [SYMBOL_T, DYN], result: VOID },
  "dyn.globalSymbolHas": { argTypes: [SYMBOL_T], result: BOOL },
  "dyn.globalSymbolDelete": { argTypes: [SYMBOL_T], result: VOID },
  /** Exact native class capsule identity, without materializing its fields. */
  "dyn.typedRefIs": { argTypes: [DYN, STRING], result: BOOL },
  "dyn.classIs": { argTypes: [DYN, STRING], result: BOOL },
  /** Destructuring pack over a dyn source — `const [a, b] = d`, a
   * destructured dyn callback param (args: the source and the STATIC
   * TypeError spelling, "" when the source has none — both borrowed;
   * result: a fresh dyn array, +1). Iterable kinds collect like spread
   * (arrays element-by-element, strings by code point, bytes by byte);
   * every other kind throws V8's destructuring TypeError — the spelling
   * verbatim when non-empty, else the runtime kind wording ("number 5 is
   * not iterable (cannot read property Symbol(Symbol.iterator))"). In the
   * may-throw seed set. */
  "dyn.iterPack": { argTypes: [DYN, STRING], result: DYN },
  "dyn.arrayFromIterator": { argTypes: [DYN], result: DYN },
  "dyn.iterator": { argTypes: [DYN, STRING], result: DYN },
  "dyn.iteratorResult": { argTypes: [DYN], result: DYN },
  "dyn.iteratorCanStep": { argTypes: [DYN, DYN], result: BOOL },
  "dyn.iteratorStep": { argTypes: [DYN], result: DYN },
  "dyn.iteratorStepDone": { argTypes: [DYN], result: BOOL },
  "dyn.mapSeedEntries": { argTypes: [DYN], result: DYN },
  "dyn.mapSeedEntry": { argTypes: [DYN], result: DYN },
  /** The for-of-over-dyn pack accessors — the emitted index loop drives
   * them over a dyn.iterPack result (ARR by construction). arrLen: the
   * ARR length as f64 (0 for non-ARR kinds; arg borrowed). arrAt: the
   * element at index (+1; the undefined singleton past the end). Neither
   * throws. */
  "dyn.arrLen": { argTypes: [DYN], result: F64 },
  "dyn.arrAt": { argTypes: [DYN, F64], result: DYN },
  /** `key in v` with a RUNTIME (string) key on a checked-dynamic
   * receiver (args: value dyn, key string; result bool): OBJ answers
   * own-member presence, ARR answers 'length'/a valid index — exactly
   * the literal-key dynHasKey path. Proxy has traps may throw. */
  "dyn.hasKey": { argTypes: [DYN, STRING], result: BOOL },
  "dyn.freeze": { argTypes: [DYN], result: DYN },
  "dyn.isFrozen": { argTypes: [DYN], result: BOOL },
  "dyn.nativeSetNew": { argTypes: [DYN], result: DYN },
  "dyn.nativeSetIs": { argTypes: [DYN], result: BOOL },
  "dyn.nativeMapIs": { argTypes: [DYN], result: BOOL },
  "dyn.nativeUrlIs": { argTypes: [DYN], result: BOOL },
  "dyn.nativeDateIs": { argTypes: [DYN], result: BOOL },
  "date.nativeNew": { argTypes: [DYN], result: DYN },
  "date.checkedValue": { argTypes: [DYN], result: DATE_T },
  "dyn.nativeRegexIs": { argTypes: [DYN], result: BOOL },
  /** toString() on a checked-dynamic receiver: runtime kind dispatch
   * (bytes decode per the literal encoding — utf8 default; strings,
   * numbers, booleans, arrays, objects answer JS-exactly; undefined and
   * null throw the catchable TypeError). */
  "dyn.toString": { argTypes: [DYN, DYN, STRING], result: STRING },
  /** Object.defineProperties over dyn values (args: target, descriptors —
   * both borrowed dyn; result: the target, +1 — JS's return value).
   * Value descriptors become own properties on OBJ and FUNC targets;
   * OBJ targets preserve data attributes. get/set
   * descriptors and non-object targets/descriptors throw catchably
   * (Node's TypeError texts; accessors the loud unsupported Error). In
   * the may-throw seed set. */
  "dyn.defineProps": { argTypes: [DYN, DYN], result: DYN },
  "dyn.defineProperty": { argTypes: [DYN, DYN, DYN], result: DYN },
  "dyn.getOwnPropertyDescriptor": { argTypes: [DYN, DYN], result: DYN },
  "dyn.arrayProtoCall": { argTypes: [DYN, STRING, DYN], result: DYN },
  "dyn.promiseAll": { argTypes: [DYN], result: { kind: "promise", inner: DYN } },
  /** Bare `typeof v` on a dyn value AS A STRING (arg: the dyn value,
   * borrowed; result: an owned string) — the dyn kind's JS answer:
   * undefined→"undefined", null/object/array/bytes→"object" (JS's oldest
   * wart preserved), boolean/number/string by kind, function→"function".
   * Never throws. */
  "dyn.typeof": { argTypes: [DYN], result: STRING },
  /** Object.prototype.toString.call on a checked-dynamic value. */
  "dyn.objectTag": { argTypes: [DYN], result: STRING },
  /** Engine-free CommonJS module graph. Module values are scalar f64
   * handles; generated startup defines the registry, init wrappers update
   * loading/cache state, and the read surface answers Node's live metadata. */
  "module.registryInit": { argTypes: [F64], result: VOID },
  "module.define": { argTypes: [F64, STRING, STRING, STRING, arrayOf(STRING), BOOL], result: VOID },
  "module.enter": { argTypes: [F64], result: VOID },
  "module.link": { argTypes: [F64, F64], result: VOID },
  "module.finish": { argTypes: [F64], result: VOID },
  "module.fail": { argTypes: [F64], result: VOID },
  "module.filename": { argTypes: [F64], result: STRING },
  "module.id": { argTypes: [F64], result: STRING },
  "module.path": { argTypes: [F64], result: STRING },
  "module.paths": { argTypes: [F64], result: arrayOf(STRING) },
  "module.children": { argTypes: [F64], result: arrayOf(F64) },
  "module.parent": { argTypes: [F64], result: F64 },
  "module.loaded": { argTypes: [F64], result: BOOL },
  "module.cacheGet": { argTypes: [STRING], result: F64 },
  "module.cacheHas": { argTypes: [STRING], result: BOOL },
  "module.cacheKeys": { argTypes: [], result: arrayOf(STRING) },
  "timers.setTimeout": { argTypes: [{ kind: "func", params: [], ret: VOID }, F64], result: VOID },
  /** The repeating timer pair. setInterval takes (callback, ms) like
   * setTimeout and RETURNS the f64 handle the fallback declarations
   * promise (ids start at 1, so truthiness narrowing works); the loop
   * owns the callback until clearInterval removes the entry (eagerly — a
   * live interval keeps the loop alive, a cleared one releases it, like
   * Node). Neither throws; a throw ESCAPING an interval callback ends the
   * program like a setTimeout throw. */
  "timers.setInterval": { argTypes: [{ kind: "func", params: [], ret: VOID }, F64], result: F64 },
  "timers.clearInterval": { argTypes: [F64], result: VOID },
  /** setTimeout WITH a clear handle (the f64 id) — the clearable/unref-able
   * one-shot; clearTimeout cancels it, .unref() drops it from loop
   * liveness. The plain timers.setTimeout stays the handle-less
   * fire-and-forget. */
  "timers.setTimeoutHandle": {
    argTypes: [{ kind: "func", params: [], ret: VOID }, F64],
    result: F64,
  },
  "timers.clearTimeout": { argTypes: [F64], result: VOID },
  /** Timeout.unref()/ref()/hasRef() — loop-liveness bookkeeping over the
   * handle id. unref/ref RETURN the handle (f64) for chaining; hasRef
   * returns bool. */
  "timers.unref": { argTypes: [F64], result: F64 },
  "timers.ref": { argTypes: [F64], result: F64 },
  "timers.hasRef": { argTypes: [F64], result: BOOL },
  /** Timeout.refresh() — re-arm to now + the original delay (from the
   * heap or from inside the firing callback; a one-shot that fired on an
   * earlier turn is gone and no-ops — documented divergence). Returns
   * the handle for chaining like unref/ref. */
  "timers.refresh": { argTypes: [F64], result: F64 },
  /** setImmediate/clearImmediate — Node's check phase: callbacks run
   * once per loop turn AFTER due timers, FIFO, and immediates queued
   * mid-phase wait for the next turn. setImmediate returns the f64
   * handle (its own id space — clearTimeout of an Immediate no-ops,
   * like Node); the Immediate ref trio mirrors the Timeout one (an
   * unref'd pending immediate neither keeps the loop alive nor fires
   * once nothing reffed remains). */
  "timers.setImmediate": { argTypes: [{ kind: "func", params: [], ret: VOID }], result: F64 },
  /** queueMicrotask (scr_async.c): the callback enters the SAME FIFO
   * promise continuations ride — one microtask order, like V8's queue —
   * and a throw is an UNCAUGHT exception (never a rejection).
   * timers.queueMicrotask takes an owned zero-param closure and never
   * throws; the Dyn form (checked-dynamic arguments — the mustCall
   * wrapper, the suite's invalid-input probes) throws Node's
   * ERR_INVALID_ARG_TYPE synchronously on a non-function value and calls
   * the function with zero arguments at drain. */
  "timers.queueMicrotask": { argTypes: [{ kind: "func", params: [], ret: VOID }], result: VOID },
  "timers.queueMicrotaskDyn": { argTypes: [DYN], result: VOID },
  "timers.clearImmediate": { argTypes: [F64], result: VOID },
  /** process.nextTick(cb, ...args) — the user tick queue. args: [cb
   * (() => void; trailing call arguments ride the timer surface's
   * interned dyn thunk)]. Ticks drain BEFORE promise jobs at every loop
   * checkpoint, to joint exhaustion with them (Node's tick-then-
   * microtask order); ticks enqueued by station listeners run at the
   * NEXT checkpoint (the stream-tick station divergence, SEMANTICS.md).
   * Pending ticks are always-ready work — the loop neither sleeps nor
   * exits while any exist; ticks scheduled from 'exit' listeners never
   * run (Node). The enqueue itself never throws. */
  "process.nextTick": { argTypes: [{ kind: "func", params: [], ret: VOID }], result: VOID },
  /** The process introspection statics. uptime: seconds since the
   * binary's own start (fractional — a load-time monotonic anchor).
   * availableMemory/constrainedMemory: libuv's numbers (free-ish bytes;
   * the cgroup cap or 0). cpuUser/cpuSystem (+ threadCpu twins): the
   * process/thread CPU clocks in microseconds — the frontend composes
   * the {user, system} records. The *Diff forms answer current − prev
   * for one field; cpuPrevValidate throws Node's ERR_INVALID_ARG_VALUE
   * RangeError for negative/non-finite prev fields (user first, then
   * system — Node's order; MAY THROW). rusage(idx): one
   * process.resourceUsage() field by canonical index (Node's units).
   * activeResources: the loop's own bookkeeping — 'Timeout' per armed
   * (or firing, uncleared) timer, 'Immediate' per queued unfired
   * immediate; unmodeled resource kinds are absent (SEMANTICS.md). */
  "process.uptime": { argTypes: [], result: F64 },
  /** perf_hooks performance.now(): fractional ms since process start. */
  "perf.now": { argTypes: [], result: F64 },
  "process.availableMemory": { argTypes: [], result: F64 },
  "process.constrainedMemory": { argTypes: [], result: F64 },
  "process.cpuUser": { argTypes: [], result: F64 },
  "process.cpuSystem": { argTypes: [], result: F64 },
  "process.cpuUserDiff": { argTypes: [F64], result: F64 },
  "process.cpuSystemDiff": { argTypes: [F64], result: F64 },
  "process.threadCpuUser": { argTypes: [], result: F64 },
  "process.threadCpuSystem": { argTypes: [], result: F64 },
  "process.threadCpuUserDiff": { argTypes: [F64], result: F64 },
  "process.threadCpuSystemDiff": { argTypes: [F64], result: F64 },
  "process.cpuPrevValidate": { argTypes: [F64, F64], result: VOID },
  "process.rusage": { argTypes: [F64], result: F64 },
  "process.activeResources": { argTypes: [], result: arrayOf(STRING) },
  "timers.immediateUnref": { argTypes: [F64], result: F64 },
  "timers.immediateRef": { argTypes: [F64], result: F64 },
  "timers.immediateHasRef": { argTypes: [F64], result: BOOL },
  /** The tolerated non-handle clear (`clearTimeout(null)`,
   * `clearInterval({})`, zero-argument forms): Node silently ignores
   * anything that is not a live handle — a VOID no-op the emitter drops
   * (only syntactically side-effect-free arguments take this path). */
  "timers.clearNoop": { argTypes: [], result: VOID },
  // Signal listeners are zero-param (the ambient shape); exit/stdin
  // callbacks carry program-dependent one-param shapes — null slots, the
  // libCall case checks them (child.onExit precedent).
  /** Named process signal events: [name string, callback dyn, once bool]
   * or [name, callback] for removal. The runtime resolves platform signal
   * numbers and delivers (name, number). Listeners do not keep the loop
   * alive. Invalid callbacks and uncatchable signals throw. */
  "process.onSignal": { argTypes: [STRING, DYN, BOOL], result: VOID },
  "process.offSignal": { argTypes: [STRING, DYN], result: VOID },
  /** The process 'exit' event — process.on/once/off("exit"). args: [cb,
   * once bool] / [cb]. Listeners run SYNCHRONOUSLY at termination
   * (normal exit, process.exit(), the uncaught/unhandled exit-1 paths)
   * with the exit code; anything they schedule never runs, like Node.
   * Callback shapes: () => void or (code: number) => void — the emitter
   * picks the runtime adapter. Never throw. */
  "process.onExit": { argTypes: [null, BOOL], result: VOID },
  "process.offExit": { argTypes: [null], result: VOID },
  /** process.stdin listener registration — stdin.on/once("data" | "end" |
   * "error", cb). args: [cb, once bool]. data callbacks: () => void or
   * (chunk: Uint8Array) => void; end: () => void; error: () => void or
   * (err: Error) => void (the child error adapters are reused). While a
   * data listener (or a parked for-await chunk promise) exists, stdin
   * keeps the loop alive — Node's flowing-stdin keep-alive. Never
   * throw. */
  "stdin.onData": { argTypes: [null, BOOL], result: VOID },
  "stdin.onEnd": { argTypes: [{ kind: "func", params: [], ret: VOID }, BOOL], result: VOID },
  "stdin.onError": { argTypes: [null, BOOL], result: VOID },
  /** The for-await chunk source over process.stdin: no args, result
   * Promise<Uint8Array> (+1). Fulfills with the next arrived chunk; the
   * EMPTY bytes value is the done sentinel (POSIX reads never deliver
   * empty data chunks), which the for-await desugar turns into loop
   * exit. Never throws itself; awaiting it re-throws nothing (stdin
   * errors surface through 'error' listeners, not the iterator). */
  "stdin.nextChunk": { argTypes: [], result: { kind: "promise", inner: BYTES_U8 } },
  "fs.readFileSync": { argTypes: [STRING, STRING], result: STRING },
  "fs.readFileEncoded": { argTypes: [STRING, STRING], result: STRING },
  "fs.readFdEncoded": { argTypes: [F64, STRING], result: STRING },
  /** readFileSync(path) — the Buffer read (+1 bytes); throws catchably
   * like the utf8 form. */
  "fs.readFileSyncBuf": { argTypes: [STRING], result: BYTES_U8 },
  /** readFileSync(path, enc) with a RUNTIME encoding (an untyped JS
   * parameter): undefined/null answer Buffers, utf8 a string, other real
   * encodings fence loudly, unknown names throw ERR_UNKNOWN_ENCODING. */
  "fs.readFileSyncDyn": { argTypes: [STRING, DYN], result: DYN },
  "fs.writeFileSync": { argTypes: [STRING, STRING], result: VOID },
  "fs.appendFileSync": { argTypes: [STRING, STRING], result: VOID },
  "fs.existsSync": { argTypes: [STRING], result: BOOL },
  "fs.mkdirSync": { argTypes: [STRING], result: VOID },
  "fs.rmSync": { argTypes: [STRING], result: VOID },
  "fs.rmdirSync": { argTypes: [STRING], result: VOID },
  "fs.readdirSync": { argTypes: [STRING], result: arrayOf(STRING) },
  // Result is the call site's Dirent record array (VOID is the
  // structure-checked sentinel, the os.networkInterfaces pattern).
  /** `fs.readdirSync(path, { withFileTypes: true })` — Dirent rows over
   * one readdir pass (scr_lib.c's scandir snapshot; DT_UNKNOWN falls back
   * to lstat, Node's getDirents rule). The result type is the call site's
   * interned Dirent record array (name, parentPath, hidden %dtype in
   * libuv's UV_DIRENT encoding) — verified by the frontend; the emitter
   * assembles the rows from the snapshot. OS order, no "."/"..". Throws
   * Node's scandir errno error (may-throw seed set); fresh +1 array. */
  "fs.readdirTypesSync": { argTypes: [STRING], result: VOID },
  /** node:path (scr_path.c ports BOTH of Node's implementations
   * function-by-function): the `path.*` family is posix, the
   * `path.win32*` family is Node v24's path.win32 byte-for-byte — the
   * frontend binds the bare module to the TARGET platform's family
   * (Node on Windows IS path.win32) and the path.posix / path.win32
   * namespaces to their own family everywhere. join and resolve take ONE
   * string[] arg — the frontend packs the variadic call's arguments into
   * an array literal. basename always receives its suffix (the frontend
   * completes an omitted one with "", a Node no-op). toNamespacedPath is
   * the posix identity and the win32 \\?\-prefixer. None of these throw;
   * the resolves consult the process cwd like Node's. */
  "path.join": { argTypes: [arrayOf(STRING)], result: STRING },
  "path.resolve": { argTypes: [arrayOf(STRING)], result: STRING },
  "path.normalize": { argTypes: [STRING], result: STRING },
  "path.dirname": { argTypes: [STRING], result: STRING },
  "path.basename": { argTypes: [STRING, STRING], result: STRING },
  "path.extname": { argTypes: [STRING], result: STRING },
  "path.isAbsolute": { argTypes: [STRING], result: BOOL },
  "path.relative": { argTypes: [STRING, STRING], result: STRING },
  "path.toNamespacedPath": { argTypes: [STRING], result: STRING },
  "path.win32Join": { argTypes: [arrayOf(STRING)], result: STRING },
  "path.win32Resolve": { argTypes: [arrayOf(STRING)], result: STRING },
  "path.win32Normalize": { argTypes: [STRING], result: STRING },
  "path.win32Dirname": { argTypes: [STRING], result: STRING },
  "path.win32Basename": { argTypes: [STRING, STRING], result: STRING },
  "path.win32Extname": { argTypes: [STRING], result: STRING },
  "path.win32IsAbsolute": { argTypes: [STRING], result: BOOL },
  "path.win32Relative": { argTypes: [STRING, STRING], result: STRING },
  "path.win32ToNamespacedPath": { argTypes: [STRING], result: STRING },
  /** node:os: homedir is $HOME else getpwuid(3); tmpdir is Node's env
   * cascade ($TMPDIR/$TMP/$TEMP else /tmp, one trailing slash trimmed).
   * os.platform() lowers to process.platform — one implementation. */
  "os.homedir": { argTypes: [], result: STRING },
  /** os.release(): uname(2)'s release field — Node's own implementation
   * (the kernel version string, e.g. "24.6.0" on macOS 15). Interned; +1
   * per read. Never throws. */
  "os.release": { argTypes: [], result: STRING },
  /** os.type(): uname(2)'s sysname ("Darwin", "Linux"; "Windows_NT" on
   * win32) — Node's uv_os_uname answer. Interned per call; never throws. */
  "os.type": { argTypes: [], result: STRING },
  /** os.totalmem(): total physical memory in bytes. Never throws. */
  "os.totalmem": { argTypes: [], result: F64 },
  /** umask(2): arg < 0 reads without setting (umask has no read-only form
   * — set 0, restore); otherwise sets and answers the PREVIOUS mask.
   * Never throws. */
  "process.umask": { argTypes: [F64], result: F64 },
  /** chdir(2) — throws Node's fs-shaped error (ENOENT/EACCES/ENOTDIR,
   * syscall "chdir") on failure. */
  "process.chdir": { argTypes: [STRING], result: VOID },
  "process.loadEnvFile": { argTypes: [DYN], result: VOID },
  /** process._exiting: true once the exit sequence began (exit listeners
   * running) — the runtime flag scr_run_exit_listeners/process.exit set.
   * Never throws. */
  "process.exiting": { argTypes: [], result: BOOL },
  /** net's process-wide happy-eyeballs attempt budget (Node's default
   * 250ms): one runtime double in the core unit, so reading/writing it
   * never forces the net unit into the link. Never throw. */
  "net.getAutoSelTimeout": { argTypes: [], result: F64 },
  "net.setAutoSelTimeout": { argTypes: [F64], result: VOID },
  /** realpath(3) with Node's error shape (syscall "lstat" in the message,
   * Node's own spelling for realpathSync failures). +1 fresh string. */
  "fs.realpathSync": { argTypes: [STRING], result: STRING },
  /** Native realpath with syscall "realpath" on failure. +1 fresh string. */
  "fs.realpathNativeSync": { argTypes: [STRING], result: STRING },
  /** The os.userInfo() field trio (uv_os_get_passwd's slices): pw_name,
   * pw_shell, pw_dir — the PASSWD homedir, not os.homedir's $HOME-first
   * cascade (Node's own split). The frontend assembles the UserInfo
   * record from these plus getuid/getgid. +1 fresh strings; a passwd
   * lookup failure aborts (Node throws a system error there — no
   * compiled program path reaches it for the running uid). */
  "os.userName": { argTypes: [], result: STRING },
  "os.userShell": { argTypes: [], result: STRING },
  "os.userHomedir": { argTypes: [], result: STRING },
  "os.tmpdir": { argTypes: [], result: STRING },
  // Result is the call site's Dict<NetworkInterfaceInfo[]> record (VOID is
  // the dgram.address sentinel — the libCall case checks the structure).
  /** os.networkInterfaces(): getifaddrs(3) → the Dict<NetworkInterfaceInfo[]>
   * record, built inline by the emitter from a runtime snapshot (scr_lib.c).
   * The result type is the CALL SITE's mapped @types/node shape — a pure
   * index-signature record whose value is `Info[] | undefined`, Info a
   * two-record union (IPv4: scopeid `number | undefined` holding undefined;
   * IPv6: scopeid number) — verified structurally by the frontend. Rows
   * match libuv's filter (IFF_UP && IFF_RUNNING, AF_INET/AF_INET6; loopback
   * = internal; MACs from the interface's link-level sibling entry, zeros
   * when absent; cidr from the netmask's contiguous prefix, the null arm
   * when it is missing or non-contiguous). Key/row order follows the OS's
   * getifaddrs enumeration — Node itself does not guarantee an order.
   * Fresh +1 record; never throws (a getifaddrs failure yields {}). */
  "os.networkInterfaces": { argTypes: [], result: VOID },
  /** `Math.max(...xs)` / `Math.min(...xs)` over one spread number[]
   * (scr_number.c): the JS fold exactly — any NaN element poisons the
   * result, ±0 order by the JS comparison (max prefers +0, min prefers
   * -0), and the empty array yields -Infinity / +Infinity like the
   * zero-argument calls. Borrows the array; never throws. */
  "math.maxArr": { argTypes: [arrayOf(F64)], result: F64 },
  "math.minArr": { argTypes: [arrayOf(F64)], result: F64 },
  "math.hypotArr": { argTypes: [arrayOf(F64)], result: F64 },
  /** `Math.floor(x)` — C floor() IS the JS operation (NaN/±0/±Infinity
   * pass through bit-exactly). Never throws. */
  "math.floor": { argTypes: [F64], result: F64 },
  /** Math.abs (C fabs — IS the JS operation) and Math.round (scr_lib.c:
   * ECMA half-toward-+Infinity with the exact-fraction comparison — C
   * round() is half-away-from-zero and floor(x+0.5) drifts at the
   * epsilon boundary). Borrow nothing; never throw. */
  "math.abs": { argTypes: [F64], result: F64 },
  "math.round": { argTypes: [F64], result: F64 },
  /** Math.trunc / Math.ceil — C trunc()/ceil() ARE the JS operations
   * (NaN/±0/±Infinity pass through bit-exactly; ceil(-0.5) is -0 in IEEE
   * round-toward-+Infinity exactly as ECMA says). Static like floor —
   * they are ask-4's wholeness-discharge operators, so the library
   * inference needs them compiled, not island-served. Never throw. */
  "math.trunc": { argTypes: [F64], result: F64 },
  "math.ceil": { argTypes: [F64], result: F64 },
  "math.sin": { argTypes: [F64], result: F64 },
  "math.sinh": { argTypes: [F64], result: F64 },
  "math.cos": { argTypes: [F64], result: F64 },
  "math.cosh": { argTypes: [F64], result: F64 },
  "math.tan": { argTypes: [F64], result: F64 },
  "math.tanh": { argTypes: [F64], result: F64 },
  "math.asin": { argTypes: [F64], result: F64 },
  "math.asinh": { argTypes: [F64], result: F64 },
  "math.acos": { argTypes: [F64], result: F64 },
  "math.acosh": { argTypes: [F64], result: F64 },
  "math.atan": { argTypes: [F64], result: F64 },
  "math.atanh": { argTypes: [F64], result: F64 },
  "math.cbrt": { argTypes: [F64], result: F64 },
  "math.clz32": { argTypes: [F64], result: F64 },
  /** Return -1, +1, or the original NaN/zero. In particular, -0 remains -0. */
  "math.sign": { argTypes: [F64], result: F64 },
  "math.exp": { argTypes: [F64], result: F64 },
  "math.expm1": { argTypes: [F64], result: F64 },
  "math.fround": { argTypes: [F64], result: F64 },
  "math.sqrt": { argTypes: [F64], result: F64 },
  "math.log": { argTypes: [F64], result: F64 },
  "math.log1p": { argTypes: [F64], result: F64 },
  "math.log2": { argTypes: [F64], result: F64 },
  "math.log10": { argTypes: [F64], result: F64 },
  "math.atan2": { argTypes: [F64, F64], result: F64 },
  "math.pow": { argTypes: [F64, F64], result: F64 },
  "math.imul": { argTypes: [F64, F64], result: F64 },
  /** `Math.min(a, b)` / `Math.max(a, b)` — the two-argument scalar forms
   * (scr_lib.c), JS-exact like the Arr folds: NaN poisons, max prefers +0
   * over -0 (min the reverse). C fmin/fmax are NOT these (they drop NaN).
   * Never throw. */
  "math.min": { argTypes: [F64, F64], result: F64 },
  "math.max": { argTypes: [F64, F64], result: F64 },
  /** `Math.random()` — a uniform double in [0,1) with the spec's 53-bit
   * granularity, drawn from arc4random_buf (the CSPRNG behind the crypto
   * lowerings). Same distribution as Node, NECESSARILY different sequence
   * (SEMANTICS.md 62 — no seeded sequence exists to match). Never throws. */
  "math.random": { argTypes: [], result: F64 },
  /** The static global parsers/tests (scr_string.c). num.parseInt is
   * ECMA-262 19.2.5 exactly — JS whitespace, sign, ToInt32 radix (the
   * frontend completes an omitted radix to 0 = the spec's "undefined":
   * base 10 with the 0x hex escape), longest digit prefix, and the exact
   * mathematical value correctly rounded (u64 fast path, bignum beyond —
   * overflow is ±Infinity). num.isNaN is the NaN self-test on an
   * already-number argument (tsc pins the argument to number, so no
   * ToNumber coercion exists to model). Borrow; never throw. */
  "num.parseInt": { argTypes: [STRING, F64], result: F64 },
  /** ES parseFloat (scr_string.c): the longest StrDecimalLiteral prefix
   * of the trimmed input (no hex, "Infinity" exact-case), NaN when none —
   * ECMA-262 19.2.4 over a string argument (non-string arguments keep the
   * fence: Node would ToNumber-coerce). Borrows; never throws. */
  "num.parseFloat": { argTypes: [STRING], result: F64 },
  /** `a.localeCompare(b)`: -1/0/1 in Node's root-locale collation for
   * Latin-script text (scr_str_locale_compare). Never throws. */
  "str.localeCompare": { argTypes: [STRING, STRING], result: F64 },
  /* ToNumber(string) — ECMA-262 7.1.4.1 StringToNumber (scr_string.c):
   * trim the JS StrWhiteSpace set, empty/whitespace-only → +0, then the
   * whole span must be one StrNumericLiteral — signed decimal (Infinity
   * included, strtod-over-validated-span correct rounding) or unsigned
   * 0x/0o/0b (exact value, nearest-even; signed forms are NaN) — with
   * any trailing garbage answering NaN. Number(aString), unary + on
   * strings, and util.format %d over strings lower here. Borrows; never
   * throws. */
  "num.fromString": { argTypes: [STRING], result: F64 },
  "num.isNaN": { argTypes: [F64], result: BOOL },
  /** The static URI component codecs (scr_string.c), ECMA-262 Encode/
   * Decode with the component sets over the runtime's UTF-8 strings.
   * str.encodeUriComponent percent-encodes every byte outside the
   * unreserved component set (ALPHA/DIGIT/- _ . ! ~ * ' ( )) as uppercase
   * %XX — the spec's per-code-point UTF-8 encoding IS a byte scan here —
   * and never throws (the spec's URIError case is an unpaired surrogate,
   * which cannot exist in well-formed UTF-8). str.decodeUriComponent
   * decodes %XX escapes bytewise (raw non-escape bytes copy through) and
   * requires the escaped bytes to form strictly valid UTF-8 (overlong
   * forms, surrogate code points, and >U+10FFFF refused, per UTF8-decode
   * without replacement); bad hex or an invalid sequence THROWS the
   * spec's URIError ("URI malformed"), catchable. Borrow; results +1. */
  "str.encodeUriComponent": { argTypes: [STRING], result: STRING },
  // The base64 globals: the argument is a dyn value (WebIDL ToString
  // runs in the runtime); the zero-argument form always throws.
  /** The WHATWG base64 globals (scr_string.c), Node-global since v16.
   * Arguments are borrowed dyn values — WebIDL ToString runs in the
   * runtime over the dyn kind (String(null) is "null": the html spec's
   * coercion, which Node's atob(null) exercises). str.atob decodes
   * forgiving-base64 (ASCII whitespace stripped, %4==0 strips up to two
   * '=', %4==1 refuses, leftover bits discarded) into the latin1 code
   * points as a string; a malformed input THROWS the catchable
   * DOMException InvalidCharacterError ("The string to be decoded is not
   * correctly encoded."). str.btoa encodes the string's code points as
   * base64; any code point over U+00FF THROWS InvalidCharacterError
   * ("Invalid character"). str.b64Missing is the zero-argument call of
   * either: always throws Node's TypeError [ERR_MISSING_ARGS] "The
   * \"input\" argument must be specified". Results +1. */
  "str.atob": { argTypes: [DYN], result: STRING },
  "str.btoa": { argTypes: [DYN], result: STRING },
  "str.b64Missing": { argTypes: [], result: STRING },
  "str.decodeUriComponent": { argTypes: [STRING], result: STRING },
  "str.decodeUri": { argTypes: [STRING], result: STRING },
  /** encodeURI: the same Encode() keeping the reserved set and '#'
   * unescaped — total like the component encoder. Borrow; result +1. */
  "str.encodeUri": { argTypes: [STRING], result: STRING },
  /** RegExp.escape (ES2025): per-code-point EncodeForRegExpEscape —
   * leading ASCII alphanumeric hex-escapes, syntax characters and '/'
   * take a backslash, other punctuators/whitespace/line terminators
   * hex-escape, the rest passes through. Total; borrows; result +1. */
  "regexp.escape": { argTypes: [STRING], result: STRING },
  /** Number.prototype formatters (scr_lib.c), JS-exact:
   * num.toExponential is toExponential() with the spec's "as many digits
   * as necessary"; num.toFixed0 is the non-throwing omitted-argument
   * toFixed() fast path; num.toFixed implements an explicit fractionDigits
   * with exact binary-value rounding and THROWS RangeError outside 0..100.
   * Successful results +1. */
  "num.toExponential": { argTypes: [F64], result: STRING },
  "num.toFixed0": { argTypes: [F64], result: STRING },
  "num.toFixed": { argTypes: [F64, F64], result: STRING },
  "num.toStringRadix": { argTypes: [F64, DYN], result: STRING },
  /** Object.is over two numbers — the spec's SameValue on doubles: NaN
   * equals NaN, +0 differs from -0, everything else is `===`. Plain bool
   * result; never throws. (Union-armed operands take unionEq's sameValue
   * flag instead — this is the both-f64 fast path.) */
  "num.sameValue": { argTypes: [F64, F64], result: BOOL },
  /** `new Intl.NumberFormat("en-US").format(x)` and
   * `x.toLocaleString("en-US")` with DEFAULT options — the one locale
   * whose data the runtime embeds (Node's default-build locale): decimal
   * notation, 0–3 fraction digits rounded half-up on the SHORTEST
   * round-tripping decimal (ICU's rounding input, probed vs Node —
   * format(1.0005) is "1.001" though toFixed(3) answers "1.000"), ","
   * grouping every three integer digits, "∞"/"NaN" texts, and "-0" for
   * negative inputs rounding to zero. Result +1; never throws. */
  "intl.numFormatEnUs": { argTypes: [F64], result: STRING },
  /** ES Symbol values (scr_symbol.c — link-gated by moduleUsesSymbol).
   * sym.new: `Symbol(desc)` — a fresh runtime-unique identity (+1) whose
   * one arg is the description string (borrowed); sym.newAnon is the
   * description-less `Symbol()` form. sym.for: the Symbol.for global
   * registry — one interned symbol per key (borrowed), +1 on every call.
   * sym.toString: "Symbol(desc)" (+1 string; "Symbol()" when absent).
   * sym.desc / sym.keyFor answer the interned `string | undefined` union
   * (the runtime returns +1-or-NULL; the backend builds the union arms —
   * the child.stdout pattern). None of these throw. */
  "sym.new": { argTypes: [STRING], result: SYMBOL_T },
  "sym.newAnon": { argTypes: [], result: SYMBOL_T },
  "sym.for": { argTypes: [STRING], result: SYMBOL_T },
  "sym.wellKnown": { argTypes: [STRING], result: SYMBOL_T },
  // Result is the interned `string | undefined` union — the libCall case
  // checks the arms (the spawnRes.error pattern).
  "sym.keyFor": { argTypes: [SYMBOL_T], result: VOID },
  "sym.desc": { argTypes: [SYMBOL_T], result: VOID },
  "sym.toString": { argTypes: [SYMBOL_T], result: STRING },
  /** Engine-free arbitrary-precision bigint operations (scr_bigint.c).
   * parse accepts the ECMAScript BigInt string grammar; fromF64 accepts
   * finite integral Numbers. Arithmetic returns fresh immutable values.
   * cmp returns -1/0/1 as f64; toString accepts a numeric radix. */
  "bigint.parse": { argTypes: [STRING], result: BIGINT_T },
  "bigint.fromF64": { argTypes: [F64], result: BIGINT_T },
  "bigint.neg": { argTypes: [BIGINT_T], result: BIGINT_T },
  "bigint.not": { argTypes: [BIGINT_T], result: BIGINT_T },
  "bigint.add": { argTypes: [BIGINT_T, BIGINT_T], result: BIGINT_T },
  "bigint.sub": { argTypes: [BIGINT_T, BIGINT_T], result: BIGINT_T },
  "bigint.mul": { argTypes: [BIGINT_T, BIGINT_T], result: BIGINT_T },
  "bigint.div": { argTypes: [BIGINT_T, BIGINT_T], result: BIGINT_T },
  "bigint.mod": { argTypes: [BIGINT_T, BIGINT_T], result: BIGINT_T },
  "bigint.pow": { argTypes: [BIGINT_T, BIGINT_T], result: BIGINT_T },
  "bigint.and": { argTypes: [BIGINT_T, BIGINT_T], result: BIGINT_T },
  "bigint.or": { argTypes: [BIGINT_T, BIGINT_T], result: BIGINT_T },
  "bigint.xor": { argTypes: [BIGINT_T, BIGINT_T], result: BIGINT_T },
  "bigint.shl": { argTypes: [BIGINT_T, BIGINT_T], result: BIGINT_T },
  "bigint.shr": { argTypes: [BIGINT_T, BIGINT_T], result: BIGINT_T },
  "bigint.eq": { argTypes: [BIGINT_T, BIGINT_T], result: BOOL },
  "bigint.eqString": { argTypes: [BIGINT_T, STRING], result: BOOL },
  "bigint.cmp": { argTypes: [BIGINT_T, BIGINT_T], result: F64 },
  "bigint.cmpNumber": { argTypes: [BIGINT_T, F64], result: F64 },
  "bigint.truthy": { argTypes: [BIGINT_T], result: BOOL },
  "bigint.toString": { argTypes: [BIGINT_T, F64], result: STRING },
  "bigint.inspect": { argTypes: [BIGINT_T], result: STRING },
  "bigint.toF64": { argTypes: [BIGINT_T], result: F64 },
  "bigint.asUintN": { argTypes: [F64, BIGINT_T], result: BIGINT_T },
  "bigint.asIntN": { argTypes: [F64, BIGINT_T], result: BIGINT_T },
  "bigint.bufferRead": { argTypes: [BYTES_U8, F64, BOOL, BOOL], result: BIGINT_T },
  "bigint.bufferWrite": { argTypes: [BYTES_U8, BIGINT_T, F64, BOOL, BOOL], result: F64 },
  "bigint.dataViewGet": { argTypes: [BYTES_U8, F64, BOOL, BOOL], result: BIGINT_T },
  "bigint.dataViewSet": { argTypes: [BYTES_U8, F64, BIGINT_T, BOOL], result: VOID },
  /** node:url + the URL class (scr_url.c). url.new parses one absolute
   * URL string into a mutable URL value (+1) — invalid input THROWS a
   * catchable TypeError ("Invalid URL"), like Node's constructor. The
   * getters (borrowed receiver, +1 string) never throw; url.href doubles
   * as toString(). fileURLToPath has one libFn per receiver form (URL
   * value / string) — both THROW Node's TypeErrors on non-file schemes,
   * encoded slashes, and non-empty hosts. url.pathToFileURL resolves the
   * path (getcwd) and never throws. */
  "url.new": { argTypes: [STRING], result: URL_T },
  "url.newBase": { argTypes: [STRING, STRING], result: URL_T },
  /** Factories consume already-converted input/base strings. canParse
   * answers a boolean; parse returns a checked native URL or null (+1).
   * Parser failures are suppressed; conversion occurs before these calls. */
  "url.canParse": { argTypes: [STRING], result: BOOL },
  "url.canParseBase": { argTypes: [STRING, STRING], result: BOOL },
  "url.parse": { argTypes: [STRING], result: DYN },
  "url.parseBase": { argTypes: [STRING, STRING], result: DYN },
  "url.protocol": { argTypes: [URL_T], result: STRING },
  "url.origin": { argTypes: [URL_T], result: STRING },
  "url.username": { argTypes: [URL_T], result: STRING },
  "url.password": { argTypes: [URL_T], result: STRING },
  "url.host": { argTypes: [URL_T], result: STRING },
  "url.hostname": { argTypes: [URL_T], result: STRING },
  "url.port": { argTypes: [URL_T], result: STRING },
  "url.pathname": { argTypes: [URL_T], result: STRING },
  "url.href": { argTypes: [URL_T], result: STRING },
  /** Selected component writes borrow the receiver and converted string.
   * href replaces its parsed fields while retaining cached params identity. */
  "url.set": { argTypes: [URL_T, STRING, STRING], result: VOID },
  "url.setChecked": { argTypes: [URL_T, STRING, DYN], result: VOID },
  "url.fileURLToPathUrl": { argTypes: [URL_T], result: STRING },
  "url.fileURLToPathChecked": { argTypes: [DYN], result: STRING },
  "url.fileURLToPathOptions": { argTypes: [DYN, DYN], result: STRING },
  "url.fileURLToPathBuffer": { argTypes: [DYN, DYN], result: BYTES_U8 },
  "url.pathToFileURLChecked": { argTypes: [DYN, DYN], result: URL_T },
  "url.fileURLToPathStr": { argTypes: [STRING], result: STRING },
  "url.pathToFileURL": { argTypes: [STRING], result: URL_T },
  /** Explicit path syntax from the options.windows argument, independent
   * of the executable's host platform. Windows UNC input can throw. */
  "url.pathToFileURLPlatform": { argTypes: [STRING, BOOL], result: URL_T },
  /** pathToFileURL under a win32 TARGET: the same scr_url_from_path call
   * (the runtime selects the win32 arm by _WIN32), but a distinct IR name
   * because that arm THROWS for malformed UNC inputs — may-throw seeds on
   * it while posix pathToFileURL emission stays byte-identical. */
  "url.pathToFileURLWin32": { argTypes: [STRING], result: URL_T },
  /** URLSearchParams (scr_url.c — always linked with the url unit).
   * Construction: sp.new (empty), sp.parse (one borrowed init string —
   * a single leading '?' strips, Node's constructor), sp.copy (snapshot
   * of another list), sp.fromPairs (a string[][] value — THROWS Node's
   * ERR_INVALID_TUPLE TypeError on a non-[name, value] row; the one
   * throwing entry in the family), sp.with (the record-literal init
   * desugar: append one pair, answer the same list +1 — chains fold
   * `new URLSearchParams({...})` into nested calls). url.searchParams
   * answers the URL's LIVE cached view (+1, one identity per URL);
   * url.search is the WHATWG search getter ("" for no/empty query).
   * Methods mirror the WHATWG surface: sp.get answers +1-or-NULL (the
   * sym.desc union pattern, null arm), sp.getAll a fresh string[];
   * sp.append/sp.set/sp.delete/sp.deleteValue/sp.sort mutate and
   * re-serialize a live view's URL query; sp.has/sp.hasValue answer
   * bools; sp.size/sp.toString are pure reads. sp.keyAt/sp.valAt are
   * the for-of/forEach desugar's index reads (live — the loop re-reads
   * sp.size each pass). */
  "sp.new": { argTypes: [], result: SEARCH_PARAMS_T },
  "sp.newChecked": { argTypes: [DYN], result: SEARCH_PARAMS_T },
  "sp.parse": { argTypes: [STRING], result: SEARCH_PARAMS_T },
  "sp.copy": { argTypes: [SEARCH_PARAMS_T], result: SEARCH_PARAMS_T },
  // The pairs argument is string[][] — checked structurally in validate.ts (the
  // generic array-of slot has no named constant here).
  "sp.fromPairs": { argTypes: [null], result: SEARCH_PARAMS_T },
  "sp.with": { argTypes: [SEARCH_PARAMS_T, STRING, STRING], result: SEARCH_PARAMS_T },
  "url.searchParams": { argTypes: [URL_T], result: SEARCH_PARAMS_T },
  "url.search": { argTypes: [URL_T], result: STRING },
  "url.hash": { argTypes: [URL_T], result: STRING },
  // Result is the interned `string | null` union — the libCall case
  // checks the arms (the spawnRes.signal pattern).
  "sp.get": { argTypes: [SEARCH_PARAMS_T, STRING], result: VOID },
  "sp.getAll": { argTypes: [SEARCH_PARAMS_T, STRING], result: arrayOf(STRING) },
  "sp.append": { argTypes: [SEARCH_PARAMS_T, STRING, STRING], result: VOID },
  "sp.set": { argTypes: [SEARCH_PARAMS_T, STRING, STRING], result: VOID },
  "sp.delete": { argTypes: [SEARCH_PARAMS_T, STRING], result: VOID },
  "sp.deleteValue": { argTypes: [SEARCH_PARAMS_T, STRING, STRING], result: VOID },
  "sp.has": { argTypes: [SEARCH_PARAMS_T, STRING], result: BOOL },
  "sp.hasValue": { argTypes: [SEARCH_PARAMS_T, STRING, STRING], result: BOOL },
  "sp.sort": { argTypes: [SEARCH_PARAMS_T], result: VOID },
  "sp.size": { argTypes: [SEARCH_PARAMS_T], result: F64 },
  "sp.toString": { argTypes: [SEARCH_PARAMS_T], result: STRING },
  "sp.keyAt": { argTypes: [SEARCH_PARAMS_T, F64], result: STRING },
  "sp.valAt": { argTypes: [SEARCH_PARAMS_T, F64], result: STRING },
  // node:querystring. qs.parse's result is the call site's ParsedUrlQuery
  // dictionary record (VOID is the networkInterfaces sentinel — the
  // libCall case checks the structure); qs.stringify's object argument
  // is a dyn value (the frontend dynFroms typed records).
  /** node:querystring (scr_qs.c — link-gated by moduleUsesQs; NOT
   * URLSearchParams: the legacy codec's escaping and '+' rules differ).
   * qs.escape is Node's qsEscape, which encodes exactly the component
   * unreserved set — it emits the always-linked
   * scr_str_encode_uri_component, so escape-only programs never pull the
   * unit. qs.unescape is Node's qsUnescape: strict decodeURIComponent
   * first, the lenient legacy unescapeBuffer fallback on failure (never
   * throws). qs.parse takes (str, sep, eq, maxKeys) — the frontend
   * completes omitted/null sep/eq to "&"/"=" and the omitted maxKeys
   * option to Node's 1000 (0 and negatives mean unlimited, Node's rule) —
   * and its result type is the CALL SITE's mapped ParsedUrlQuery shape (a
   * pure index-signature record over `string | string[]`, an undefined
   * arm tolerated — @types/node's Dict), verified structurally by the
   * frontend (lowerQuerystringParseCall); the emitters construct the
   * record and hand its overflow map to scr_qs_parse_into with the two
   * union tags. qs.stringify takes (obj, sep, eq) with obj a dyn value
   * (the frontend dynFroms the typed record; JS-world dyn values pass
   * through) — Node's encodeStringified rules run in the runtime, so
   * arrays expand to repeated keys and null/undefined/nested objects are
   * empty values. Custom encoder/decoder options fence at compile time.
   * All borrow; string results +1; none throw. */
  "qs.parse": { argTypes: [STRING, STRING, STRING, F64], result: VOID },
  "qs.stringify": { argTypes: [DYN, STRING, STRING], result: STRING },
  "qs.escape": { argTypes: [STRING], result: STRING },
  "qs.unescape": { argTypes: [STRING], result: STRING },
  /** node:util.parseArgs: one checked-dynamic config object in, one
   * checked-dynamic ParsedResults tree out. Statically typed member reads
   * validate their values when leaving that tree. The native parser may
   * throw Node's coded validation/grammar TypeErrors. */
  "util.parseArgs": { argTypes: [DYN], result: DYN },
  "util.parseEnv": { argTypes: [DYN], result: DYN },
  "util.getSystemErrorName": { argTypes: [DYN], result: STRING },
  "util.getSystemErrorMessage": { argTypes: [DYN], result: STRING },
  "util.systemErrorEntries": { argTypes: [], result: DYN },
  "util.stripVTControlCharacters": { argTypes: [DYN], result: STRING },
  "util.toUSVString": { argTypes: [DYN], result: STRING },
  "util.isDeepStrictEqual": { argTypes: [DYN, DYN, DYN], result: BOOL },
  "util.styleText": { argTypes: [DYN, DYN, DYN], result: STRING },
  "util.typeIs": { argTypes: [DYN, STRING], result: BOOL },
  "util.typeValue": { argTypes: [DYN, STRING], result: DYN },
  /** fs.statSync → a Stats value (may throw, like the other sync fs
   * calls); the stats.* getters are pure reads on it. */
  "fs.statSync": { argTypes: [STRING], result: STATS_T },
  "fs.lstatSync": { argTypes: [STRING], result: STATS_T },
  "fs.fstatSync": { argTypes: [F64], result: STATS_T },
  "fs.fchmodSync": { argTypes: [F64, F64], result: VOID },
  "fs.fsyncSync": { argTypes: [F64], result: VOID },
  "fs.fdatasyncSync": { argTypes: [F64], result: VOID },
  "fs.ftruncateSync": { argTypes: [F64, F64], result: VOID },
  "fs.utimesSync": { argTypes: [DYN, DYN, DYN], result: VOID },
  "fs.futimesSync": { argTypes: [DYN, DYN, DYN], result: VOID },
  "fs.lutimesSync": { argTypes: [DYN, DYN, DYN], result: VOID },
  "fs.readvSync": { argTypes: [F64, arrayOf(BYTES_U8), F64], result: F64 },
  "fs.writevSync": { argTypes: [F64, arrayOf(BYTES_U8), F64], result: F64 },
  "fs.linkSync": { argTypes: [DYN, DYN], result: VOID },
  "fs.symlinkSync": { argTypes: [DYN, DYN, DYN], result: VOID },
  "fs.readlinkSync": { argTypes: [DYN, DYN], result: DYN },
  "fs.statfsSync": { argTypes: [DYN, DYN], result: DYN },
  "fs.readlinkSyncStr": { argTypes: [DYN, DYN], result: STRING },
  "fs.readlinkSyncBuffer": { argTypes: [DYN, DYN], result: BYTES_U8 },
  /** fs.openSync(path, flags) → the raw fd as f64; fs.readSync/fs.writeSync
   * over Buffer windows perform sequential I/O when position is -1 and
   * offset-preserving positioned I/O otherwise; fs.writeStrSync is the
   * utf8 string twin; and fs.closeSync(fd) closes the descriptor. This is
   * the fd slice behind spawn/log-processing forms.
   * flags is Node's string
   * grammar ("r", "w", "a" and the +/x variants; unknown flags throw
   * Node's ERR_INVALID_ARG_VALUE TypeError text). All throw Node-shaped
   * fs errors (openSync ENOENT/EACCES..., readSync EBADF/range errors,
   * closeSync EBADF). */
  "fs.openSync": { argTypes: [STRING, STRING], result: F64 },
  "fs.openNumericSync": { argTypes: [STRING, F64, F64], result: F64 },
  "fs.readSync": { argTypes: [F64, BYTES_U8, F64, F64, F64], result: F64 },
  "fs.writeSync": { argTypes: [F64, BYTES_U8, F64, F64, F64], result: F64 },
  "fs.writeStrSync": { argTypes: [F64, STRING, F64, STRING], result: F64 },
  // fs.watch's callback func type is program-dependent (zero params, or
  // the eventType string) — the slot pins arity and the path/receiver.
  /** fs.watch(path, listener?) → an FSWatcher handle (scr_watch.c —
   * linked, and scr_watch_install() emitted, only when these appear on
   * the IR; moduleUsesFsWatch is the switch). The path opens NOW —
   * failure throws Node's fs error synchronously ("ENOENT: ..., watch
   * 'x'", the polling-fallback catch shape) — and the unit's kqueue
   * (EVFILT_VNODE) delivers "rename"/"change" through the loop's watch
   * hook. The callback (nullable) MOVES in with an adapter per listener
   * shape (zero-param, or the (eventType: string) form — runtime-
   * provided); an open watcher keeps the loop alive until watcher.close()
   * (idempotent, receiver borrowed, statement position only). */
  "fs.watch": { argTypes: [STRING], result: FSWATCHER_T },
  "fs.watchCb": { argTypes: [STRING, null], result: FSWATCHER_T },
  "watcher.close": { argTypes: [FSWATCHER_T], result: VOID },
  /** The composed `new crypto.X509Certificate(data).fingerprint` read
   * (scr_lib.c — no certificate handle exists): the SHA-1 of the DER,
   * uppercase colon-separated, over PEM or raw-DER Buffer input; other
   * inputs throw Node's ERR_OSSL_PEM_NO_START_LINE Error (may-throw). */
  "crypto.x509Fingerprint": { argTypes: [BYTES_U8], result: STRING },
  "crypto.x509FingerprintStr": { argTypes: [STRING], result: STRING },
  /** The certificate's Validity window (validFrom / validTo reads —
   * scr_lib.c's minimal ASN.1 walk to the TBSCertificate validity
   * SEQUENCE): UTCTime and GeneralizedTime render in Node's exact
   * ASN1_TIME_print shape ("Jul  1 00:00:00 2026 GMT" — %2d space-padded
   * day). Same input contract and PEM error as the fingerprint pair
   * (may-throw). */
  "crypto.x509ValidFrom": { argTypes: [BYTES_U8], result: STRING },
  "crypto.x509ValidFromStr": { argTypes: [STRING], result: STRING },
  "crypto.x509ValidTo": { argTypes: [BYTES_U8], result: STRING },
  "crypto.x509ValidToStr": { argTypes: [STRING], result: STRING },
  "fs.closeSync": { argTypes: [F64], result: VOID },
  "stats.isFile": { argTypes: [STATS_T], result: BOOL },
  "stats.isDirectory": { argTypes: [STATS_T], result: BOOL },
  "stats.isSymbolicLink": { argTypes: [STATS_T], result: BOOL },
  "stats.size": { argTypes: [STATS_T], result: F64 },
  "stats.dev": { argTypes: [STATS_T], result: F64 },
  "stats.ino": { argTypes: [STATS_T], result: F64 },
  "stats.blocks": { argTypes: [STATS_T], result: F64 },
  "stats.nlink": { argTypes: [STATS_T], result: F64 },
  "stats.atimeMs": { argTypes: [STATS_T], result: F64 },
  "stats.mtimeMs": { argTypes: [STATS_T], result: F64 },
  "stats.ctimeMs": { argTypes: [STATS_T], result: F64 },
  // The wider sync fs slice (unlink/chmod/chown/copyfile and the
  // mode-carrying write/mkdir forms).
  /** The wider sync fs slice (scr_lib.c), all throwing catchably with
   * Node's errno message shapes and `.code` stamped like the rest of
   * sync fs. unlink/chmod/chown wrap the syscalls 1:1 (Node reports the
   * syscall's own name). copyFileSync copies contents into a fresh (or
   * truncated) destination carrying the SOURCE's mode (libuv's
   * uv_fs_copyfile behavior); its errors carry BOTH paths — Node's
   * "copyfile 'src' -> 'dest'". lstatSync is statSync without following
   * a trailing symlink (Node reports lstat); stats.isSymbolicLink /
   * stats.dev / ino / blocks / nlink / atimeMs / mtimeMs / ctimeMs are pure reads on the widened
   * snapshot (blocks is allocated 512-byte units; the times are milliseconds
   * with their sub-second fractions, Node's arithmetic).
   * writeFileModeSync is writeFileSync(path, data, { mode }): the mode
   * applies at CREATION only (open(2) with O_CREAT, umask applying),
   * exactly Node — an existing file keeps its permissions. mkdirModeSync
   * / mkdirRecursiveModeSync are the mkdirSync option forms with an
   * explicit mode (the recursive walk passes it to every directory it
   * creates, like Node's). */
  "fs.unlinkSync": { argTypes: [STRING], result: VOID },
  "fs.chmodSync": { argTypes: [STRING, F64], result: VOID },
  "fs.chownSync": { argTypes: [STRING, F64, F64], result: VOID },
  "fs.copyFileSync": { argTypes: [STRING, STRING], result: VOID },
  /** renameSync is the direct two-path syscall wrapper. renameCb defers
   * the operation to the loop and fires a program-shaped Error | null
   * callback through a backend-emitted adapter. */
  "fs.renameSync": { argTypes: [STRING, STRING], result: VOID },
  // Callback type is program-dependent (zero params or Error | null).
  "fs.renameCb": { argTypes: [STRING, STRING, null], result: VOID },
  "fs.writeFileModeSync": { argTypes: [STRING, STRING, F64], result: VOID },
  "fs.mkdirModeSync": { argTypes: [STRING, F64], result: VOID },
  "fs.mkdirRecursiveModeSync": { argTypes: [STRING, F64], result: VOID },
  "atomics.wait": { argTypes: [bytesOf("i32"), F64, F64, F64], result: STRING },
  "atomics.notify": { argTypes: [bytesOf("i32"), F64, F64], result: F64 },
  "atomics.op": { argTypes: [null, F64, F64, F64, F64], result: F64 },
  "worker.new": { argTypes: [F64, STRING, DYN], result: DYN },
  "worker.isMainThread": { argTypes: [], result: BOOL },
  "worker.threadId": { argTypes: [], result: F64 },
  "worker.root": { argTypes: [], result: F64 },
  "worker.data": { argTypes: [], result: DYN },
  "worker.parentPort": { argTypes: [], result: DYN },
  /** child_process.spawnSync (scr_child.c): posix_spawn + waitpid + piped
   * utf8 capture — cmd borrowed, args one borrowed string[] (the frontend
   * completes an omitted list to an empty literal), result an owned (+1)
   * spawnRes. NEVER throws: spawn failure (nonexistent binary, EACCES) is
   * data, like Node's error property — status null and empty outputs
   * (SEMANTICS.md documents the divergence from Node's null stdout).
   * The getters are pure reads: status is the interned `number | null`
   * union (null = spawn failure or signal death, type-directed
   * construction in the backend like process.envGet); stdout/stderr are
   * +1 strings. */
  "cp.spawnSync": { argTypes: [STRING, arrayOf(STRING)], result: SPAWNRES_T },
  // spawnSync's options form: timeout, killSignal name ("" = SIGTERM),
  // and the three stdio modes.
  /** spawnSync with options (scr_child.c): the cp.spawnSync core plus the
   * option slice portless-class CLIs pass — timeout (killSignal fires at
   * the deadline and the result carries error: ETIMEDOUT + the signal,
   * Node's shape), killSignal (a signal NAME; "" = the SIGTERM default),
   * and per-fd stdio modes (in: 0 /dev/null, 1 ignore, 2 inherit; out/
   * err: 0 capture, 1 ignore → "", 2 inherit → ""). NEVER throws — spawn
   * failure and timeout are data on the result, like Node's error
   * property. spawnRes.signal is the result's termination signal as the
   * call site's `Signals | null` union (null = exited normally or spawn
   * failure), constructed type-directedly like spawnRes.status. */
  "cp.spawnSyncOpts": {
    argTypes: [STRING, arrayOf(STRING), F64, STRING, F64, F64, F64],
    result: SPAWNRES_T,
  },
  /** cp.spawnSyncOpts with the stdio carried as a RUNTIME string —
   * "pipe" | "ignore" | "inherit", proven by the call site's TYPE (the
   * defaultRunner idiom `stdio: options?.stdio ?? "pipe"`); the runtime
   * maps the value to the three modes. Args (cmd, argv, timeout,
   * killSignal, stdio). Never throws, like the other spawnSync forms. */
  "cp.spawnSyncStdioStr": {
    argTypes: [STRING, arrayOf(STRING), F64, STRING, STRING],
    result: SPAWNRES_T,
  },
  // node:net (scr_net.c). Listener slots are program-dependent closures —
  // null slots, checked in the libCall case (the child.onExit precedent);
  // the zero-param callbacks pin the exact func type here. The trailing
  // BOOL on registrations is the once flag.
  /** node:net (scr_net.c — linked, and scr_net_install() emitted, only
   * when one of these appears on the IR; moduleUsesNet is the switch).
   * Receivers are borrowed; CALLBACKS MOVE into the handle's listener
   * registry and are released at settlement (the child.onExit story).
   * All listener registrations carry a trailing BOOL once-flag (`on` vs
   * `once`) and are void — chaining is fenced. None of these throw:
   * listen/connect failures are the async 'error' event, like Node.
   *
   * net.createServer's optional connection handler and the
   * serverOnConnection listeners take the runtime-provided adapters
   * (zero-param, or the one-param socket shape); sockOnData's adapters
   * are the stdin pair's shapes (zero-param / bytes chunk); the error
   * events reuse the child %Error adapters. net.listen/net.listenCb bind
   * NOW and defer 'listening' to the next loop turn (Node's next-tick
   * emit); net.serverPort is the composed `server.address().port` read.
   * net.connect's host argument is a string ("localhost" pins to
   * 127.0.0.1 — SEMANTICS.md); the connect callback is once('connect'). */
  "net.createServer": { argTypes: [], result: NETSERVER_T },
  "net.createServerCb": { argTypes: [null], result: NETSERVER_T },
  "net.listen": { argTypes: [NETSERVER_T, F64], result: VOID },
  "net.listenCb": {
    argTypes: [NETSERVER_T, F64, { kind: "func", params: [], ret: VOID }],
    result: VOID,
  },
  /** listen({ port, host, ipv6Only }[, cb]) — the explicit-interface bind
   * (portless's listenOnProxyInterface): args [server, port, host,
   * ipv6Only]. host is an IP literal string ("" = the host-less
   * dual-stack any default); ipv6Only sets IPV6_V6ONLY before the bind.
   * These are the old-shaped calls, retained for omitted reusePort so
   * serialized IR remains compatible. Failures are the async 'error',
   * message in Node's listen shape with the requested host. Never throws. */
  "net.listenOpts": { argTypes: [NETSERVER_T, F64, STRING, BOOL], result: VOID },
  // The callback slot is a zero-param void closure OR its
  // `(() => void) | undefined` optional-binding union (checked specially).
  "net.listenOptsCb": { argTypes: [NETSERVER_T, F64, STRING, BOOL, null], result: VOID },
  /** Additive ABI for listen({ ..., reusePort }) — args
   * [server, port, host, ipv6Only, reusePort], with the callback following
   * those values in the callback form. The final BOOL is the requested
   * kernel connection-distribution option; old spellings remain
   * four/five-argument calls so serialized IR stays compatible. */
  "net.listenOptsReusePort": { argTypes: [NETSERVER_T, F64, STRING, BOOL, BOOL], result: VOID },
  // The callback is a zero-param void closure OR its optional-binding union;
  // the callback follows the reusePort BOOL in this additive ABI.
  "net.listenOptsReusePortCb": {
    argTypes: [NETSERVER_T, F64, STRING, BOOL, BOOL, null],
    result: VOID,
  },
  "net.serverPort": { argTypes: [NETSERVER_T], result: F64 },
  "net.serverListening": { argTypes: [NETSERVER_T], result: BOOL },
  // net.serverAddress's record result is shape-checked in the libCall case
  // (the dgram.address sentinel pattern).
  /** server.address() as the full AddressInfo record (the dgram.address
   * materialization pattern: the emitter builds the record from the three
   * runtime reads; the frontend pinned the shape). Never throws — before
   * listen it answers the any-form defaults with port 0 where Node
   * answers null (the serverPort stance). */
  "net.serverAddress": { argTypes: [NETSERVER_T], result: VOID },
  "net.serverClose": { argTypes: [NETSERVER_T], result: VOID },
  "net.serverCloseCb": {
    argTypes: [NETSERVER_T, { kind: "func", params: [], ret: VOID }],
    result: VOID,
  },
  "net.serverOnError": { argTypes: [NETSERVER_T, null, BOOL], result: VOID },
  "net.serverOnClose": {
    argTypes: [NETSERVER_T, { kind: "func", params: [], ret: VOID }, BOOL],
    result: VOID,
  },
  "net.serverOnConnection": { argTypes: [NETSERVER_T, null, BOOL], result: VOID },
  /** 'secureConnection' — the TLS server's deferred 'connection' list
   * (handshake-completion timing); on a server without deferred
   * connections (a plain net server) the registration never fires,
   * exactly Node's split. */
  "net.serverOnSecureConnection": { argTypes: [NETSERVER_T, null, BOOL], result: VOID },
  "net.connect": { argTypes: [F64, STRING], result: NETSOCKET_T },
  /** connect with a validated autoSelectFamilyAttemptTimeout option (the
   * budget runs Node's validateInt32-from-1 ladder and is then inert —
   * the single dial has nothing to time). May-throw. */
  "net.connectAttempt": { argTypes: [F64, STRING, DYN], result: NETSOCKET_T },
  /** net.connect/createConnection over a RUNTIME option bag (computed
   * keys — the invalid-input probes): Node-order validation (the
   * objectMode trio's ERR_INVALID_ARG_VALUE, validatePort, host string,
   * autoSelectFamily boolean, the attempt budget), then the trailing
   * compiler-rendered fence — ALWAYS THROWS (the error.nodeThrow
   * polymorphic-result carve-out). May-throw seed. */
  "net.connectOptsChk": { argTypes: [DYN, STRING], result: VOID },
  "net.connectCb": {
    argTypes: [F64, STRING, { kind: "func", params: [], ret: VOID }],
    result: NETSOCKET_T,
  },
  // The lookup's exact func shape is program data (its answer callback's
  // union/record types) — checked specially in the libCall case.
  /** connect({ port, host, autoSelectFamily: true, lookup }) — the
   * caller-resolver dial (portless's createLoopbackConnection): args
   * [port, host, lookup]. The runtime creates the (connecting) socket
   * handle, invokes the lookup as Node does — lookup(hostname, options,
   * callback), options crossing as the dyn undefined — and the answer
   * closure (an emitter-synthesized per-shape thunk over a boxed socket,
   * the SNI-answer pattern) dials the answered addresses IN ORDER: each
   * connect failure tries the next, the LAST failure's message is the
   * socket's 'error' (Node's autoSelectFamily aggregate is a documented
   * divergence), and a lookup error surfaces as the deferred socket
   * 'error'. A synchronous throw INSIDE the lookup propagates out of the
   * connect call (may-throw seed). */
  "net.connectLookup": { argTypes: [F64, STRING, null], result: NETSOCKET_T },
  "net.sockWrite": { argTypes: [NETSOCKET_T, STRING], result: VOID },
  "net.sockWriteBytes": { argTypes: [NETSOCKET_T, BYTES_U8], result: VOID },
  "net.sockEnd": { argTypes: [NETSOCKET_T], result: VOID },
  "net.sockEndStr": { argTypes: [NETSOCKET_T, STRING], result: VOID },
  "net.sockEndBytes": { argTypes: [NETSOCKET_T, BYTES_U8], result: VOID },
  /** write/end with a CHECKED-DYNAMIC chunk (an untyped JS payload into a
   * typed socket): the runtime dispatches STR/BYTES and throws Node's
   * ERR_INVALID_ARG_TYPE chunk TypeError on any other kind. */
  "net.sockWriteDyn": { argTypes: [NETSOCKET_T, DYN], result: VOID },
  "net.sockEndDyn": { argTypes: [NETSOCKET_T, DYN], result: VOID },
  "net.sockDestroy": { argTypes: [NETSOCKET_T], result: VOID },
  "net.sockPipe": { argTypes: [NETSOCKET_T, NETSOCKET_T], result: VOID },
  /** socket.pipe(res) — raw socket chunks into a ServerResponse body
   * (the extended-CONNECT bridge leg): each chunk is a body write (the
   * response's own framing applies); source EOF end()s the response,
   * pipe's default. Borrows both. Never throws. */
  "net.sockPipeRes": { argTypes: [NETSOCKET_T, HTTPRES_T], result: VOID },
  "net.sockOnData": { argTypes: [NETSOCKET_T, null, BOOL], result: VOID },
  "net.sockOnEnd": {
    argTypes: [NETSOCKET_T, { kind: "func", params: [], ret: VOID }, BOOL],
    result: VOID,
  },
  "net.sockOnClose": {
    argTypes: [NETSOCKET_T, { kind: "func", params: [], ret: VOID }, BOOL],
    result: VOID,
  },
  "net.sockOnError": { argTypes: [NETSOCKET_T, null, BOOL], result: VOID },
  "net.sockOnConnect": {
    argTypes: [NETSOCKET_T, { kind: "func", params: [], ret: VOID }, BOOL],
    result: VOID,
  },
  // node:dgram + node:dns (scr_dgram.c). The message/error listeners and
  // dns.lookup's callback are program-dependent closures (null slots,
  // checked in the libCall case); dgram.address's record result is
  // program-dependent too (VOID here is the envGet sentinel — the libCall
  // case checks the {address, family, port} shape).
  /** node:dgram + node:dns (scr_dgram.c — linked, and
   * scr_dgram_install() emitted, only when one of these appears on the
   * IR; moduleUsesDgram is the switch — dns.lookup rides the same unit).
   * The net listener discipline verbatim: receivers borrowed, CALLBACKS
   * MOVE into the handle's registry and release at settlement, `on` vs
   * `once` is the trailing bool, registrations are void. bind/connect
   * bind NOW and defer 'listening'/'connect' to the next loop turn (the
   * net.listen story); their optional-host completions are ""
   * (bind → 0.0.0.0) and "127.0.0.1" (connect — udp4's Node default).
   * bind/connect/send/close/address THROW Node's state errors ("Socket
   * is already bound", "Already connected", "Not running") — may-throw
   * seeded. dgram.address returns the AddressInfo RECORD (the frontend
   * pins the {address, family, port} shape; the emitter builds it from
   * runtime parts). onMessage adapters are emitted per rinfo record
   * shape (the child.onExit precedent); onError reuses the child %Error
   * adapters. dns.lookup resolves via getaddrinfo AT CALL TIME and
   * defers the callback to the next turn (SEMANTICS.md documents the
   * blocking divergence); its per-union adapter builds the
   * `Error | null` first argument. */
  "dgram.createSocket": { argTypes: [BOOL], result: DGRAMSOCK_T },
  "dgram.bind": { argTypes: [DGRAMSOCK_T, F64, STRING], result: VOID },
  "dgram.bindCb": {
    argTypes: [DGRAMSOCK_T, F64, STRING, { kind: "func", params: [], ret: VOID }],
    result: VOID,
  },
  "dgram.connect": { argTypes: [DGRAMSOCK_T, F64, STRING], result: VOID },
  "dgram.connectCb": {
    argTypes: [DGRAMSOCK_T, F64, STRING, { kind: "func", params: [], ret: VOID }],
    result: VOID,
  },
  "dgram.sendStr": { argTypes: [DGRAMSOCK_T, STRING, F64, STRING], result: VOID },
  "dgram.sendBytes": { argTypes: [DGRAMSOCK_T, BYTES_U8, F64, STRING], result: VOID },
  /** The send argument-validation ladder over dyn arguments (Node's
   * signature shuffle: slice bounds, list/type contracts, port/address
   * validation, connected-state errors) — a fully-validated unconnected
   * single-payload send RUNS; callback/list/connected forms meet the
   * trailing fence. May-throw. */
  "dgram.sendChk": { argTypes: [DGRAMSOCK_T, DYN, DYN, DYN, DYN, DYN, STRING], result: VOID },
  "dgram.address": { argTypes: [DGRAMSOCK_T], result: VOID },
  "dgram.close": { argTypes: [DGRAMSOCK_T], result: VOID },
  "dgram.closeCb": {
    argTypes: [DGRAMSOCK_T, { kind: "func", params: [], ret: VOID }],
    result: VOID,
  },
  "dgram.unref": { argTypes: [DGRAMSOCK_T], result: VOID },
  "dgram.ref": { argTypes: [DGRAMSOCK_T], result: VOID },
  "dgram.onMessage": { argTypes: [DGRAMSOCK_T, null, BOOL], result: VOID },
  "dgram.onError": { argTypes: [DGRAMSOCK_T, null, BOOL], result: VOID },
  "dgram.onListening": {
    argTypes: [DGRAMSOCK_T, { kind: "func", params: [], ret: VOID }, BOOL],
    result: VOID,
  },
  "dgram.onClose": {
    argTypes: [DGRAMSOCK_T, { kind: "func", params: [], ret: VOID }, BOOL],
    result: VOID,
  },
  "dgram.onConnect": {
    argTypes: [DGRAMSOCK_T, { kind: "func", params: [], ret: VOID }, BOOL],
    result: VOID,
  },
  "dns.lookup": { argTypes: [STRING, F64, null], result: VOID },
  // node:test (scr_test.c). Bodies are program-dependent closures (0 or
  // 1 testCtx param, void or Promise<void> result — the spoke pinned the
  // shape): null slots. sub's result is the settled Promise<void> the
  // await consumes.
  /** node:test (scr_test.c — linked only when one of these appears on
   * the IR; moduleUsesNodeTest is the switch, and the main epilogue asks
   * scr_test_exit_code() for the process's exit status). Strings are
   * BORROWED, callbacks MOVE. register/suite/hook attach to the runner
   * tree (register: name, mode 0|1|2 run/skip/todo, directive message ""
   * = none, cb or absent via registerEmpty, flags 1 async | 2 takes-ctx
   * | 4 only, "file:line:col"); suite runs its body AT registration
   * (Node's collection phase). sub is t.test — runs the subtest INLINE
   * on the runner fiber and returns the settled promise the await
   * consumes. ctxSkip/ctxTodo mark the running test; ctxDiagnostic
   * queues an ℹ line; ctxName reads t.name. Every registration keeps
   * the loop-run emitted (usesTimers) so the runner fiber drains. */
  "test.register": { argTypes: [STRING, F64, STRING, null, F64, STRING], result: VOID },
  "test.registerEmpty": { argTypes: [STRING, F64, STRING, F64, STRING], result: VOID },
  "test.suite": {
    argTypes: [STRING, F64, STRING, { kind: "func", params: [], ret: VOID }, STRING],
    result: VOID,
  },
  "test.hook": { argTypes: [F64, null, F64], result: VOID },
  "test.sub": {
    argTypes: [TESTCTX_T, STRING, F64, STRING, null, F64, STRING],
    result: { kind: "promise", inner: VOID },
  },
  "test.subEmpty": { argTypes: [TESTCTX_T, STRING, F64, STRING, STRING], result: VOID },
  "test.ctxSkip": { argTypes: [TESTCTX_T, STRING], result: VOID },
  "test.ctxTodo": { argTypes: [TESTCTX_T, STRING], result: VOID },
  "test.ctxDiagnostic": { argTypes: [TESTCTX_T, STRING], result: VOID },
  "test.ctxName": { argTypes: [TESTCTX_T], result: STRING },
  // node:http (scr_http.c over scr_net.c). The handler and the data
  // listeners are program-dependent closures (null slots, checked in the
  // libCall case); reqHeader's result is the interned string|undefined
  // union, checked like process.envGet.
  /** node:http, the server slice (scr_http.c over scr_net.c — linked
   * only when these appear on the IR; moduleUsesHttpServer is the
   * switch, and any http.* libCall also counts as net use so scr_net.c
   * links and installs). http.createServer's handler MOVES in and takes
   * the runtime adapters for its (req, res) / (req) / () shapes; req
   * body listeners follow the net.sockOnData story (bytes chunks, once
   * flags); reqHeader answers the interned `string | undefined` union
   * exactly like process.envGet; the res writers are borrowed-argument
   * voids with Node's framing decided in the runtime (Content-Length
   * for end-before-head, chunked after an explicit writeHead/write). */
  "http.createServer": { argTypes: [null], result: NETSERVER_T },
  /** http.createServer() / http.Server() with no handler — the
   * on("request") route; option helpers set parser behavior on a fresh
   * server before the constructor/factory result is returned. */
  "http.createServerEmpty": { argTypes: [], result: NETSERVER_T },
  "http.validateHeaderName": { argTypes: [STRING, STRING], result: VOID },
  "http.validateHeaderValue": { argTypes: [STRING, DYN], result: VOID },
  "http.serverJoinDupHeaders": { argTypes: [NETSERVER_T], result: VOID },
  "http.serverAllowMissingHostHeader": { argTypes: [NETSERVER_T], result: VOID },
  /** The five writable numeric http.Server timeout fields use one
   * selector ABI: 0 timeout, 1 keepAliveTimeout, 2 headersTimeout,
   * 3 requestTimeout, 4 keepAliveTimeoutBuffer. These calls store/read
   * the property values; timer enforcement remains outside this surface.
   * The constructor-option setter takes dyn so explicit undefined remains
   * distinguishable from a numeric value until its Node validation ladder. */
  "http.serverTimeoutGet": { argTypes: [NETSERVER_T, F64], result: F64 },
  "http.serverSetTimeout": { argTypes: [NETSERVER_T, F64], result: VOID },
  "http.serverSetTimeoutCb": { argTypes: [NETSERVER_T, F64, null], result: VOID },
  "http.serverOnTimeout": { argTypes: [NETSERVER_T, null, BOOL], result: VOID },
  "http.serverCloseAllConnections": { argTypes: [NETSERVER_T], result: VOID },
  "http.serverCloseIdleConnections": { argTypes: [NETSERVER_T], result: VOID },
  "http.serverTimeoutSet": { argTypes: [NETSERVER_T, F64, F64], result: VOID },
  "http.serverTimeoutOptionSet": { argTypes: [NETSERVER_T, F64, DYN], result: VOID },
  /** server.on("listening", cb) — the deferred listen-callback list. */
  "net.serverOnListening": {
    argTypes: [NETSERVER_T, { kind: "func", params: [], ret: VOID }, BOOL],
    result: VOID,
  },
  /** The ServerResponse member surface: statusCode/statusMessage reads
   * and assignments (Node's writable properties), the header CRUD trio
   * (getHeader answers `string | undefined` like reqHeader), and
   * end(cb)'s finish slot (resOnFinish registers, the end call follows —
   * the callback fires deferred, Node's 'finish' emit). writeHead's
   * statusMessage forms compose in interned helpers: resStatusMsgSet
   * then the ordinary writeHead entry. */
  "http.resStatusGet": { argTypes: [HTTPRES_T], result: F64 },
  "http.resStatusSet": { argTypes: [HTTPRES_T, F64], result: VOID },
  "http.resStatusMsgGet": { argTypes: [HTTPRES_T], result: VOID },
  "http.resStatusMsgSet": { argTypes: [HTTPRES_T, STRING], result: VOID },
  "http.resRequest": { argTypes: [HTTPRES_T], result: HTTPREQ_T },
  "http.resSocket": { argTypes: [HTTPRES_T], result: VOID },
  "http.resWritableFinished": { argTypes: [HTTPRES_T], result: BOOL },
  "http.resSendDateGet": { argTypes: [HTTPRES_T], result: BOOL },
  "http.resSendDateSet": { argTypes: [HTTPRES_T, BOOL], result: VOID },
  "http.resStrictContentLengthGet": { argTypes: [HTTPRES_T], result: BOOL },
  "http.resStrictContentLengthSet": { argTypes: [HTTPRES_T, BOOL], result: VOID },
  "http.resSetTimeout": { argTypes: [HTTPRES_T, F64], result: VOID },
  "http.resSetTimeoutCb": {
    argTypes: [HTTPRES_T, F64, { kind: "func", params: [], ret: VOID }],
    result: VOID,
  },
  // resGetHeader answers the interned `string | undefined` union — the
  // reqHeader/envGet sentinel pattern (VOID here, checked specially).
  "http.resGetHeader": { argTypes: [HTTPRES_T, STRING], result: VOID },
  "http.resGetHeaderNames": { argTypes: [HTTPRES_T], result: arrayOf(STRING) },
  "http.resGetRawHeaderNames": { argTypes: [HTTPRES_T], result: arrayOf(STRING) },
  "http.resGetHeaders": { argTypes: [HTTPRES_T], result: DYN },
  "http.resHasHeader": { argTypes: [HTTPRES_T, STRING], result: BOOL },
  "http.resRemoveHeader": { argTypes: [HTTPRES_T, STRING], result: VOID },
  "http.resOnFinish": {
    argTypes: [HTTPRES_T, { kind: "func", params: [], ret: VOID }],
    result: VOID,
  },
  "http.reqUrl": { argTypes: [HTTPREQ_T], result: STRING },
  "http.reqMethod": { argTypes: [HTTPREQ_T], result: STRING },
  "http.reqHeader": { argTypes: [HTTPREQ_T, STRING], result: VOID },
  "http.reqTrailer": { argTypes: [HTTPREQ_T, STRING], result: VOID },
  "http.reqHeaderValues": { argTypes: [HTTPREQ_T, STRING], result: VOID },
  "http.reqTrailerValues": { argTypes: [HTTPREQ_T, STRING], result: VOID },
  "http.reqOnData": { argTypes: [HTTPREQ_T, null, BOOL], result: VOID },
  "http.reqOnEnd": {
    argTypes: [HTTPREQ_T, { kind: "func", params: [], ret: VOID }, BOOL],
    result: VOID,
  },
  "http.resSetHeader": { argTypes: [HTTPRES_T, STRING, STRING], result: VOID },
  "http.resWriteHead": { argTypes: [HTTPRES_T, F64], result: VOID },
  "http.resWriteHeadN": {
    argTypes: [HTTPRES_T, F64, arrayOf(STRING), arrayOf(STRING)],
    result: VOID,
  },
  /** HTTP/1.1 informational heads; early hints takes flat string pairs,
   * with a lowercase `link` key required to send anything. */
  "http.resWriteContinue": { argTypes: [HTTPRES_T], result: VOID },
  "http.resWriteProcessing": { argTypes: [HTTPRES_T], result: VOID },
  "http.resWriteEarlyHints": { argTypes: [HTTPRES_T, arrayOf(STRING)], result: VOID },
  "http.resWrite": { argTypes: [HTTPRES_T, STRING], result: VOID },
  "http.resWriteBytes": { argTypes: [HTTPRES_T, BYTES_U8], result: VOID },
  "http.resEnd": { argTypes: [HTTPRES_T], result: VOID },
  "http.resEndStr": { argTypes: [HTTPRES_T, STRING], result: VOID },
  "http.resEndBytes": { argTypes: [HTTPRES_T, BYTES_U8], result: VOID },
  /** The checked-dynamic chunk twins (the net.sockWriteDyn story). */
  "http.resWriteDyn": { argTypes: [HTTPRES_T, DYN], result: VOID },
  "http.resEndDyn": { argTypes: [HTTPRES_T, DYN], result: VOID },
  "http.resHeadersSent": { argTypes: [HTTPRES_T], result: BOOL },
  "http.resWritableEnded": { argTypes: [HTTPRES_T], result: BOOL },
  "http.resFlushHeaders": { argTypes: [HTTPRES_T], result: VOID },
  "http.resAddTrailers": { argTypes: [HTTPRES_T, arrayOf(STRING)], result: VOID },
  "http.resCork": { argTypes: [HTTPRES_T], result: VOID },
  "http.resUncork": { argTypes: [HTTPRES_T], result: VOID },
  "http.resWritableCorked": { argTypes: [HTTPRES_T], result: F64 },
  // The member follow-ups: reqStatusCode's `number | undefined` and
  // sockRemoteAddress's `string | undefined` results are shape-checked in
  // the special cases in validate.ts (like reqHeader/columns).
  /** The server-surface member follow-ups: reqStatusCode answers the
   * interned `number | undefined` union (negative = the undefined arm —
   * a SERVER request, where Node's statusCode is undefined; every client
   * response carries a real status); reqSocket is the underlying
   * connection (+1, the same handle net.connect would give);
   * sockRemoteAddress answers `string | undefined` (NULL after the fd
   * closed, Node's destroyed-socket undefined; a dual-stack accept of an
   * IPv4 peer reads "::ffff:a.b.c.d" like Node). reqResume/reqDestroy and
   * the req error/close listener slots complete the IncomingMessage
   * surface portless's client responses use; resDestroy/resOnClose and
   * resWriteHeadPairs ([k0,v0,k1,v1,...] — the env.pairs helper's flat
   * shape) complete ServerResponse. sockSetTimeout arms the idle
   * EVFILT_TIMER ('timeout' fires after ms of inactivity, once per idle
   * period, never destroying the socket — Node's semantics). */
  "http.reqStatusCode": { argTypes: [HTTPREQ_T], result: VOID },
  // reqStatusMessage's `string | undefined` is program-interned like
  // reqHeader's (the VOID here is the envGet sentinel).
  "http.reqStatusMessage": { argTypes: [HTTPREQ_T], result: VOID },
  /** req.rawHeaders — [name, value, name, value, ...] in arrival order,
   * names in their ORIGINAL case (Node's shape); a fresh string[] per
   * read. reqStatusMessage answers the interned `string | undefined`
   * union — the reason phrase on client responses ("" when the status
   * line carried none), the undefined arm on server requests (the
   * statusCode split). sockDestroyed is socket.destroyed — true once the
   * fd is gone (destroy() or full close). */
  "http.reqRawHeaders": { argTypes: [HTTPREQ_T], result: arrayOf(STRING) },
  /** The `{ ...req.headers }` snapshot feed: [lowercased name, value,
   * ...] pairs in arrival order — the interned %headers.snapshot helper
   * builds the record over it, exactly the process.envPairs pattern. */
  "http.reqHeaderPairs": { argTypes: [HTTPREQ_T], result: arrayOf(STRING) },
  "http.reqRawTrailers": { argTypes: [HTTPREQ_T], result: arrayOf(STRING) },
  "http.reqTrailerPairs": { argTypes: [HTTPREQ_T], result: arrayOf(STRING) },
  "net.sockDestroyed": { argTypes: [NETSOCKET_T], result: BOOL },
  /** socket.writable — the write half is open: no end() yet, no FIN sent,
   * fd alive (connecting sockets answer true; writes queue). Node's
   * stream flag. Borrows; never throws. */
  "net.sockWritable": { argTypes: [NETSOCKET_T], result: BOOL },
  // The 'upgrade' registrations: the callback shapes are program-typed
  // ((req, socket, head) and shorter prefixes — the libCall case checks).
  /** The 'upgrade' events, both sides (SEMANTICS.md — the WebSocket
   * proxying surface): serverOnUpgrade registers (req, socket, head)
   * listeners fired INSTEAD of 'request' for Connection: upgrade
   * requests (the parser steps aside; the socket is raw; `head` carries
   * bytes past the request head; no listener = the socket destroys,
   * Node's default). clientOnUpgrade is the client twin: a 101 response
   * fires (res, socket, head) INSTEAD of 'response'. */
  "http.serverOnUpgrade": { argTypes: [NETSERVER_T, null, BOOL], result: VOID },
  /** server.on("connect", ...) — HTTP CONNECT tunneling, the 'upgrade'
   * machinery's twin: (req, socket, head) fired INSTEAD of 'request' for
   * CONNECT-method requests (no listener = the socket destroys, Node's
   * default). The h2 compat server's 'connect' (portless's RFC 8441
   * handler) only ever sees the HTTP/1.1 arm under the allowHTTP1
   * lowering, so a listener whose second parameter is a UNION with a
   * netSocket arm takes the socket wrapped at that arm (an emitted
   * per-shape adapter — the tags are program data). */
  "http.serverOnConnect": { argTypes: [NETSERVER_T, null, BOOL], result: VOID },
  "http.clientOnUpgrade": { argTypes: [HTTPCLIENTREQ_T, null, BOOL], result: VOID },
  "http.reqSocket": { argTypes: [HTTPREQ_T], result: NETSOCKET_T },
  // reqH2Stream's program-interned Http2Stream | undefined result is
  // checked in the special libCall cases in validate.ts.
  "http.reqH2Stream": { argTypes: [HTTPREQ_T], result: VOID },
  "http.reqH2StreamOrThrow": { argTypes: [HTTPREQ_T, STRING], result: HTTP2STREAM_T },
  /** req.pipe(dest) — the IncomingMessage body streaming into a
   * ServerResponse (the proxy's response leg), a ClientRequest (the
   * request-body forward), or a raw socket (the upgrade-rejection leg);
   * chunk-for-chunk, natural end ends the destination (Node's pipe
   * default; no backpressure — divergence 54's stream model). */
  "http.reqPipeRes": { argTypes: [HTTPREQ_T, HTTPRES_T], result: VOID },
  "http.reqPipeClient": { argTypes: [HTTPREQ_T, HTTPCLIENTREQ_T], result: VOID },
  "http.reqPipeSock": { argTypes: [HTTPREQ_T, NETSOCKET_T], result: VOID },
  "http.reqResume": { argTypes: [HTTPREQ_T], result: VOID },
  "http.reqDestroy": { argTypes: [HTTPREQ_T], result: VOID },
  "http.reqOnError": { argTypes: [HTTPREQ_T, null, BOOL], result: VOID },
  "http.reqOnClose": {
    argTypes: [HTTPREQ_T, { kind: "func", params: [], ret: VOID }, BOOL],
    result: VOID,
  },
  "http.reqOnAborted": {
    argTypes: [HTTPREQ_T, { kind: "func", params: [], ret: VOID }, BOOL],
    result: VOID,
  },
  "http.reqHttpVersion": { argTypes: [HTTPREQ_T], result: STRING },
  "http.reqHttpVersionMajor": { argTypes: [HTTPREQ_T], result: F64 },
  "http.reqHttpVersionMinor": { argTypes: [HTTPREQ_T], result: F64 },
  "http.reqAborted": { argTypes: [HTTPREQ_T], result: BOOL },
  "http.reqComplete": { argTypes: [HTTPREQ_T], result: BOOL },
  "http.resDestroy": { argTypes: [HTTPRES_T], result: VOID },
  "http.resOnClose": {
    argTypes: [HTTPRES_T, { kind: "func", params: [], ret: VOID }, BOOL],
    result: VOID,
  },
  "http.resWriteHeadPairs": { argTypes: [HTTPRES_T, F64, arrayOf(STRING)], result: VOID },
  /** writeHead(status, headers) with a checked-dynamic headers value —
   * the runtime OBJ walk (string/number values; loud fences otherwise;
   * may throw). */
  "http.resWriteHeadDyn": { argTypes: [HTTPRES_T, F64, DYN], result: VOID },
  "net.sockSetTimeout": { argTypes: [NETSOCKET_T, F64], result: VOID },
  /** setEncoding('utf8') — 'data' delivers strings inside the chunk-encoding window; other real encodings fence loudly, unknown names throw ERR_UNKNOWN_ENCODING (may throw). */
  "net.sockSetEncoding": { argTypes: [NETSOCKET_T, STRING], result: VOID },
  "http.reqSetEncoding": { argTypes: [HTTPREQ_T, STRING], result: VOID },
  "net.sockOnTimeout": {
    argTypes: [NETSOCKET_T, { kind: "func", params: [], ret: VOID }, BOOL],
    result: VOID,
  },
  "net.sockRemoteAddress": { argTypes: [NETSOCKET_T], result: VOID },
  /** socket.encrypted — `boolean | undefined`: the true arm iff the
   * socket carries a TLS transport (Node types `encrypted: true` on
   * TLSSocket; plain sockets answer undefined — the proxy.ts isEncrypted
   * idiom reads it through a cast). */
  "net.sockEncrypted": { argTypes: [NETSOCKET_T], result: VOID },
  // node:http, the client slice. The response callback shapes are
  // program-dependent (checked by validate.ts); header pairs arrive flat.
  /** node:http, the CLIENT slice (http.request/http.get over the net
   * client machinery): request/requestCb take (host, port, path, method,
   * timeoutMs, headerPairs, autoEnd[, responseCb]) — headerPairs is the
   * flat [k0,v0,...] array (empty for none), autoEnd true is http.get's
   * eager end(). The handle owns one dialed connection (NO pooling — the
   * wire still carries Node's exact head: user headers, then Host,
   * Connection: keep-alive, and the framing header; the socket closes
   * when the response completes). The response delivered to responseCb /
   * 'response' listeners IS an httpReq (IncomingMessage), status and
   * headers parsed from the wire, body via reqOnData/reqOnEnd. Errors are
   * Node-shaped ('connect ECONNREFUSED ip:port', 'socket hang up') and
   * fire 'error' then 'close'; an unhandled 'error' exits 1 like every
   * net handle. clientWrite before end commits to chunked framing unless
   * the caller set content-length; clientEnd(data) before any write sends
   * Content-Length exactly like Node. */
  "http.request": {
    argTypes: [STRING, F64, STRING, STRING, F64, arrayOf(STRING), BOOL],
    result: HTTPCLIENTREQ_T,
  },
  "http.requestCb": {
    argTypes: [STRING, F64, STRING, STRING, F64, arrayOf(STRING), BOOL, null],
    result: HTTPCLIENTREQ_T,
  },
  /** new http.Agent(opts) / new https.Agent(opts): (secure, keepAlive,
   * keepAliveMsecs, maxSockets, maxFreeSockets, timeoutMs, port) — the
   * numeric options arrive < 0 for "unset" (Infinity/256/none; port
   * seeds the settable defaultPort, Node's option merge). Returns the
   * Agent as a checked-dynamic HANDLE (getName/destroy and the
   * sockets/requests/freeSockets counters dispatch through the dyn
   * handle ops). keepAlive: true THROWS the named construction fence —
   * socket POOLING is not modeled (one dial per request); maxSockets
   * accounting is real: over-limit requests defer their dial and queue.
   * MAY THROW. */
  "http.agentNew": { argTypes: [BOOL, BOOL, F64, F64, F64, F64, F64], result: DYN },
  /** The agent-threaded request rows: the http.request/https.request
   * shape with a trailing `agent` dyn argument (an Agent handle, false —
   * the one-shot Connection: close dial — or null/undefined for the
   * default path). port < 0 means "no port option": the agent's settable
   * defaultPort, then the scheme's. MAY THROW (a non-Agent value is
   * Node's ERR_INVALID_ARG_TYPE). */
  "http.requestAgent": {
    argTypes: [STRING, F64, STRING, STRING, F64, arrayOf(STRING), BOOL, DYN],
    result: HTTPCLIENTREQ_T,
  },
  "http.requestAgentCb": {
    argTypes: [STRING, F64, STRING, STRING, F64, arrayOf(STRING), BOOL, DYN, null],
    result: HTTPCLIENTREQ_T,
  },
  /** request/get with a URL-STRING first argument: the runtime parses it
   * (WHATWG) and dials — throws catchably on an unparsable input or a
   * non-http scheme. */
  "http.requestUrl": { argTypes: [STRING, STRING, BOOL], result: HTTPCLIENTREQ_T },
  "http.requestUrlCb": { argTypes: [STRING, STRING, BOOL, null], result: HTTPCLIENTREQ_T },
  /** The paused-mode demux surface (portless's first-byte TLS peek:
   * once('readable') + read(1) + unshift + emit('connection')).
   * sockOnReadable registers a zero-param listener (a consumer: arrived
   * bytes buffer instead of flowing, and EOF announces too); sockRead
   * answers `Buffer | null` (exactly n buffered bytes, or null — Node's
   * less-than-n answer; n <= 0 drains everything); sockUnshift returns
   * bytes to the front of the stream; serverEmitConnection routes a
   * socket into another server's protocol layer (a TLS target's
   * 'connection' waits for its handshake). */
  "net.sockOnReadable": { argTypes: [NETSOCKET_T, null, BOOL], result: VOID },
  // sockRead's result is the interned `Buffer | null` union — checked
  // specially in validate.ts (the reqHeader/envGet pattern; VOID here is a
  // placeholder the special case overrides).
  "net.sockRead": { argTypes: [NETSOCKET_T, F64], result: VOID },
  "net.sockUnshift": { argTypes: [NETSOCKET_T, BYTES_U8], result: VOID },
  /** Socket flow control and the compat surface: pause/resume (reads
   * gate off/on — kernel backpressure holds paused bytes; resume flows
   * and discards sans listeners) and setNoDelay answer the SOCKET (+1,
   * Node's chaining); destroySoon ends now and destroys once the FIN
   * flushed; bytesWritten counts accepted bytes; readable is true until
   * the read half ends. */
  "net.sockPause": { argTypes: [NETSOCKET_T], result: NETSOCKET_T },
  "net.sockResume": { argTypes: [NETSOCKET_T], result: NETSOCKET_T },
  "net.sockSetNoDelay": { argTypes: [NETSOCKET_T, BOOL], result: NETSOCKET_T },
  "net.sockDestroySoon": { argTypes: [NETSOCKET_T], result: VOID },
  "net.sockBytesWritten": { argTypes: [NETSOCKET_T], result: F64 },
  "net.sockReadable": { argTypes: [NETSOCKET_T], result: BOOL },
  /** socket.on('finish', cb) / end(cb): fires once when the FIN goes out
   * (sweep-deferred, never the registering stack). */
  "net.sockOnFinish": {
    argTypes: [NETSOCKET_T, { kind: "func", params: [], ret: VOID }],
    result: VOID,
  },
  "net.serverEmitConnection": { argTypes: [NETSERVER_T, NETSOCKET_T], result: VOID },
  // tls/https: cert/key/ca PEM arguments are strings OR Buffers (null =
  // both accepted; the emitter passes data+len either way).
  /** node:tls + node:https (scr_tls.c over scr_net.c/scr_http.c, with
   * the vendored mbedTLS archive — linked only when one of these appears
   * on the IR; moduleUsesTls is the switch, and every tls/https libCall
   * also counts as net AND http use so both units link and install).
   * tls.createServer takes (cert, key[, handler]) — cert/key are PEM
   * strings or Buffers (the emitter passes data+len for either); the
   * handler is Node's 'secureConnection' (fires post-handshake with a
   * socket that behaves exactly like a net socket, the same adapters as
   * net.createServer). https.createServer is (cert, key, handler) with
   * the http request-handler adapters. https.request/requestCb extend
   * the http client row with (…, rejectUnauthorized: bool, ca: PEM
   * string/Buffer — "" for none) and default port 443; everything else
   * (write/end/destroy/events, the response surface) IS the http client
   * surface — the handles are the same kinds. */
  "tls.createServer": { argTypes: [null, null], result: NETSERVER_T },
  "tls.createServerCb": { argTypes: [null, null, null], result: NETSERVER_T },
  // The runtime options records (divergence 66's stance): a dyn options
  // value whose members read at runtime; pemDyn extracts a runtime-valued
  // cert/key member (arg 1 is the precomposed fence label).
  /** RUNTIME options records (the divergence-66 stance): the *Dyn
   * creators take a checked-dynamic (dyn) options value whose members
   * read at runtime — cert/key extract like the literal path, members
   * whose literal forms fence THROW the catchable fence at runtime, and
   * undocumented keys drop like Node drops them. tls.pemDyn is the
   * literal walk's runtime-valued cert/key extraction: (value, whatLit)
   * → PEM bytes (strings/Buffers/one-element arrays of those) or the
   * thrown fence. All of them may throw. */
  "tls.pemDyn": { argTypes: [DYN, STRING], result: BYTES_U8 },
  "tls.createServerDyn": { argTypes: [DYN], result: NETSERVER_T },
  "tls.createServerDynCb": { argTypes: [DYN, null], result: NETSERVER_T },
  "https.createServerDyn": { argTypes: [DYN], result: NETSERVER_T },
  "https.createServerDynCb": { argTypes: [DYN, null], result: NETSERVER_T },
  /** createSecureServer(options, handler) — the eager COMPAT handler as
   * the first 'request' listener (Node's exact route), on both literal
   * flavors: Req is the dual ALPN allowHTTP1 server, H2Req the ALPN=h2-only
   * server (both use compat handles over h2 streams). Args are
   * (cert, key, cb, enableConnectProtocol). */
  "http2.createSecureServerReq": { argTypes: [null, null, null, BOOL], result: NETSERVER_T },
  "http2.createSecureServerH2Req": { argTypes: [null, null, null, BOOL], result: NETSERVER_T },
  /** createSecureServer with a RUNTIME options record (the divergence-66
   * stance): allowHTTP1/cert/key read at runtime — allowHTTP1 picks the
   * flavor, the TLS server walk fences its out-of-bounds members with
   * the catchable runtime fence, and h2 session-tuning keys drop exactly
   * like the literal walk ignores them. May throw. The Cb form carries
   * the eager compat handler. */
  "http2.createSecureServerDyn": { argTypes: [DYN], result: NETSERVER_T },
  "http2.createSecureServerDynCb": { argTypes: [DYN, null], result: NETSERVER_T },
  // tls.connect(port, host, opts[, cb]) — port -1 / host "" read the
  // options record; the callback fires post-handshake (secureConnect).
  /** tls.connect — the TLS client socket: (port, host, opts[, cb]) where
   * port -1 reads options.port, host "" reads options.host, and opts is
   * the runtime (dyn) options record (rejectUnauthorized/ca/servername
   * implemented; other documented members throw the runtime fence). The
   * callback fires post-handshake — Node's secureConnect timing. */
  "tls.connect": { argTypes: [F64, STRING, DYN], result: NETSOCKET_T },
  "tls.connectCb": { argTypes: [F64, STRING, DYN, null], result: NETSOCKET_T },
  // The TLSSocket member surface (authError's `string | null` union is
  // shape-checked in the special cases in validate.ts — the reqHeader pattern).
  /** The TLSSocket member surface on the socket kind: authorized (bool —
   * Node's verify verdict), authorizationError (the verify-failure CODE
   * STRING or null), the 'secureConnect' registration (a TLS socket's
   * conn list fires at establishment; plain sockets never fire it), and
   * the 'session' registration (fires once with the serialized session —
   * a Buffer; the received-ticket event). */
  "tls.sockAuthorized": { argTypes: [NETSOCKET_T], result: BOOL },
  "tls.sockAuthError": { argTypes: [NETSOCKET_T], result: VOID },
  "tls.sockOnSecureConnect": {
    argTypes: [NETSOCKET_T, { kind: "func", params: [], ret: VOID }, BOOL],
    result: VOID,
  },
  "tls.sockOnSession": { argTypes: [NETSOCKET_T, null, BOOL], result: VOID },
  // createSecureContext({ cert, key }) mints the opaque SNI-answer handle.
  /** tls.createSecureContext({ cert, key }) — parses the PEM pair into an
   * opaque SecureContext handle (secureCtx kind) for SNI callbacks to
   * answer with; cert/key are PEM strings or Buffers like createServer's. */
  "tls.createSecureContext": { argTypes: [null, null], result: SECURECTX_T },
  /** createSecureContext over a RUNTIME options record (the checked-
   * dynamic lane): Node's typed option validations first (the ciphers/
   * passphrase/engine/version/timeout/ticketKeys ladders), then the pem
   * walk — a validated { cert, key } bag builds the real context.
   * May-throw. */
  "tls.createSecureContextDyn": { argTypes: [DYN], result: SECURECTX_T },
  /** tls.getCACertificates(type): validateString + the documented name
   * set, then the trailing compiler-rendered fence — ALWAYS THROWS (the
   * error.nodeThrow polymorphic-result carve-out). May-throw seed. */
  "tls.caCertsChk": { argTypes: [DYN, STRING], result: VOID },
  // The CA-store introspection unit (scr_tls_ca.c): per-type cached PEM
  // string arrays and the default-set replacement.
  /** The CA-store introspection surface (scr_tls_ca.c — its own unit and
   * link gate, "tlsca." NOT "tls.", so a getCACertificates-only binary
   * never pulls mbedTLS): tlsca.get is tls.getCACertificates(type) — the
   * cached per-type string[] of PEM blocks (identity-stable across calls,
   * Node's caching; an unknown type throws Node's ERR_INVALID_ARG_VALUE
   * TypeError); tlsca.root is the tls.rootCertificates value read;
   * tlsca.set is tls.setDefaultCACertificates(certs) — replaces the
   * default set (deduped) and the anchors the TLS client verifies
   * against, throwing Node's ERR_CRYPTO_OPERATION_FAILED when no entry
   * carries a certificate block. */
  "tlsca.get": { argTypes: [STRING], result: arrayOf(STRING) },
  "tlsca.root": { argTypes: [], result: arrayOf(STRING) },
  "tlsca.set": { argTypes: [arrayOf(STRING)], result: VOID },
  "https.createServer": { argTypes: [null, null, null], result: NETSERVER_T },
  // http2's allowHTTP1 compatibility server (divergence 57): cert/key
  // like tls.createServer; the 'request' handler arrives separately via
  // http.serverOnRequest (shape checked in the libCall case, like
  // http.createServer's). sessionError callback shape is checked by validate.ts.
  /** node:http2 allowHTTP1: one TLS server advertises h2 + http/1.1 and
   * dispatches to the matching parser after ALPN. Request listeners mirror
   * into both compatibility lists; the remaining session/req.stream rows
   * below retain their explicitly limited behavior. */
  "http2.createSecureServer": { argTypes: [null, null, BOOL], result: NETSERVER_T },
  // The SNI-callback form: arg 2 is the JS SNICallback closure — a
  // `(servername, cb) => void` func, or its `| undefined` union from the
  // conditional-spread spelling (the libCall case checks the shape).
  /** createSecureServer with an SNI callback: args are (cert, key, sniCb)
   * where sniCb is the JS SNICallback — a `(servername, cb) => void`
   * closure, or the `SNICallback | undefined` union from the conditional-
   * spread spelling (`...(x ? { SNICallback: x } : {})`; the emitter
   * unwraps the union — the undefined arm means "no callback", exactly
   * the no-SNI server). The runtime parses each connection's ClientHello
   * for the server_name extension BEFORE the TLS handshake begins, calls
   * the callback with (servername, answer-closure), and resumes the
   * handshake when the answer arrives — cb(err) tears the socket down
   * silently (Node's 'tlsClientError' default), cb(null, ctx) serves
   * ctx's cert/key, cb(null, undefined) serves the default pair. */
  "http2.createSecureServerSni": { argTypes: [null, null, null, BOOL], result: NETSERVER_T },
  // The ALPN=h2 server (createSecureServer without allowHTTP1): the real
  // h2 session machinery behind the TLS handshake.
  /** The REAL h2-over-TLS server (createSecureServer WITHOUT allowHTTP1):
   * scr_http2_create_secure_server — the h2c session machinery behind an
   * mbedTLS handshake whose ALPN advertises h2 alone (an http/1.1-only
   * client fails the handshake with no_application_protocol, Node's
   * h2-only split). args are (cert, key) — PEM strings or Buffers. */
  "http2.createSecureServerH2": { argTypes: [null, null, BOOL], result: NETSERVER_T },
  "http.serverOnRequest": { argTypes: [NETSERVER_T, null, BOOL], result: VOID },
  "http2.serverOnSessionError": { argTypes: [NETSERVER_T, null, BOOL], result: VOID },
  /** The guarded absent-session compatibility call remains a no-op. */
  "http2.streamNoop": { argTypes: [], result: VOID },
  /** The UNGUARDED h2-only stream call (`req.stream.on(...)`): stream is
   * undefined on every connection the allowHTTP1 lowering accepts — and
   * on every HTTP/1.1 connection of Node's own allowHTTP1 server — so the
   * call IS Node's member read on undefined: throws the exact catchable
   * TypeError ("Cannot read properties of undefined (reading 'on')").
   * One arg: the read member's name (a string literal). Never returns. */
  "http2.streamUndefCall": { argTypes: [STRING], result: VOID },
  // The REAL h2c surface (scr_http2.c). Callback slots are null (the
  // emitter picks the thunk); pairs slots are string arrays; the
  // endStream tri-state and event flags ride as f64.
  /** node:http2, the REAL h2c surface (scr_http2.c — frame codec + HPACK
   * over the net loop; the design note atop that file has the story).
   * Sessions and streams are first-class handle kinds; 'stream'/'response'
   * payloads cross as flat [name, value, ...] pairs arrays and an EMITTED
   * adapter closure builds the program-side headers record (the response
   * :status rides separately as a number). */
  "http2.createServer": { argTypes: [], result: NETSERVER_T },
  "http2.createServerReq": { argTypes: [null], result: NETSERVER_T },
  "http2.serverOnStream": { argTypes: [NETSERVER_T, null, BOOL], result: VOID },
  "http2.serverOnSession": { argTypes: [NETSERVER_T, null, BOOL], result: VOID },
  // connect(authority, reject, ca[, cb]): the TLS client knobs an https
  // authority reads (inert on http ones, exactly Node); ca is a PEM
  // string/Buffer ("" = the system anchors).
  /** connect(authority[, listener]) — h2c prior knowledge; the listener
   * closure (if any) is the 'connect' once-listener. */
  "http2.connect": { argTypes: [STRING, BOOL, null], result: HTTP2SESSION_T },
  "http2.connectCb": { argTypes: [STRING, BOOL, null, null], result: HTTP2SESSION_T },
  /** session.request(pairs?, endStream) — endStream is a tri-state f64:
   * -1 the method's payload-meaningless default, 0/1 explicit. */
  "http2.sessionRequest": {
    argTypes: [HTTP2SESSION_T, arrayOf(STRING), F64],
    result: HTTP2STREAM_T,
  },
  "http2.sessionClose": { argTypes: [HTTP2SESSION_T], result: VOID },
  "http2.sessionCloseCb": { argTypes: [HTTP2SESSION_T, null], result: VOID },
  "http2.sessionDestroy": { argTypes: [HTTP2SESSION_T], result: VOID },
  "http2.sessionOnClose": { argTypes: [HTTP2SESSION_T, null, BOOL], result: VOID },
  "http2.sessionOnError": { argTypes: [HTTP2SESSION_T, null, BOOL], result: VOID },
  "http2.sessionOnConnect": { argTypes: [HTTP2SESSION_T, null, BOOL], result: VOID },
  "http2.sessionOnStream": { argTypes: [HTTP2SESSION_T, null, BOOL], result: VOID },
  "http2.sessionOnGoaway": { argTypes: [HTTP2SESSION_T, null, BOOL], result: VOID },
  "http2.sessionClosed": { argTypes: [HTTP2SESSION_T], result: BOOL },
  "http2.sessionDestroyed": { argTypes: [HTTP2SESSION_T], result: BOOL },
  "http2.sessionEncrypted": { argTypes: [HTTP2SESSION_T], result: BOOL },
  "http2.sessionType": { argTypes: [HTTP2SESSION_T], result: F64 },
  "http2.sessionAlpn": { argTypes: [HTTP2SESSION_T], result: STRING },
  "http2.sessionSocket": { argTypes: [HTTP2SESSION_T], result: NETSOCKET_T },
  /** stream.respond(pairs?, endStream) — the server answer. */
  "http2.streamRespond": { argTypes: [HTTP2STREAM_T, arrayOf(STRING), BOOL], result: VOID },
  "http2.streamWrite": { argTypes: [HTTP2STREAM_T, STRING], result: VOID },
  "http2.streamWriteBytes": { argTypes: [HTTP2STREAM_T, BYTES_U8], result: VOID },
  "http2.streamEnd": { argTypes: [HTTP2STREAM_T], result: VOID },
  "http2.streamEndStr": { argTypes: [HTTP2STREAM_T, STRING], result: VOID },
  "http2.streamEndBytes": { argTypes: [HTTP2STREAM_T, BYTES_U8], result: VOID },
  "http2.streamClose": { argTypes: [HTTP2STREAM_T, F64], result: VOID },
  "http2.streamCloseCb": { argTypes: [HTTP2STREAM_T, F64, null], result: VOID },
  "http2.streamDestroy": { argTypes: [HTTP2STREAM_T], result: VOID },
  "http2.sessionSettings0": { argTypes: [HTTP2SESSION_T], result: VOID },
  "http2.sessionSettings": { argTypes: [HTTP2SESSION_T, DYN], result: VOID },
  "http2.sessionSettingsDynCb": { argTypes: [HTTP2SESSION_T, DYN, DYN], result: VOID },
  "http2.sessionSettingsCb0": {
    argTypes: [HTTP2SESSION_T, DYN, { kind: "func", params: [], ret: VOID }],
    result: VOID,
  },
  "http2.sessionOnSettingsDyn": { argTypes: [HTTP2SESSION_T, DYN, BOOL, BOOL], result: VOID },
  "http2.sessionOnSettings0": {
    argTypes: [HTTP2SESSION_T, { kind: "func", params: [], ret: VOID }, BOOL, BOOL],
    result: VOID,
  },
  "http2.sessionSettingsGet": { argTypes: [HTTP2SESSION_T, BOOL], result: DYN },
  "http2.sessionPendingSettingsAck": { argTypes: [HTTP2SESSION_T], result: BOOL },
  "http2.getDefaultSettings": { argTypes: [], result: DYN },
  "http2.streamSetEncoding": { argTypes: [HTTP2STREAM_T, STRING], result: VOID },
  "http2.streamSetEncodingRet": { argTypes: [HTTP2STREAM_T, STRING], result: HTTP2STREAM_T },
  "http2.streamResume": { argTypes: [HTTP2STREAM_T], result: VOID },
  "http2.streamPause": { argTypes: [HTTP2STREAM_T], result: VOID },
  "http2.streamOnData": { argTypes: [HTTP2STREAM_T, null, BOOL], result: VOID },
  "http2.streamOnEnd": { argTypes: [HTTP2STREAM_T, null, BOOL], result: VOID },
  "http2.streamOnClose": { argTypes: [HTTP2STREAM_T, null, BOOL], result: VOID },
  "http2.streamOnAborted": { argTypes: [HTTP2STREAM_T, null, BOOL], result: VOID },
  "http2.streamOnError": { argTypes: [HTTP2STREAM_T, null, BOOL], result: VOID },
  "http2.streamOnResponse": { argTypes: [HTTP2STREAM_T, null, BOOL], result: VOID },
  "http2.streamId": { argTypes: [HTTP2STREAM_T], result: F64 },
  "http2.streamRstCode": { argTypes: [HTTP2STREAM_T], result: F64 },
  "http2.streamDestroyed": { argTypes: [HTTP2STREAM_T], result: BOOL },
  "http2.streamClosed": { argTypes: [HTTP2STREAM_T], result: BOOL },
  "http2.streamAborted": { argTypes: [HTTP2STREAM_T], result: BOOL },
  "http2.streamPending": { argTypes: [HTTP2STREAM_T], result: BOOL },
  "http2.streamSession": { argTypes: [HTTP2STREAM_T], result: HTTP2SESSION_T },
  // The createConnection forms: arg 0 is the dialer closure (() =>
  // Socket — the libCall case checks), then path/method/timeout/headers/
  // autoEnd like http.request.
  /** The createConnection form (the proxy's own dialer): args are
   * (connCb, path, method, timeout, headers, autoEnd[, cb]) — connCb is
   * a `() => net.Socket` closure the runtime invokes ONCE, synchronously
   * (Node's onSocket timing); everything else matches http.request. The
   * Host header defaults to "localhost" — a headers.host entry wins
   * verbatim, the proxy shape. */
  "http.requestConn": {
    argTypes: [null, STRING, STRING, F64, arrayOf(STRING), BOOL],
    result: HTTPCLIENTREQ_T,
  },
  "http.requestConnCb": {
    argTypes: [null, STRING, STRING, F64, arrayOf(STRING), BOOL, null],
    result: HTTPCLIENTREQ_T,
  },
  "https.request": {
    argTypes: [STRING, F64, STRING, STRING, F64, arrayOf(STRING), BOOL, BOOL, null],
    result: HTTPCLIENTREQ_T,
  },
  "https.requestCb": {
    argTypes: [STRING, F64, STRING, STRING, F64, arrayOf(STRING), BOOL, BOOL, null, null],
    result: HTTPCLIENTREQ_T,
  },
  /** The URL-string first argument, the http.requestUrl row over TLS:
   * no options means Node's defaults (verification on, default trust
   * anchors), and a non-https scheme is ERR_INVALID_PROTOCOL. */
  "https.requestUrl": { argTypes: [STRING, STRING, BOOL], result: HTTPCLIENTREQ_T },
  "https.requestUrlCb": { argTypes: [STRING, STRING, BOOL, null], result: HTTPCLIENTREQ_T },
  "https.requestAgent": {
    argTypes: [STRING, F64, STRING, STRING, F64, arrayOf(STRING), BOOL, BOOL, null, DYN],
    result: HTTPCLIENTREQ_T,
  },
  "https.requestAgentCb": {
    argTypes: [STRING, F64, STRING, STRING, F64, arrayOf(STRING), BOOL, BOOL, null, DYN, null],
    result: HTTPCLIENTREQ_T,
  },
  // The requestFn binding's runtime-secure rows: https.request's shape
  // with the leading `secure` bool.
  /** A call through a `const requestFn = tls ? https.request :
   * http.request` binding — the module-function-as-value ternary between
   * the two known clients: the https.request row with a leading `secure`
   * bool that picks the dial at RUNTIME (true = the TLS client, exactly
   * https.request; false = the plain client, exactly http.request —
   * rejectUnauthorized/ca ignored there like Node ignores TLS options on
   * http.request). The "https." prefix keeps the TLS unit linked. */
  "https.requestFn": {
    argTypes: [BOOL, STRING, F64, STRING, STRING, F64, arrayOf(STRING), BOOL, BOOL, null],
    result: HTTPCLIENTREQ_T,
  },
  "https.requestFnCb": {
    argTypes: [BOOL, STRING, F64, STRING, STRING, F64, arrayOf(STRING), BOOL, BOOL, null, null],
    result: HTTPCLIENTREQ_T,
  },
  "http.clientWrite": { argTypes: [HTTPCLIENTREQ_T, STRING], result: VOID },
  "http.clientSetHeader": { argTypes: [HTTPCLIENTREQ_T, STRING, STRING], result: VOID },
  "http.clientGetHeader": { argTypes: [HTTPCLIENTREQ_T, STRING], result: VOID },
  "http.clientHasHeader": { argTypes: [HTTPCLIENTREQ_T, STRING], result: BOOL },
  "http.clientRemoveHeader": { argTypes: [HTTPCLIENTREQ_T, STRING], result: VOID },
  "http.clientGetHeaderNames": { argTypes: [HTTPCLIENTREQ_T], result: arrayOf(STRING) },
  "http.clientGetRawHeaderNames": { argTypes: [HTTPCLIENTREQ_T], result: arrayOf(STRING) },
  "http.clientGetHeaders": { argTypes: [HTTPCLIENTREQ_T], result: DYN },
  "http.clientWriteBytes": { argTypes: [HTTPCLIENTREQ_T, BYTES_U8], result: VOID },
  "http.clientEnd": { argTypes: [HTTPCLIENTREQ_T], result: VOID },
  "http.clientEndStr": { argTypes: [HTTPCLIENTREQ_T, STRING], result: VOID },
  "http.clientEndBytes": { argTypes: [HTTPCLIENTREQ_T, BYTES_U8], result: VOID },
  /** The checked-dynamic chunk twins (the net.sockWriteDyn story). */
  "http.clientWriteDyn": { argTypes: [HTTPCLIENTREQ_T, DYN], result: VOID },
  "http.clientEndDyn": { argTypes: [HTTPCLIENTREQ_T, DYN], result: VOID },
  "http.clientFlushHeaders": { argTypes: [HTTPCLIENTREQ_T], result: VOID },
  "http.clientAddTrailers": { argTypes: [HTTPCLIENTREQ_T, arrayOf(STRING)], result: VOID },
  "http.clientCork": { argTypes: [HTTPCLIENTREQ_T], result: VOID },
  "http.clientUncork": { argTypes: [HTTPCLIENTREQ_T], result: VOID },
  "http.clientWritableCorked": { argTypes: [HTTPCLIENTREQ_T], result: F64 },
  "http.clientMethod": { argTypes: [HTTPCLIENTREQ_T], result: STRING },
  "http.clientPath": { argTypes: [HTTPCLIENTREQ_T], result: STRING },
  "http.clientHost": { argTypes: [HTTPCLIENTREQ_T], result: STRING },
  "http.clientProtocol": { argTypes: [HTTPCLIENTREQ_T], result: STRING },
  "http.clientHeadersSent": { argTypes: [HTTPCLIENTREQ_T], result: BOOL },
  "http.clientWritableEnded": { argTypes: [HTTPCLIENTREQ_T], result: BOOL },
  "http.clientWritableFinished": { argTypes: [HTTPCLIENTREQ_T], result: BOOL },
  "http.clientSocket": { argTypes: [HTTPCLIENTREQ_T], result: NETSOCKET_T },
  "http.clientReusedSocket": { argTypes: [HTTPCLIENTREQ_T], result: BOOL },
  "http.clientSetNoDelay": { argTypes: [HTTPCLIENTREQ_T, BOOL], result: VOID },
  "http.clientSetSocketKeepAlive": { argTypes: [HTTPCLIENTREQ_T, BOOL, F64], result: VOID },
  "http.clientSetTimeout": { argTypes: [HTTPCLIENTREQ_T, F64], result: VOID },
  "http.clientSetTimeoutCb": {
    argTypes: [HTTPCLIENTREQ_T, F64, { kind: "func", params: [], ret: VOID }],
    result: VOID,
  },
  "http.statusCodes": { argTypes: [], result: DYN },
  "http.methods": { argTypes: [], result: arrayOf(STRING) },
  "http.reqSetTimeout": { argTypes: [HTTPREQ_T, F64], result: VOID },
  "http.reqSetTimeoutCb": {
    argTypes: [HTTPREQ_T, F64, { kind: "func", params: [], ret: VOID }],
    result: VOID,
  },
  "http.clientDestroy": { argTypes: [HTTPCLIENTREQ_T], result: VOID },
  "http.clientAbort": { argTypes: [HTTPCLIENTREQ_T], result: VOID },
  "http.clientAborted": { argTypes: [HTTPCLIENTREQ_T], result: BOOL },
  "http.clientDestroyed": { argTypes: [HTTPCLIENTREQ_T], result: BOOL },
  "http.clientOnResponse": { argTypes: [HTTPCLIENTREQ_T, null, BOOL], result: VOID },
  "http.clientOnSocket": { argTypes: [HTTPCLIENTREQ_T, null, BOOL], result: VOID },
  "http.clientOnFinish": {
    argTypes: [HTTPCLIENTREQ_T, { kind: "func", params: [], ret: VOID }, BOOL],
    result: VOID,
  },
  "http.clientOnError": { argTypes: [HTTPCLIENTREQ_T, null, BOOL], result: VOID },
  "http.clientOnTimeout": {
    argTypes: [HTTPCLIENTREQ_T, { kind: "func", params: [], ret: VOID }, BOOL],
    result: VOID,
  },
  "http.clientOnClose": {
    argTypes: [HTTPCLIENTREQ_T, { kind: "func", params: [], ret: VOID }, BOOL],
    result: VOID,
  },
  "http.clientOnAbort": {
    argTypes: [HTTPCLIENTREQ_T, { kind: "func", params: [], ret: VOID }, BOOL],
    result: VOID,
  },
  /** execFileSync/execSync as ONE entry (args: cmd, argv, shell, input,
   * cwd, hasEnv, envPairs, timeoutMs, stdoutMode, stderrMode — see
   * scr_runtime.h). Throws Node's exact errors: "Command failed: <cmd>"
   * (+ captured stderr) on non-zero exit or signal death, "spawnSync
   * <file> ENOENT" on spawn failure, "spawnSync <file> ETIMEDOUT" after
   * the SIGTERM timeout. Result is the captured utf8 stdout (+1). */
  "cp.execSync": {
    argTypes: [
      STRING,
      arrayOf(STRING),
      BOOL,
      STRING,
      BOOL,
      STRING,
      BOOL,
      arrayOf(STRING),
      F64,
      F64,
      F64,
    ],
    result: STRING,
  },
  /** The promisified-execFile capture (args: cmd, argv, cwd, hasEnv,
   * envPairs, timeoutMs): the same exec core in the async shape — both
   * streams captured, no echo, Node's ASYNC messages on the throw paths
   * ("Command failed: <cmd>\n<stderr>" with the unconditional newline,
   * "spawn <file> ENOENT" with .code, timeouts reporting as ordinary
   * SIGTERM command failures — never ETIMEDOUT). Result reuses the
   * ScrSpawnRes container (+1; stdout/stderr strings, status unused).
   * Called only from the frontend's interned %execFileAsync ASYNC helper,
   * whose fiber turns the throw into the rejection. */
  "cp.execCapture": {
    argTypes: [STRING, arrayOf(STRING), STRING, BOOL, arrayOf(STRING), F64],
    result: SPAWNRES_T,
  },
  /** child_process.spawn (scr_child.c + the scr_async.c loop): posix_spawnp
   * with per-slot ignore/inherit/pipe modes (and number output fds), the
   * all-piped Node default, and the child registered with the event loop,
   * which polls waitpid(WNOHANG) at quiescence like timers.
   * NEVER throws: spawn failure defers to the "error" event, Node-exact
   * (the error message is Node's "spawn <cmd> <ERRNO-NAME>"; an "error"
   * event with no listener prints it and exits 1 like an EventEmitter).
   * cmd/args borrowed; result an owned (+1) child handle. The loop will
   * not exhaust while any spawned child is unreaped — Node's keep-alive.
   *
   * child.onExit / child.onClose / child.onError — terminal listener
   * registration through child.on/once. Close uses the exit adapter shape
   * but fires only after every piped stdio handle reaches EOF. The
   * receiver is borrowed, the CALLBACK MOVES into the child's listener
   * registry (released after the terminal event fires, or at reap for
   * the event that never fires). Both are void (chaining is fenced).
   * onExit's third emitted ingredient is an ADAPTER the backend interns
   * per callback shape: the runtime invokes adapter(cb, has_code, code)
   * and the adapter builds the `number | null` union (tags are program-
   * dependent) or ignores the code for a zero-param callback. onError's
   * adapters are runtime-provided (zero-param, or the %Error one-param
   * shape — scr_error_new needs no program types). "exit" fires once
   * with the code (f64 arm) or null (signal death); "error" fires only
   * for spawn failure, exactly Node's split. */
  "cp.spawn": { argTypes: [STRING, arrayOf(STRING)], result: CHILD_T },
  /** Static-native fork startup and IPC. process.forkTarget initializes a
   * re-executed child's inherited channel and returns its embedded target id
   * (-1 in the parent). The remaining entries mirror Node's JSON channel. */
  "process.forkTarget": { argTypes: [F64], result: F64 },
  "cp.fork": {
    argTypes: [F64, arrayOf(STRING), F64, F64, F64, BOOL, arrayOf(STRING), STRING],
    result: CHILD_T,
  },
  "child.connected": { argTypes: [CHILD_T], result: BOOL },
  "child.send": { argTypes: [CHILD_T, STRING], result: BOOL },
  "child.sendCb": { argTypes: [CHILD_T, STRING, null], result: BOOL },
  "child.disconnect": { argTypes: [CHILD_T], result: VOID },
  "child.onMessage": { argTypes: [CHILD_T, null, BOOL], result: VOID },
  "child.onDisconnect": { argTypes: [CHILD_T, null, BOOL], result: VOID },
  "child.onSpawn": { argTypes: [CHILD_T, null], result: VOID },
  /** Rest listeners use the checked function bridge to pack event arguments. */
  "child.onDyn": { argTypes: [CHILD_T, STRING, DYN], result: VOID },
  "process.connected": { argTypes: [], result: BOOL },
  "process.send": { argTypes: [STRING], result: BOOL },
  "process.sendCb": { argTypes: [STRING, null], result: BOOL },
  "process.disconnect": { argTypes: [], result: VOID },
  "process.onMessage": { argTypes: [null, BOOL], result: VOID },
  "process.onDisconnect": { argTypes: [null, BOOL], result: VOID },
  /** child_process.execFile's callback slice: starts an all-piped child,
   * captures stdout/stderr, and moves the error-first callback into the
   * child registry. The callback shape is program-dependent and checked
   * by the validator/backends. */
  "cp.execFile": { argTypes: [STRING, arrayOf(STRING), null], result: CHILD_T },
  // spawn's options form: per-slot stdio modes (0 ignore / 1 inherit /
  // 2 fd) with the out/err fds for mode 2, detached, env replacement
  // pairs, cwd ("" = inherit).
  /** spawn with options (scr_child.c): the cp.spawn core plus PER-SLOT
   * stdio — args are (cmd, argv, inMode, outMode, errMode, outFd, errFd,
   * detached, hasEnv, envPairs, cwd); modes 0 ignore (/dev/null), 1
   * inherit, 2 fd (out/err only — the fd dup2s into the child's slot,
   * Node's stdio fd form; the daemon-log idiom ["ignore", logFd, logFd]).
   * detached is POSIX_SPAWN_SETSID (the child gets its own session and
   * process group, Node's semantics), env is a REPLACEMENT ([k,v,...]
   * pairs like cp.execSync's), cwd ""=inherit. Same event/loop story as
   * cp.spawn. */
  "cp.spawnOpts": {
    argTypes: [
      STRING,
      arrayOf(STRING),
      F64,
      F64,
      F64,
      F64,
      F64,
      BOOL,
      BOOL,
      BOOL,
      arrayOf(STRING),
      STRING,
    ],
    result: CHILD_T,
  },
  /** Runtime options normalized into the native spawn core; unsupported
   * process features retain explicit refusals. (command, args, options). */
  "cp.spawnDynamic": { argTypes: [STRING, arrayOf(STRING), DYN], result: CHILD_T },
  // The callback's func type is program-dependent (zero params, or the
  // `number | null` union / the %Error class) — the libCall case checks
  // the shape; the slot here only pins arity and the child receiver.
  "child.onExit": { argTypes: [CHILD_T, null], result: VOID },
  "child.onClose": { argTypes: [CHILD_T, null], result: VOID },
  "child.onError": { argTypes: [CHILD_T, null], result: VOID },
  // Like process.envGet, spawnRes.status's result type is program-dependent
  // (the interned `number | null` union) — the libCall case checks the arms.
  "spawnRes.status": { argTypes: [SPAWNRES_T], result: VOID },
  // spawnRes.error's result is the interned `Error | undefined` union —
  // the libCall case checks the arms, the spawnRes.status pattern.
  /** Node's spawn-failure carrier `error?: Error`: a fresh +1 %Error
   * ("spawnSync <file> ENOENT", `code` stamped) when the spawn itself
   * failed, the interned undefined arm otherwise — the result type is the
   * call site's `Error | undefined` union, constructed type-directedly in
   * the backend (the envGet convention). Never throws. */
  "spawnRes.error": { argTypes: [SPAWNRES_T], result: VOID },
  // spawnRes.signal's result is the interned `string | null` union —
  // same pattern.
  "spawnRes.signal": { argTypes: [SPAWNRES_T], result: VOID },
  // The ChildProcess lifecycle members: pid/exitCode are program-dependent
  // unions (`number | undefined` / `number | null` — the libCall case
  // checks the arms, the spawnRes.status pattern).
  /** The ChildProcess lifecycle members (scr_child.c), Node's shapes
   * exactly (SEMANTICS.md has the pinned matrix). child.pid is the
   * checker's `number | undefined` (undefined = spawn failure) and
   * child.exitCode its `number | null` (null while running and after a
   * signal death; -errno once a spawn failure settled) — both unions are
   * type-directed constructions in the backend over a has/get runtime
   * pair, the spawnRes.status pattern. child.killed is Node's
   * sent-a-signal flag. child.kill sends while the child is un-reaped
   * (false after — Node's null-handle answer) and THROWS the
   * Unknown-signal TypeError on bad names (may-throw); killNum passes
   * numbers through (0 probes; never throws). child.unref drops the
   * child from the loop's keep-alive set — it is still reaped while the
   * loop runs for other reasons, and one the loop never reaps is left to
   * the OS at exit. All receivers borrowed. */
  "child.pid": { argTypes: [CHILD_T], result: VOID },
  "child.exitCode": { argTypes: [CHILD_T], result: VOID },
  // The close-override pair: the bound close's result func type and the
  // override's func argument are program-dependent (the callback union's
  // tags) — the slots pin the server receiver; the libCall case checks
  // the bound value's shape.
  /** The close-override pair (the portless close-proxy idiom).
   * serverCloseBind is `wrapper.close.bind(wrapper)` as a VALUE: a
   * compiler-emitted closure over the server whose invocation runs the
   * REAL close (scr_net_server_close_direct — never the override), so
   * the override body's `origClose(cb)` cannot recurse; its callback
   * argument (the `((err?: Error) => void) | undefined` union) registers
   * as a once-'close' listener, a one-param callback wrapped by an
   * emitted zero-arg trampoline firing the undefined arm (a clean close
   * carries no error). serverSetCloseOverride is `wrapper.close = fn`:
   * the override MOVES in behind an emitted zero-arg wrapper (it invokes
   * the user function with the undefined-arm callback — tags are program
   * data), and server.close() consults it before closing. */
  "net.serverCloseBind": { argTypes: [NETSERVER_T], result: VOID },
  "net.serverSetCloseOverride": { argTypes: [NETSERVER_T, null], result: VOID },
  // The piped-output stream reads: `Readable | null` unions (the libCall
  // case checks the arms — the child.pid pattern with a ref arm).
  /** The piped-output streams (stdio mode 3 — scr_child.c's stream
   * slice). child.stdout/child.stderr answer the checker's
   * `Readable | null` union (type-directed construction in the backend
   * over the +1-or-NULL runtime pair — the child.pid pattern with a ref
   * arm). stream.onData/onEnd register 'data'/'end' listeners (receiver
   * borrowed, CALLBACK MOVES, trailing once-flag, void — chaining
   * fenced): 'data' fires one Buffer chunk per read (zero-param and
   * Buffer/string adapters are runtime-provided; setEncoding threads
   * split multibyte sequences through the shared StringDecoder core. A
   * union-param listener —
   * ngrok's `Buffer | string` — gets a compiler-emitted adapter wrapping
   * the chunk at its Buffer arm), 'end' fires once at EOF, always BEFORE
   * the child's 'exit' (the pinned ordering). A flowing stream keeps the
   * loop alive: usesTimers. */
  "child.stdout": { argTypes: [CHILD_T], result: VOID },
  "child.stderr": { argTypes: [CHILD_T], result: VOID },
  /** The piped-input writer (stdio mode 3 on fd 0). child.stdin answers
   * `Writable | null`; writes copy borrowed data into the nonblocking
   * queue, end/destroy settle it, writable is a pure state read, and
   * listener callbacks move into the writer registry. */
  "child.stdin": { argTypes: [CHILD_T], result: VOID },
  // Listener registrations: callback func shapes are program-dependent
  // (zero-param / Buffer / Buffer-armed union) — the slots pin arity,
  // the stream receiver, and the once-flag.
  "stream.onData": { argTypes: [CHILDSTREAM_T, null, BOOL], result: VOID },
  "stream.onDataStr": { argTypes: [CHILDSTREAM_T, null, BOOL], result: VOID },
  "stream.onEnd": { argTypes: [CHILDSTREAM_T, null, BOOL], result: VOID },
  "stream.childSetEncoding": { argTypes: [CHILDSTREAM_T, STRING], result: CHILDSTREAM_T },
  "writer.writeString": { argTypes: [CHILDWRITER_T, STRING], result: BOOL },
  "writer.writeBytes": { argTypes: [CHILDWRITER_T, BYTES_U8], result: BOOL },
  "writer.end": { argTypes: [CHILDWRITER_T], result: VOID },
  "writer.destroy": { argTypes: [CHILDWRITER_T], result: VOID },
  "writer.writable": { argTypes: [CHILDWRITER_T], result: BOOL },
  "writer.onDrain": { argTypes: [CHILDWRITER_T, null, BOOL], result: VOID },
  "writer.onFinish": { argTypes: [CHILDWRITER_T, null, BOOL], result: VOID },
  "writer.onError": { argTypes: [CHILDWRITER_T, null, BOOL], result: VOID },
  /** The first-class WritableStream write (`output.write(line)` — the
   * prefixStream idiom): the receiver IS the fd scalar (process.stdout/
   * stderr reads mint 1/2), dispatched onto the exact stdoutWrite/
   * stderrWrite paths so buffering and ordering stay identical. Data
   * borrowed; the bool is Node's always-true backpressure signal. */
  "procStream.write": { argTypes: [PROCSTREAM_T, STRING], result: BOOL },
  "child.killed": { argTypes: [CHILD_T], result: BOOL },
  "child.kill": { argTypes: [CHILD_T, STRING], result: BOOL },
  "child.killNum": { argTypes: [CHILD_T, F64], result: BOOL },
  "child.unref": { argTypes: [CHILD_T], result: VOID },
  "child.ref": { argTypes: [CHILD_T], result: VOID },
  "spawnRes.stdout": { argTypes: [SPAWNRES_T], result: STRING },
  "spawnRes.stderr": { argTypes: [SPAWNRES_T], result: STRING },
  /** fs/promises (scr_lib.c over scr_async.c's settled minting): the SAME
   * sync syscalls, wrapped in an ALREADY-SETTLED promise — failure
   * REJECTS (catchable at the await) instead of throwing, so none of
   * these are in the may-throw seed. readFile is utf8-fenced like
   * readFileSync. The non-interleaving divergence is documented in
   * SEMANTICS.md. */
  /** node:crypto randomness: randomUUID plus randomBytes as either a real
   * Buffer or the fused randomBytes(n).toString("hex"|"base64") path.
   * The size-taking forms throw Node's RangeError on invalid values. */
  "crypto.randomUUID": { argTypes: [], result: STRING },
  "crypto.randomBytesToString": { argTypes: [F64, STRING], result: STRING },
  /** crypto.randomBytes(n) → a real u8 Buffer (+1). THROWS Node's
   * RangeError on out-of-range sizes, exactly like the composed
   * randomBytesToString (which keeps its one-libCall lowering — the two
   * coexist: the composed form never materializes the Buffer). */
  "crypto.randomBytes": { argTypes: [F64], result: BYTES_U8 },
  /** The fused createHash(alg).update(data).digest(enc) fast path and the
   * one-shot crypto.hash implementation. First-class Hash/Hmac handles use
   * the entries below; all paths share the incremental runtime core. */
  "crypto.hashDigestStr": { argTypes: [STRING, STRING, STRING], result: STRING },
  "crypto.hashDigestBytes": { argTypes: [STRING, BYTES_U8, STRING], result: STRING },
  /** First-class static Hash/Hmac handles. Constructors validate the
   * runtime algorithm string (MD5, SHA-1, or SHA-2); update returns the same
   * handle by retained identity, copy snapshots Hash state, and digest
   * finalizes the handle and returns either a Buffer or encoded string. */
  "crypto.native": { argTypes: [], result: DYN },
  "crypto.hashNew": { argTypes: [STRING], result: CRYPTOHASH_T },
  "crypto.hmacNewStr": { argTypes: [STRING, STRING], result: CRYPTOHMAC_T },
  "crypto.hmacNewBytes": { argTypes: [STRING, BYTES_U8], result: CRYPTOHMAC_T },
  "crypto.hashUpdateStr": { argTypes: [CRYPTOHASH_T, STRING], result: CRYPTOHASH_T },
  "crypto.hashUpdateBytes": { argTypes: [CRYPTOHASH_T, BYTES_U8], result: CRYPTOHASH_T },
  "crypto.hmacUpdateStr": { argTypes: [CRYPTOHMAC_T, STRING], result: CRYPTOHMAC_T },
  "crypto.hmacUpdateBytes": { argTypes: [CRYPTOHMAC_T, BYTES_U8], result: CRYPTOHMAC_T },
  "crypto.hashCopy": { argTypes: [CRYPTOHASH_T], result: CRYPTOHASH_T },
  "crypto.hashDigestString": { argTypes: [CRYPTOHASH_T, STRING], result: STRING },
  "crypto.hashDigestBuffer": { argTypes: [CRYPTOHASH_T], result: BYTES_U8 },
  "crypto.hmacDigestString": { argTypes: [CRYPTOHMAC_T, STRING], result: STRING },
  "crypto.hmacDigestBuffer": { argTypes: [CRYPTOHMAC_T], result: BYTES_U8 },
  "crypto.timingSafeEqual": { argTypes: [BYTES_U8, BYTES_U8], result: BOOL },
  "crypto.randomFill": { argTypes: [BYTES_U8, F64, F64], result: BYTES_U8 },
  "crypto.randomFillRest": { argTypes: [BYTES_U8, F64], result: BYTES_U8 },
  "crypto.randomInt": { argTypes: [F64, F64], result: F64 },
  "crypto.pbkdf2": { argTypes: [BYTES_U8, BYTES_U8, F64, F64, STRING], result: BYTES_U8 },
  "crypto.randomBytesCb": { argTypes: [F64, null], result: VOID },
  "crypto.pbkdf2Cb": { argTypes: [BYTES_U8, BYTES_U8, F64, F64, STRING, null], result: VOID },
  "crypto.hkdf": { argTypes: [STRING, BYTES_U8, BYTES_U8, BYTES_U8, F64], result: DYN },
  "crypto.hkdfCb": { argTypes: [STRING, BYTES_U8, BYTES_U8, BYTES_U8, F64, null], result: VOID },
  "crypto.scrypt": { argTypes: [BYTES_U8, BYTES_U8, F64, DYN], result: BYTES_U8 },
  "crypto.scryptCb": { argTypes: [BYTES_U8, BYTES_U8, F64, DYN, null], result: VOID },
  // The Buffer statics and the fs/zlib Buffer forms: fixed always-u8
  // signatures (Buffer IS a Uint8Array — one bytes kind).
  /** The Buffer statics with fixed (always-u8) signatures. fromStr is
   * `Buffer.from(string, enc)` — the frontend completes an omitted
   * encoding to "utf8" and fences non-literal/unsupported ones; hex and
   * base64 decode Node-leniently, so it never throws. concat takes ONE
   * bytes<u8>[] arg (the list) and returns a fresh copy. `Buffer.from(u8)`
   * and `Buffer.alloc(n)` need no libFn — they lower to bytesNew. */
  "buffer.fromStr": { argTypes: [STRING, STRING], result: BYTES_U8 },
  "buffer.fromStrChecked": { argTypes: [STRING, STRING], result: BYTES_U8 },
  "buffer.brand": { argTypes: [BYTES_U8], result: BYTES_U8 },
  /** Buffer.from on checked-native strings, bytes, arrays and data-only
   * array-like/Buffer-JSON objects. The encoding is a normalized literal;
   * non-string inputs ignore it. Copies the input and may throw during
   * element coercion or argument validation. Custom object valueOf and
   * opaque reference inputs retain explicit runtime refusals. */
  "buffer.fromDyn": { argTypes: [DYN, STRING], result: BYTES_U8 },
  "buffer.concat": { argTypes: [arrayOf(BYTES_U8)], result: BYTES_U8 },
  /** Buffer.byteLength(string, enc) — enc a NORMALIZED literal like
   * fromStr's — and Buffer.isEncoding(name) over a runtime string
   * (case-insensitive against Node's alias set). Pure; never throw. */
  "buffer.byteLenDyn": { argTypes: [DYN, STRING], result: F64 },
  "buffer.byteLenStr": { argTypes: [STRING, STRING], result: F64 },
  "buffer.isEncoding": { argTypes: [STRING], result: BOOL },
  /** Buffer.concat(list, totalLength): the concatenation truncated or
   * zero-padded to the total. THROWS Node's 'length' RangeError on a
   * negative/non-integer total (may-throw seed). */
  "buffer.concatLen": { argTypes: [arrayOf(BYTES_U8), F64], result: BYTES_U8 },
  // The checked-dynamic compare/equals validators (Node's argument
  // ladders over dyn-boxed invalid-input probes).
  /** The checked-dynamic compare/equals validators (scr_bytes_io.c) —
   * the lowered form when an argument is NOT statically bytes<u8> (the
   * invalid-input probes; a dyn from an untyped JS helper): Node's own
   * argument ladders run at runtime — ERR_INVALID_ARG_TYPE with the
   * API's argument name ("buf1"/"buf2", "otherBuffer", "target"; offsets
   * "of type number"), validateOffset's ERR_OUT_OF_RANGE for bad
   * numbers, undefined offsets taking their Node defaults — and a
   * well-typed value still computes the real answer. All args borrowed
   * dyn; compareChk's four offset slots pass the undefined dyn when
   * syntactically absent. May-throw seeds. */
  "buffer.compareChk": { argTypes: [DYN, DYN], result: F64 },
  "bytes.equalsChk": { argTypes: [BYTES_U8, DYN], result: BOOL },
  "bytes.compareChk": { argTypes: [BYTES_U8, DYN, DYN, DYN, DYN, DYN], result: F64 },
  /** The deprecated `new Buffer(number, 'enc')` string-arm rejection:
   * always throws Node's ERR_INVALID_ARG_TYPE ("The \"string\" argument
   * must be of type string. Received ..."). Borrowed dyn; may-throw. */
  "buffer.newStringFail": { argTypes: [DYN], result: BYTES_U8 },
  /** fs._toUnixTimestamp(time) over a dyn value: numeric strings and
   * finite numbers coerce (negatives answer now/1000, Node's shape);
   * everything else throws Node's ERR_INVALID_ARG_TYPE. May-throw. */
  "fs.toUnixTimestamp": { argTypes: [DYN], result: F64 },
  /** The fs argument-validation ladders (checked-dynamic lane): each Chk
   * replicates its API's Node-order validation over dyn values (Node's
   * exact typed errors — ERR_INVALID_ARG_TYPE/VALUE, ERR_OUT_OF_RANGE),
   * and a full pass meets the trailing compiler-rendered SC2020 fence
   * string — so the ALWAYS-THROW forms take the error.nodeThrow
   * polymorphic-result carve-out. mkdtempSyncChk and the lchmod sync/
   * promise pair run the REAL operation on a validated pass instead
   * (macOS lchmod(2); non-APPLE answers Node's not-a-function /
   * ERR_METHOD_NOT_IMPLEMENTED shapes). May-throw seeds, all of them. */
  "fs.existsChk": { argTypes: [DYN, DYN], result: DYN },
  "fs.mkdtempChk": { argTypes: [DYN, DYN, STRING], result: VOID },
  "fs.mkdtempSyncChk": { argTypes: [DYN, DYN, STRING], result: STRING },
  "fs.readFileChk": { argTypes: [DYN, DYN, DYN, STRING], result: VOID },
  "fs.opendirChk": { argTypes: [DYN, DYN, STRING], result: VOID },
  "fs.watchFileChk": { argTypes: [DYN, DYN, STRING], result: VOID },
  "fs.lchmodChk": { argTypes: [DYN, DYN, DYN, STRING], result: VOID },
  "fs.lchmodSyncChk": { argTypes: [DYN, DYN], result: DYN },
  "fsp.lchmodChk": { argTypes: [DYN, DYN], result: { kind: "promise", inner: VOID } },
  "fs.readChk": { argTypes: [DYN, DYN, DYN, DYN, DYN, STRING], result: VOID },
  "fs.streamOptsChk": { argTypes: [DYN, DYN, STRING], result: VOID },
  /** The compiler-resolved ERR_INVALID_ARG_TYPE throw with a RUNTIME-
   * rendered Received tail: args [argname, "of type ..." clause, the
   * offending dyn value]. ALWAYS THROWS; polymorphic result (the
   * error.nodeThrow pattern). May-throw seed. */
  "error.argTypeThrow": { argTypes: [STRING, STRING, DYN], result: VOID },
  /** The property flavor of argTypeThrow ("The \"options.x\" property
   * must be ..."): the option-bag ladders' provably-invalid arms. ALWAYS
   * THROWS; polymorphic result. May-throw seed. */
  "error.propTypeThrow": { argTypes: [STRING, STRING, DYN], result: VOID },
  /** The checked-dynamic max-listeners ladders: setMaxChk is the
   * instance form over a dyn n (non-numbers ERR_INVALID_ARG_TYPE,
   * negatives/NaN ERR_OUT_OF_RANGE; +1 receiver back — chaining);
   * setDefaultMaxChk is the static/property form, its second argument
   * naming the message slot ("setMaxListeners" for the static call,
   * "defaultMaxListeners" for the module-property assignment). */
  "emitter.setMaxChk": { argTypes: [null, DYN], result: VOID },
  "emitter.setDefaultMaxChk": { argTypes: [DYN, STRING], result: VOID },
  /** The Buffer forms of fs: readFileSync(path) with NO
   * encoding → bytes<u8> (+1), writeFileSync/appendFileSync(path, bytes), and the
   * fs/promises readFile(path) no-encoding form (an already-settled
   * promise, rejecting on failure like the other fsp members). The sync
   * forms THROW catchably on failure exactly like the utf8 forms. */
  "fs.readFileSyncBytes": { argTypes: [STRING], result: BYTES_U8 },
  "fs.writeFileSyncBytes": { argTypes: [STRING, BYTES_U8], result: VOID },
  "fs.appendFileSyncBytes": { argTypes: [STRING, BYTES_U8], result: VOID },
  "fsp.readFileBytes": { argTypes: [STRING], result: { kind: "promise", inner: BYTES_U8 } },
  /** node:zlib (scr_zlib.c — native-toolchain.ts compiles/links it ONLY when these
   * appear on the IR, the regex/libcurl gating precedent): one-shot zlib,
   * raw-DEFLATE, gzip, and auto-detect codecs over u8 bytes with Node's
   * default options, or a validated literal compression level from -1 to 9.
   * Compression never throws (OOM aborts); decompression
   * of corrupt input THROWS Node's error catchably. */
  "zlib.deflateSync": { argTypes: [BYTES_U8], result: BYTES_U8 },
  "zlib.inflateSync": { argTypes: [BYTES_U8], result: BYTES_U8 },
  "zlib.deflateRawSync": { argTypes: [BYTES_U8], result: BYTES_U8 },
  /** bytes, mode (0 zlib / 1 raw / 2 gzip), validated compression level. */
  "zlib.deflateLevelSync": { argTypes: [BYTES_U8, F64, F64], result: BYTES_U8 },
  "zlib.inflateRawSync": { argTypes: [BYTES_U8], result: BYTES_U8 },
  "zlib.gzipSync": { argTypes: [BYTES_U8], result: BYTES_U8 },
  "zlib.gunzipSync": { argTypes: [BYTES_U8], result: BYTES_U8 },
  "zlib.unzipSync": { argTypes: [BYTES_U8], result: BYTES_U8 },
  /** The default-options callback twins run on the executable's shared
   * native work pool and deliver (Error | null, Buffer) on a later loop
   * turn. crc32 validates its optional uint32 seed synchronously. */
  "zlib.deflateCb": { argTypes: [BYTES_U8, null], result: VOID },
  "zlib.inflateCb": { argTypes: [BYTES_U8, null], result: VOID },
  "zlib.deflateRawCb": { argTypes: [BYTES_U8, null], result: VOID },
  "zlib.inflateRawCb": { argTypes: [BYTES_U8, null], result: VOID },
  "zlib.gzipCb": { argTypes: [BYTES_U8, null], result: VOID },
  "zlib.gunzipCb": { argTypes: [BYTES_U8, null], result: VOID },
  "zlib.unzipCb": { argTypes: [BYTES_U8, null], result: VOID },
  "zlib.crc32": { argTypes: [BYTES_U8, F64], result: F64 },
  /** The Buffer overloads of the raw stream writes — same promptly
   * submitted streams as process.stdoutWrite/stderrWrite, constantly true.
   * The encoding arg is evaluated but ignored for bytes, like Node. The Cb
   * forms move their program-shaped completion callback to the tick queue. */
  "process.stdoutWriteBytes": { argTypes: [BYTES_U8, STRING], result: BOOL },
  "process.stderrWriteBytes": { argTypes: [BYTES_U8, STRING], result: BOOL },
  // Completion callback is program-dependent: zero params, checked-dynamic,
  // or an optional Error | null slot (same success shape as fs.rename).
  "process.stdoutWriteBytesCb": { argTypes: [BYTES_U8, STRING, null], result: BOOL },
  "process.stderrWriteBytesCb": { argTypes: [BYTES_U8, STRING, null], result: BOOL },
  "fsp.readFile": { argTypes: [STRING, STRING], result: { kind: "promise", inner: STRING } },
  "fsp.writeFile": { argTypes: [STRING, STRING], result: { kind: "promise", inner: VOID } },
  /** fs.promises.writeFile(path, data, { mode }): the settled-promise
   * twin of fs.writeFileModeSync. */
  "fsp.writeFileMode": {
    argTypes: [STRING, STRING, F64],
    result: { kind: "promise", inner: VOID },
  },
  "fsp.mkdir": { argTypes: [STRING], result: { kind: "promise", inner: VOID } },
  /** The fs/promises option/member tail the certs pipeline uses: mkdir's
   * literal { recursive?, mode? } options (the mkdirSync matrix behind
   * settled promises), unlink, chmod. Failures REJECT (catchable at the
   * await), like the rest of the fsp family. */
  "fsp.mkdirMode": { argTypes: [STRING, F64], result: { kind: "promise", inner: VOID } },
  "fsp.mkdirRecursive": { argTypes: [STRING], result: { kind: "promise", inner: VOID } },
  "fsp.mkdirRecursiveMode": { argTypes: [STRING, F64], result: { kind: "promise", inner: VOID } },
  "fsp.unlink": { argTypes: [STRING], result: { kind: "promise", inner: VOID } },
  "fsp.chmod": { argTypes: [STRING, F64], result: { kind: "promise", inner: VOID } },
  "fsp.link": { argTypes: [DYN, DYN], result: { kind: "promise", inner: VOID } },
  "fsp.symlink": { argTypes: [DYN, DYN, DYN], result: { kind: "promise", inner: VOID } },
  "fsp.readlink": { argTypes: [DYN, DYN], result: { kind: "promise", inner: DYN } },
  "fsp.statfs": { argTypes: [DYN, DYN], result: { kind: "promise", inner: DYN } },
  "fsp.readlinkStr": { argTypes: [DYN, DYN], result: { kind: "promise", inner: STRING } },
  "fsp.readlinkBuffer": { argTypes: [DYN, DYN], result: { kind: "promise", inner: BYTES_U8 } },
  "fsp.utimes": { argTypes: [DYN, DYN, DYN], result: { kind: "promise", inner: VOID } },
  "fsp.lutimes": { argTypes: [DYN, DYN, DYN], result: { kind: "promise", inner: VOID } },
  "fsp.rename": { argTypes: [STRING, STRING], result: { kind: "promise", inner: VOID } },
  "fsp.readdir": { argTypes: [STRING], result: { kind: "promise", inner: arrayOf(STRING) } },
  // Result is promise<call-site Dirent record array>; the libCall case
  // validates the program-dependent record shape in validate.ts.
  /** `fs.promises.readdir(path, { withFileTypes: true })` — the settled-
   * promise twin of fs.readdirTypesSync. The backends assemble the same
   * call-site-shaped Dirent rows, then move the array into a promise;
   * scandir failure becomes its rejection. */
  "fsp.readdirTypes": { argTypes: [STRING], result: { kind: "promise", inner: VOID } },
  "fsp.rm": { argTypes: [STRING], result: { kind: "promise", inner: VOID } },
  "fsp.stat": { argTypes: [STRING], result: { kind: "promise", inner: STATS_T } },
  "fsp.realpath": { argTypes: [STRING], result: { kind: "promise", inner: STRING } },
  "fsp.lstat": { argTypes: [STRING], result: { kind: "promise", inner: STATS_T } },
  /** fs/promises.open and the statically represented FileHandle surface.
   * Every operation returns an already-settled promise; syscall failures
   * become rejections rather than escaping synchronously. read/write
   * results are call-site record shapes ({ bytesRead/bytesWritten,
   * buffer }) assembled by the backends around the fixed runtime ABI. */
  "fsp.open": { argTypes: [STRING, STRING, F64], result: { kind: "promise", inner: FILEHANDLE_T } },
  "fileHandle.fd": { argTypes: [FILEHANDLE_T], result: F64 },
  "fileHandle.close": { argTypes: [FILEHANDLE_T], result: { kind: "promise", inner: VOID } },
  "fileHandle.sync": { argTypes: [FILEHANDLE_T], result: { kind: "promise", inner: VOID } },
  "fileHandle.datasync": { argTypes: [FILEHANDLE_T], result: { kind: "promise", inner: VOID } },
  "fileHandle.truncate": {
    argTypes: [FILEHANDLE_T, F64],
    result: { kind: "promise", inner: VOID },
  },
  "fileHandle.chmod": { argTypes: [FILEHANDLE_T, F64], result: { kind: "promise", inner: VOID } },
  "fileHandle.utimes": {
    argTypes: [FILEHANDLE_T, DYN, DYN],
    result: { kind: "promise", inner: VOID },
  },
  "fileHandle.readv": {
    argTypes: [FILEHANDLE_T, arrayOf(BYTES_U8), F64],
    result: { kind: "promise", inner: VOID },
  },
  "fileHandle.writev": {
    argTypes: [FILEHANDLE_T, arrayOf(BYTES_U8), F64],
    result: { kind: "promise", inner: VOID },
  },
  // read/write carry call-site result record shapes; the validator checks
  // those in validate.ts, so promise<void> is only a table sentinel.
  "fileHandle.read": {
    argTypes: [FILEHANDLE_T, BYTES_U8, F64, F64, F64, BOOL],
    result: { kind: "promise", inner: VOID },
  },
  "fileHandle.writeBytes": {
    argTypes: [FILEHANDLE_T, BYTES_U8, F64, F64, F64, BOOL],
    result: { kind: "promise", inner: VOID },
  },
  "fileHandle.writeStr": {
    argTypes: [FILEHANDLE_T, STRING, F64, STRING],
    result: { kind: "promise", inner: VOID },
  },
  "fileHandle.readFile": {
    argTypes: [FILEHANDLE_T, STRING],
    result: { kind: "promise", inner: STRING },
  },
  "fileHandle.readFileBytes": {
    argTypes: [FILEHANDLE_T, STRING],
    result: { kind: "promise", inner: BYTES_U8 },
  },
  "fileHandle.writeFile": {
    argTypes: [FILEHANDLE_T, STRING, STRING],
    result: { kind: "promise", inner: VOID },
  },
  "fileHandle.writeFileBytes": {
    argTypes: [FILEHANDLE_T, BYTES_U8, STRING],
    result: { kind: "promise", inner: VOID },
  },
  "fileHandle.stat": { argTypes: [FILEHANDLE_T], result: { kind: "promise", inner: STATS_T } },
  "process.argv": { argTypes: [], result: arrayOf(STRING) },
  "process.platform": { argTypes: [], result: STRING },
  // The one libCall whose result type is program-dependent (union ids are
  // per-module): the `result` here is a placeholder — the libCall case
  // checks the union's ARMS ([string, undefinedT] in canonical order)
  // against the module's registry instead.
  /** getenv(3): one string key arg → the interned `string | undefined`
   * union (present: +1 string wrapped into the string arm; absent: the
   * interned undefined-arm instance). BOTH source forms — `process.env.FOO`
   * and `process.env[expr]` — lower here. Purely static; never throws. */
  "process.envGet": { argTypes: [STRING], result: VOID },
  /** setenv(3): (name, value) string args → void. Later envGet reads and
   * spawned children observe the write, like Node (values are strings —
   * the frontend fences non-string RHS). Never throws. */
  "process.envSet": { argTypes: [STRING, STRING], result: VOID },
  /** `delete process.env[NAME]` — unsetenv(3): the mutation is visible to
   * every later read (process.envGet asks getenv fresh) and inherited by
   * spawned children, exactly Node. Statement position only (JS's boolean
   * result is constant true there). Borrows the name; never throws. */
  "process.envUnset": { argTypes: [STRING], result: VOID },
  /** The whole environment as alternating [k0, v0, k1, v1, ...] strings in
   * environ order — the raw material of the process.env SNAPSHOT record
   * (the frontend's interned %env.snapshot helper keyed-writes the pairs
   * into a fresh `{ [k: string]: string | undefined }` record). Fresh +1
   * array; never throws. */
  "process.envPairs": { argTypes: [], result: arrayOf(STRING) },
  "process.exit": { argTypes: [F64], result: VOID },
  /** Numeric process.exitCode write (integer validation, implicit exit status). */
  "process.setExitCode": { argTypes: [F64], result: VOID },
  /** The code for process.exit() with no argument, or zero when unset. */
  "process.currentExitCode": { argTypes: [], result: F64 },
  "process.cwd": { argTypes: [], result: STRING },
  /** getpid(2) / getuid(2): zero args → f64. POSIX-only target, so both
   * always answer (the checker's `getuid?` optionality covers Windows —
   * `process.getuid?.()` lowers as the plain call). Never throw. */
  "process.pid": { argTypes: [], result: F64 },
  "dyn.this": { argTypes: [], result: DYN },
  "dyn.generatorThis": { argTypes: [], result: DYN },
  "process.getuid": { argTypes: [], result: F64 },
  "process.getgid": { argTypes: [], result: F64 },
  /** process.execPath: the compiled binary's own resolved absolute path
   * (one interned string, +1 per read) — the honest answer where Node's
   * is the node executable's (SEMANTICS.md divergence 12). Never throws. */
  "process.execPath": { argTypes: [], result: STRING },
  /** process.arch: the compiled binary's OWN architecture ("arm64",
   * "x64") — Node's answer for its own build on the same machine.
   * Interned; +1 per read. Never throws. */
  "process.arch": { argTypes: [], result: STRING },
  /** Stable native version dictionary. node/openssl identify compatibility
   * targets; components absent from the native runtime are omitted. */
  "process.versions": { argTypes: [], result: DYN },
  "process.builtinId": { argTypes: [DYN, arrayOf(STRING)], result: STRING },
  "process.builtinModule": { argTypes: [STRING, DYN], result: DYN },
  "process.builtinUnsupported": { argTypes: [STRING, STRING], result: DYN },
  "fs.callbackValue": { argTypes: [STRING], result: DYN },
  "fs.callbackCall": { argTypes: [STRING, DYN], result: DYN },
  "process.hrtimeValue": { argTypes: [], result: DYN },
  /** process.versions.node: the runtime's Node COMPATIBILITY TARGET —
   * there is no Node under the binary, so this reports the version whose
   * semantics the runtime implements (SEMANTICS.md divergence 60, the
   * execPath stance). Interned; +1 per read. Never throws. */
  "process.versionsNode": { argTypes: [], result: STRING },
  "process.versionsOpenssl": { argTypes: [], result: STRING },
  /** kill(2) with Node's exact semantics and error shapes: the pid must be
   * an int32 (else the ERR_INVALID_ARG_TYPE TypeError text), the named
   * form resolves Node's signal-name table (unknown names throw the
   * ERR_UNKNOWN_SIGNAL TypeError), an omitted signal completes to
   * "SIGTERM" in the frontend, signal 0 probes, and a kill(2) failure
   * throws Node's `kill ESRCH`/`kill EPERM` Error. Result is Node's
   * constant true. */
  "process.kill": { argTypes: [F64, STRING], result: BOOL },
  "process.killNum": { argTypes: [F64, F64], result: BOOL },
  /** The raw byte writes: one borrowed string arg → bool (constantly true
   * — this synchronous runtime never queues backpressure). stdoutWrite
   * shares console.log's stream, each call is submitted promptly, and
   * interleaved output keeps source order. No newline, no formatting,
   * never throws. */
  "process.stdoutWrite": { argTypes: [STRING], result: BOOL },
  "process.stdio": { argTypes: [F64], result: DYN },
  "process.stderrWrite": { argTypes: [STRING], result: BOOL },
  // error.new's result and the receiver slots are builtin-error classes —
  // program-dependent object types, checked in the libCall case.
  /** The runtime-provided Error hierarchy's entry points (scr_error.c).
   * error.new: one borrowed string arg (the message), result an owned (+1)
   * builtin error instance — the result TYPE names which builtin class
   * (backends derive the runtime kind from it). error.ctor: the
   * super(message) call of an `extends Error` constructor — borrowed
   * receiver (already allocated by the derived class's new) + borrowed
   * message, void; the receiver's type names the builtin class whose name
   * field to stamp. error.toString: borrowed `%Error`-typed receiver, +1
   * string in Node's "name: message" shape. Formatting can invoke a user
   * message accessor, which can throw. */
  "error.new": { argTypes: [STRING], result: VOID },
  /** ECMAScript constructors with raw checked-dynamic message/options.
   * Options retain cause presence; constructor calls borrow their args.
   * Message coercion may throw before the cause is installed. */
  "error.newOptions": { argTypes: [DYN, DYN], result: VOID },
  "error.ctorOptions": { argTypes: [null, DYN, DYN], result: VOID },
  /** Borrowed Error receiver. cause returns an owned dyn value (undefined
   * when absent); hasCause distinguishes absence from present undefined. */
  "error.cause": { argTypes: [null], result: DYN },
  "error.hasCause": { argTypes: [null], result: BOOL },
  /** Assignment borrows both operands and retains the new cause. */
  "error.setCause": { argTypes: [null, DYN], result: VOID },
  "error.defineCause": { argTypes: [null, DYN], result: VOID },
  "error.deleteCause": { argTypes: [null], result: VOID },
  /** The compiler-resolved Node-parity throw for always-throwing lowered
   * arms (ERR_INVALID_THIS receivers, ERR_MISSING_ARGS arity ladders,
   * the symbol-to-string TypeError): args are [error-kind f64 (the
   * SCR_ERR_* index: 0 Error, 1 TypeError, 2 RangeError), code (empty =
   * no code slot), message]. ALWAYS THROWS catchably; the result type is
   * the replaced expression's own (never materialized — the
   * global.undefRead pattern). May-throw seed. */
  "error.nodeThrow": { argTypes: [F64, STRING, STRING], result: VOID },
  /** JS ToString over a dyn value WITH the object protocol (a user
   * toString/valueOf member is CALLED and its throw propagates;
   * exhaustion throws "Cannot convert object to primitive value"; units
   * render "null"/"undefined") — the WHATWG USVString conversions
   * (URLSearchParams names/values). Borrowed dyn; +1 string. May-throw. */
  "dyn.toStringCoerce": { argTypes: [DYN], result: STRING },
  "dyn.stringConstructor": { argTypes: [DYN], result: STRING },
  "dyn.propertyKey": { argTypes: [DYN], result: DYN },
  "dyn.toNumeric": { argTypes: [DYN], result: DYN },
  "dyn.increment": { argTypes: [DYN, BOOL], result: DYN },
  /** JS ToNumber over a dyn value WITH the object protocol (number-hint
   * valueOf/toString ordering; user throws propagate). Borrowed dyn;
   * f64 result, or a throw. Used by statically lowered numeric coercions
   * whose checker type remained any. */
  "dyn.numberConstructor": { argTypes: [DYN], result: F64 },
  "dyn.bigintConstructor": { argTypes: [DYN], result: BIGINT_T },
  "dyn.toNumberCoerce": { argTypes: [DYN], result: F64 },
  "dyn.add": { argTypes: [DYN, DYN], result: DYN },
  "dyn.arithmetic": { argTypes: [DYN, DYN, STRING], result: DYN },
  "dyn.compare": { argTypes: [DYN, DYN, STRING], result: BOOL },
  "dyn.bitwise": { argTypes: [DYN, DYN, STRING], result: DYN },
  "dyn.proxyNew": { argTypes: [DYN, DYN], result: DYN },
  // Always throws; the result is the READ's declared type (a typed dummy
  // the unwind abandons) — the libCall case skips the result check.
  /** A read of a `declare`d const NOTHING defines (the bundler-define
   * pattern — __VERSION__): always throws the catchable ReferenceError
   * Node raises at the access ("<name> is not defined"). args[0] is the
   * name; the result type is the read's declared type (a typed dummy the
   * unwind abandons — the value never exists). */
  "global.undefRead": { argTypes: [STRING], result: VOID },
  "console.native": { argTypes: [], result: DYN },
  /** A native reference to the global object; known names retain value fences. */
  "global.native": { argTypes: [arrayOf(STRING)], result: DYN },
  // `X.name` through a class value: the arg is a program-dependent
  // classval (a null slot; the libCall case checks the kind).
  /** `X.name` through a class VALUE (scr_object.c): args[0] is a borrowed
   * classval; the result is the class object's stored .name string,
   * retained (+1 — the string is an interned immortal, so the retain is a
   * no-op, kept for ownership uniformity). Never throws. A direct
   * `C.name` on the class name itself folds to a strLit instead. */
  "class.name": { argTypes: [null], result: STRING },
  "error.ctor": { argTypes: [null, STRING], result: VOID },
  "error.toString": { argTypes: [null], result: STRING },
  /** SameValue over checked values, including NaN, signed zero and reference identity. */
  "dyn.sameValue": { argTypes: [DYN, DYN], result: BOOL },
  "error.stack": { argTypes: [null], result: STRING },
  "error.stackLimitGet": { argTypes: [], result: F64 },
  "error.stackLimitSet": { argTypes: [F64], result: VOID },
  // Receiver (any error-hierarchy object) and the program-dependent
  // `string | undefined` result are checked in the libCall case.
  /** NodeJS.ErrnoException's `.code` read: borrowed error-hierarchy
   * receiver → the interned `string | undefined` union (type-directed
   * construction in the backend, the process.envGet pattern) — the errno
   * name where a throw site stamped one (fs, exec spawn/timeout,
   * process.kill, the spawn 'error' event), the undefined arm everywhere
   * else. Never throws. */
  "error.code": { argTypes: [null], result: VOID },
  // DOMException: construction takes the two dyn args (WebIDL's
  // resolution runs in the runtime); the %DOMException result is a
  // program-dependent object type, checked in the libCall case. The
  // read surface takes the %DOMException receiver (a null slot — the
  // libCall case checks the class name).
  /** `new DOMException(message?, nameOrOptions?)` (scr_error.c): both args
   * are borrowed dyn values (the lowering passes the dyn undefined for an
   * absent argument, so WebIDL's optionality lives in one place). The
   * runtime ToStrings the message ("" for absent/undefined), resolves the
   * name — absent/undefined → "Error", a non-null object → ToString of its
   * `name` member plus the `cause` own-property record, anything else →
   * ToString — and stamps the legacy code from the WebIDL name table (0
   * off-table). Result is an owned (+1) %DOMException. Never throws (dyn
   * ToString is total). */
  "error.newDom": { argTypes: [DYN, DYN], result: VOID },
  /** DOMException's own read surface (scr_error.c; %DOMException receivers
   * only — borrowed). domCode: the legacy numeric code. domHasCause: the
   * options form's own-property record (`'cause' in e`). domCause: the
   * cause value, +1 (the dyn undefined when absent — matching Node's
   * undefined read). None throws. */
  "error.domCode": { argTypes: [null], result: F64 },
  "error.domHasCause": { argTypes: [null], result: BOOL },
  "error.domCause": { argTypes: [null], result: DYN },
  /** structuredClone of a %DOMException receiver (scr_error.c): WebIDL
   * serialization — name/message copy, the legacy code re-derives, cause
   * does not serialize. args are the borrowed receiver and the borrowed
   * options dyn value (the dyn undefined when absent — the shared
   * validation throws Node's exact option errors; any non-empty transfer
   * list throws DataCloneError, nothing static is transferable). Result
   * +1 %DOMException. */
  "error.domClone": { argTypes: [null, DYN], result: VOID },
  /** `d instanceof TypeError` (and the other BUILTIN error classes) on a
   * checked-dynamic value (scr_json.c): the from_error cache holds the
   * dyn↔error identity edge, so the test resolves the runtime error and
   * asks its vtable's stamped preorder interval — exact for every error
   * that crossed the boundary. A dyn object that never came from an
   * error (a hand-built {%error} literal) answers false: subclass
   * identity is unknowable there (the root keeps dynTest's marker
   * answer). args are the borrowed dyn and the SCR_ERR_* kind literal.
   * Never throws. */
  "dyn.errInstanceof": { argTypes: [DYN, F64], result: BOOL },
  "weakMap.is": { argTypes: [DYN], result: BOOL },
  "weakSet.is": { argTypes: [DYN], result: BOOL },
  "weakMap.new": { argTypes: [DYN], result: DYN },
  "weakSet.new": { argTypes: [DYN], result: DYN },
  "dyn.fromEntries": { argTypes: [DYN], result: DYN },
  "bytes.constructor": { argTypes: [STRING], result: DYN },
  "bytes.instanceOf": { argTypes: [DYN, DYN], result: BOOL },
  "bytes.construct": { argTypes: [DYN, DYN, STRING], result: DYN },
  /** The ambient receiver — JS `this` in a plain (non-method) function
   * body: the innermost binding the current firing/dispatch window
   * pushed (Node's listener receiver, a dyn OBJ method's object, an
   * apply/call thisArg), or the undefined dyn singleton with none bound
   * (the strict-mode plain-call answer, the old constant). Zero args →
   * dyn (+1). Never throws. */
  "dyn.dataViewIs": { argTypes: [DYN], result: BOOL },
  "dyn.construct": { argTypes: [DYN, DYN, STRING], result: DYN },
  "arrayBuffer.constructor": { argTypes: [], result: DYN },
  "sharedArrayBuffer.new": { argTypes: [DYN], result: DYN },
  "sharedArrayBuffer.is": { argTypes: [DYN], result: BOOL },
  "arrayBuffer.new": { argTypes: [DYN], result: DYN },
  "ffi.argument": { argTypes: [DYN, STRING], result: DYN },
  "ffi.memoryModule": { argTypes: [DYN], result: DYN },
  "intl.segmenterNew": { argTypes: [], result: DYN },
  "arrayBuffer.is": { argTypes: [DYN], result: BOOL },
  "arrayBuffer.isView": { argTypes: [DYN], result: BOOL },
  "arrayBuffer.byteLengthGetter": { argTypes: [], result: F64 },
  "arrayBuffer.byteLengthDescriptor": { argTypes: [DYN], result: DYN },
  "arrayBuffer.viewU8C": { argTypes: [DYN, DYN, DYN], result: bytesOf("u8c") },
  "arrayBuffer.viewI8": { argTypes: [DYN, DYN, DYN], result: bytesOf("i8") },
  "arrayBuffer.viewU16": { argTypes: [DYN, DYN, DYN], result: bytesOf("u16") },
  "arrayBuffer.viewI16": { argTypes: [DYN, DYN, DYN], result: bytesOf("i16") },
  "arrayBuffer.viewU8": { argTypes: [DYN, DYN, DYN], result: BYTES_U8 },
  "arrayBuffer.viewU32": { argTypes: [DYN, DYN, DYN], result: bytesOf("u32") },
  "arrayBuffer.viewI32": { argTypes: [DYN, DYN, DYN], result: bytesOf("i32") },
  "arrayBuffer.viewF32": { argTypes: [DYN, DYN, DYN], result: bytesOf("f32") },
  "arrayBuffer.viewF64": { argTypes: [DYN, DYN, DYN], result: bytesOf("f64") },
  "arrayBuffer.viewDV": { argTypes: [DYN, DYN, DYN], result: BYTES_U8 },
  /** Object.keys/values/entries over a CHECKED-DYNAMIC receiver
   * (scr_json.c): the runtime walks the dyn node's own members in JS
   * own-key order (array-index keys ascending first, then insertion
   * order) and answers a dyn array (entries: an array of [key, value]
   * pairs; values RETAIN the member nodes — reference semantics, like
   * JS). Strings/arrays/bytes answer their index keys; other scalars an
   * empty array; null/undefined throw Node's catchable TypeError
   * ("Cannot convert undefined or null to object"). */
  "dyn.objKeys": { argTypes: [DYN], result: DYN },
  "dyn.forInKeys": { argTypes: [DYN], result: DYN },
  "dyn.hasOwn": { argTypes: [DYN, STRING], result: BOOL },
  "dyn.propertyIsEnumerable": { argTypes: [DYN, STRING], result: BOOL },
  "dyn.assign": { argTypes: [DYN, DYN], result: DYN },
  "dyn.copyDataProperties": { argTypes: [DYN, DYN], result: DYN },
  "dyn.objectRest": { argTypes: [DYN, DYN], result: DYN },
  /** Variadic Object.assign over CHECKED-DYNAMIC targets (`Object.assign(
   * {}, ...arr.map(f), tail)` — the option-table merge): the lowering
   * builds one fresh dyn pack of sources (packPush retains a plain source
   * in; packPushSpread flattens a spread source through the spread-call
   * walk — V8's exact TypeError texts, the string arg spelling the spread
   * expression for the nullish form), so every source evaluates and
   * flattens BEFORE any copying (JS's ArgumentListEvaluation), then
   * assignAll copies each pack element's own enumerable keys onto the
   * target left to right and answers the TARGET (+1) — identity, like JS.
   * assignAll throws Node's ToObject TypeError on a nullish target. */
  "dyn.packPush": { argTypes: [DYN, DYN], result: VOID },
  "dyn.packPushSpread": { argTypes: [DYN, DYN, STRING], result: VOID },
  /** The iterated-path spread twin: V8 spells the optimized apply-path
   * texts (packPushSpread's — the expression named for nullish sources)
   * only for the SINGLE LAST argument's spread; any other spread position
   * drives the real iterator protocol, whose failure describes the VALUE
   * ("object null is not iterable (cannot read property
   * Symbol(Symbol.iterator))"). The frontend picks by position. */
  "dyn.packPushSpreadIter": { argTypes: [DYN, DYN], result: VOID },
  "dyn.reflectApply": { argTypes: [DYN, DYN, DYN], result: DYN },
  "dyn.reflectGet": { argTypes: [DYN, DYN, DYN], result: DYN },
  "dyn.reflectSet": { argTypes: [DYN, DYN, DYN, DYN], result: BOOL },
  "dyn.reflectDefine": { argTypes: [DYN, DYN, DYN], result: BOOL },
  "dyn.abstractEq": { argTypes: [DYN, DYN], result: BOOL },
  "dyn.assignAll": { argTypes: [DYN, DYN], result: DYN },
  /** `Object.create(null)` (scr_json.c): a fresh NULL-PROTOTYPE dyn
   * dictionary. The checked-dynamic tree's OBJ dispatch is already own-member-only —
   * Node's null-proto answer — so the flag's whole job is the observations
   * that SEE the prototype: inspect's "[Object: null prototype]" prefix
   * and deepStrictEqual's prototype gate. Never throws. Static builds
   * only; --dynamic routes Object.create through the engine instead. */
  "dyn.objCreateNullProto": { argTypes: [], result: DYN },
  "dyn.arrayPrototype": { argTypes: [], result: DYN },
  "dyn.arrayConstructor": { argTypes: [], result: DYN },
  "dyn.objectPrototype": { argTypes: [], result: DYN },
  "dyn.functionApply": { argTypes: [], result: DYN },
  "dyn.builtinMethod": { argTypes: [STRING, STRING], result: DYN },
  "dyn.classPrototype": { argTypes: [DYN, DYN], result: DYN },
  "dyn.classBasePrototype": { argTypes: [DYN], result: DYN },
  "dyn.classInherit": { argTypes: [DYN, DYN], result: DYN },
  "dyn.classSuper": { argTypes: [DYN, DYN, DYN], result: VOID },
  "dyn.assignPrototype": { argTypes: [DYN, DYN, DYN], result: DYN },
  "dyn.definePrototypeProps": { argTypes: [DYN, DYN, DYN], result: DYN },
  "dyn.bagGet": { argTypes: [DYN, STRING, DYN], result: DYN },
  "dyn.bagSet": { argTypes: [DYN, STRING, DYN, DYN], result: VOID },
  "dyn.objCreate": { argTypes: [DYN], result: DYN },
  "dyn.objCreateWithProperties": { argTypes: [DYN, DYN], result: DYN },
  "dyn.getPrototype": { argTypes: [DYN], result: DYN },
  "dyn.setPrototype": { argTypes: [DYN, DYN], result: DYN },
  "dyn.getOwnPropertyNames": { argTypes: [DYN], result: DYN },
  "dyn.ownKeys": { argTypes: [DYN], result: DYN },
  "dyn.getOwnPropertySymbols": { argTypes: [DYN], result: DYN },
  "dyn.getOwnPropertyDescriptors": { argTypes: [DYN], result: DYN },
  "dyn.preventExtensions": { argTypes: [DYN], result: DYN },
  "dyn.isExtensible": { argTypes: [DYN], result: BOOL },
  "dyn.seal": { argTypes: [DYN], result: DYN },
  "dyn.isSealed": { argTypes: [DYN], result: BOOL },
  "dyn.objValues": { argTypes: [DYN], result: DYN },
  "dyn.objEntries": { argTypes: [DYN], result: DYN },
  /** structuredClone over the checked-dynamic tree (scr_json.c): the JSON-safe subset plus
   * bytes (a fresh copy — a Buffer clones as a plain Uint8Array, like
   * Node), deep. Functions and handle kinds throw the spec's catchable
   * DataCloneError; CYCLES throw the scriptc fence (the checked-dynamic tree cannot
   * represent them — Node clones cycles; documented divergence). The
   * options dyn value validates with Node's exact errors (dictionary
   * conversion, the transfer-sequence member; any non-empty transfer
   * list throws DataCloneError). dyn.cloneMissing is the zero-argument
   * call: always throws Node's TypeError [ERR_MISSING_ARGS] with Node's
   * own (verbatim, doubly-wrapped) message. */
  "dyn.structuredClone": { argTypes: [DYN, DYN], result: DYN },
  "dyn.cloneMissing": { argTypes: [], result: DYN },
  /** structuredClone with a NON-EMPTY transfer array of static values:
   * nothing static is transferable, so the call always throws Node's
   * catchable DataCloneError ("Found invalid value in transferList.") —
   * lowered directly (the list's values need no dyn representation to
   * fail). */
  "dyn.cloneTransferFail": { argTypes: [], result: DYN },
  /** `new RegExp(pattern, flags?)` (scr_regex.c): a heap regex over the
   * same libregexp engine the literals use. The pattern compiles EAGERLY
   * so an invalid pattern (or an unknown flag letter) throws Node's
   * catchable SyntaxError at construction — Node's message shape with
   * libregexp's detail text (approximate fidelity; e.name exact). An
   * empty pattern stores the spec's "(?:)" source. Both args borrowed
   * strings (the lowering completes an absent flags to ""); result +1.
   * The result TYPE is the regex kind, so the link switch pulls the
   * engine exactly like a literal. */
  "regex.new": { argTypes: [STRING, STRING], result: REGEX },
  "regex.resetLastIndex": { argTypes: [REGEX, F64], result: VOID },
  "regex.newChecked": { argTypes: [DYN, DYN], result: REGEX },
  "regex.replaceCallback": { argTypes: [STRING, REGEX, DYN, BOOL], result: STRING },
  // node:events EventEmitter: receivers are emitter-hierarchy objects and
  // the chaining forms (on/off/removeAll/setMax) return the receiver's
  // own class — program-dependent object types, checked in the libCall
  // case. emitter.emit is the one VARIADIC libCall: args beyond
  // (recv, name) are the event's frontend-unified tuple, any borrowable
  // kind — the count check admits a longer list for it alone.
  /** node:events EventEmitter (scr_events_emitter.c, link-gated by
   * moduleUsesEmitter). The receiver of every instance form is a borrowed
   * emitter-hierarchy object (`%EventEmitter` or a user subclass — the
   * backend reinterprets to ScrEmitter*, the identical prefix); event
   * names are borrowed strings (compile-time literals — the frontend
   * fences non-literals and unifies each event's argument tuple program-
   * wide). The chaining forms (on/off/removeAll/setMax) return the
   * receiver +1 typed as its static class, Node's `return this`.
   *
   * emitter.new: `new EventEmitter()` → a +1 bare emitter. emitter.ctor:
   * super() into the prefix of an emitted subclass (borrowed receiver,
   * void — allocation already initialized the prefix). emitter.on:
   * (recv, name, cb /moves/, once, prepend) — the backend synthesizes the
   * per-signature va_list invoke adapter from the cb's func type.
   * emitter.emit: (recv, name, ...tuple) — VARIADIC, the one libCall
   * whose arg count exceeds its signature; args are borrowed, result is
   * the had-listeners bool. emitter.emitError: emit('error', err) —
   * throws err when unhandled. count/countFn/names/listeners/getMax/
   * setMax/setDefaultMax/getDefaultMax are the introspection surface. */
  "emitter.new": { argTypes: [], result: VOID },
  "emitter.ctor": { argTypes: [null], result: VOID },
  "emitter.on": { argTypes: [null, STRING, null, BOOL, BOOL], result: VOID },
  "emitter.off": { argTypes: [null, STRING, null], result: VOID },
  // The dyn-adapted registration family (JS-lane checked-dynamic
  // listeners): checkListener has NO receiver (it validates the listener
  // argument alone); onDyn carries (recv, name, cb dyn, adapter func,
  // once, prepend), offDyn (recv, name, cb dyn).
  "emitter.checkListener": { argTypes: [DYN], result: VOID },
  "emitter.onDyn": { argTypes: [null, STRING, DYN, null, BOOL, BOOL], result: VOID },
  "emitter.onFlex": { argTypes: [null, STRING, DYN, BOOL, BOOL], result: VOID },
  "emitter.offDyn": { argTypes: [null, STRING, DYN], result: VOID },
  "emitter.removeAll": { argTypes: [null, STRING, BOOL], result: VOID },
  "emitter.emit": { argTypes: [null, STRING], result: BOOL },
  "emitter.emitFlex": { argTypes: [null, STRING], result: BOOL },
  "emitter.emitError": { argTypes: [null, STRING, null], result: BOOL },
  "emitter.count": { argTypes: [null, STRING], result: F64 },
  "emitter.countFn": { argTypes: [null, STRING, null], result: F64 },
  "emitter.countDyn": { argTypes: [null, STRING, DYN], result: F64 },
  "emitter.names": { argTypes: [null], result: VOID },
  "emitter.listeners": { argTypes: [null, STRING], result: VOID },
  /** Stream-'data' registration twins of emitter.on/onDyn (same args):
   * chosen at registration sites whose receiver is stream-rooted, so the
   * backend emits DATA thunks — the runtime's 'data' emission carries
   * BOTH payload slots (bytes, string; exactly one non-NULL — encoded
   * streams deliver strings), and the thunk unwraps the listener's
   * declared side (typed) or boxes by tag (dyn). emitter.emitData is the
   * user-emit form: (recv, name, chunk) with a bytes OR string chunk. */
  "emitter.onData": { argTypes: [null, STRING, null, BOOL, BOOL], result: VOID },
  "emitter.onDataDyn": { argTypes: [null, STRING, DYN, null, BOOL, BOOL], result: VOID },
  "emitter.emitData": { argTypes: [null, STRING, null], result: BOOL },
  "emitter.setMax": { argTypes: [null, F64], result: VOID },
  "emitter.getMax": { argTypes: [null], result: F64 },
  "emitter.setDefaultMax": { argTypes: [F64], result: VOID },
  "emitter.getDefaultMax": { argTypes: [], result: F64 },
  // node:stream: receivers are stream-hierarchy objects and several
  // results are program-dependent (the receiver's class, unions) — the
  // libCall case owns those checks. The constructors and a few methods
  // are VARIADIC (trailing option callbacks / the optional chunk+cb tail):
  // argTypes here is the fixed prefix, VARIADIC_LIB_FNS admits the rest.
  /** node:stream (scr_stream.c, link-gated by moduleUsesStream — which
   * implies the emitter unit: stream events dispatch through the embedded
   * ScrEmitter registry). Receivers are borrowed stream-class objects
   * (`%Readable`/`%Writable`/`%Duplex`/`%Transform`/`%PassThrough` — one
   * runtime layout, reinterpreted by side).
   *
   * Constructors (`readable.new` et al): args are [hwmR, hwmW, flags]
   * followed by the PRESENT user callbacks in canonical order (read,
   * write, final, destroy, transform, flush — the flags f64 is a bitmask
   * naming which follow; absent ones emit NULL). Every callback closure
   * MOVES and carries a leading `this` param (the stream), invoked
   * through compiler-emitted adapters. Results are +1.
   *
   * readable.push / readable.pushStr / readable.pushNull: Node's push —
   * buffers or delivers (bytes chunk borrowed; string converted utf8);
   * returns the below-hwm answer. readable.read: (recv, size — -1 for
   * absent) → Buffer|null union. pause/resume return recv +1 (`this`);
   * isPaused answers the flag. readable.pipe: (recv, dst, end) → dst +1,
   * fires 'pipe' on dst; readable.unpipe (recv[, dst]) → recv +1.
   * writable.write/writeStr: (recv, chunk[, cb]) → below-hwm bool (cb
   * MOVES when present, called after the user write completes).
   * writable.end: (recv, flags[, chunk][, cb]) → recv +1. cork/uncork are
   * void. stream.destroy/destroyErr: (recv[, err]) → recv +1.
   * stream.prop: (recv, name-literal) → the flag/number the name asks
   * for; stream.errored → Error|null union; readable.flowing →
   * bool|null union. All may leave a listener's exception pending
   * (dispatch runs user code synchronously, like emit). */
  "readable.new": { argTypes: [F64, BOOL, BOOL, F64], result: VOID },
  "writable.new": { argTypes: [F64, BOOL, BOOL, F64], result: VOID },
  "duplex.new": { argTypes: [F64, F64, BOOL, BOOL, BOOL, BOOL, BOOL, F64], result: VOID },
  "transform.new": { argTypes: [F64, F64, BOOL, BOOL, BOOL, BOOL, BOOL, F64], result: VOID },
  "passthrough.new": { argTypes: [F64, F64, BOOL, BOOL, BOOL, BOOL, BOOL, F64], result: VOID },
  // The subclass-initialization twins: the borrowed receiver leads, then
  // the .new tail (variadic callbacks likewise).
  // The dyn-options twins: newDyn takes the record, initDyn the borrowed
  // receiver + record + fallback flags (trailing wrapper closures ride
  // the variadic tail like the static forms).
  /** The underscore-method assignment surface (`r._read = fn` after
   * construction — Node's own-property shadow of the prototype method):
   * args [stream receiver (borrowed), callback closure (+1 moves)]. The
   * runtime slot the matching option callback fills swaps its closure
   * and invoke thunk; the next dispatch uses it (Node's timing). The
   * setters themselves never throw. */
  "stream.setRead": { argTypes: [null, null], result: VOID },
  "stream.setWrite": { argTypes: [null, null], result: VOID },
  "stream.setFinal": { argTypes: [null, null], result: VOID },
  "stream.setDestroy": { argTypes: [null, null], result: VOID },
  "stream.setTransform": { argTypes: [null, null], result: VOID },
  "stream.setFlush": { argTypes: [null, null], result: VOID },
  /** The dyn-options twins (a checked-dynamic options record — the JS
   * lane's `super(options)` forwarding and `new Readable(dynVar)`): the
   * option walk runs at RUNTIME with Node's reading rules. newDyn:
   * (optsDyn) → the fresh stream; initDyn: (recv, optsDyn, flags,
   * ...fallback wrapper closures in canonical order — the flags literal
   * names which ride, exactly the .init callback ABI). MAY THROW (a
   * consumed-but-unlowered option is the compile fence's runtime twin). */
  /** stream.finished(s, cb) — the callback form: the watcher fires once
   * at the terminal point with the finish status; the result is the +1
   * cleanup closure. stream.pipeline(count, s1..sn, cb): chains pipes,
   * propagates the first error by destroying the rest, calls cb after the
   * last 'close'; answers the destination +1. The Dyn twins take the
   * callback as a checked-dynamic VALUE (mustCall wrappers). */
  "stream.finished": { argTypes: [null, null], result: VOID },
  "stream.finishedDyn": { argTypes: [null, DYN], result: VOID },
  "stream.pipeline": { argTypes: [F64], result: VOID },
  "stream.pipelineDyn": { argTypes: [F64], result: VOID },
  /** node:stream/promises — the promise forms over the same machinery:
   * sp.finished: (s) → a pending void promise the terminal watcher
   * settles; sp.pipeline: (count, s1..sn) → the callback pipeline's
   * chaining/destroyer semantics settling a void promise (fulfilled on a
   * clean finish, rejected with the finish status otherwise). */
  "sp.finished": { argTypes: [null], result: { kind: "promise", inner: VOID } },
  "sp.pipeline": { argTypes: [F64], result: { kind: "promise", inner: VOID } },
  /** node:stream/consumers — the promise consumers over the readable
   * machinery: (s) → a pending promise settled at the terminal point
   * with the accumulated result (sc.text: the utf8 decode, sc.json: the
   * parsed dyn — malformed input rejects with the parse's SyntaxError,
   * sc.buffer: the concatenated bytes) or rejected with the stream's
   * error / ERR_STREAM_PREMATURE_CLOSE. */
  "sc.text": { argTypes: [null], result: { kind: "promise", inner: STRING } },
  "sc.json": { argTypes: [null], result: { kind: "promise", inner: DYN } },
  "sc.buffer": { argTypes: [null], result: { kind: "promise", inner: BYTES_U8 } },
  "readable.newDyn": { argTypes: [DYN], result: VOID },
  "writable.newDyn": { argTypes: [DYN], result: VOID },
  "duplex.newDyn": { argTypes: [DYN], result: VOID },
  "transform.newDyn": { argTypes: [DYN], result: VOID },
  "passthrough.newDyn": { argTypes: [DYN], result: VOID },
  "readable.initDyn": { argTypes: [null, DYN, F64], result: VOID },
  "writable.initDyn": { argTypes: [null, DYN, F64], result: VOID },
  "duplex.initDyn": { argTypes: [null, DYN, F64], result: VOID },
  "transform.initDyn": { argTypes: [null, DYN, F64], result: VOID },
  "passthrough.initDyn": { argTypes: [null, DYN, F64], result: VOID },
  /** Subclass initialization (`super(options?)` in a user `extends
   * Readable` constructor): same tail as the `.new` forms, prefixed with
   * the BORROWED receiver (the emitted subclass allocation — vtable and
   * display name stamped, state NULL until here). Overridden underscore
   * methods arrive as synthesized wrapper closures dispatching through
   * the vtable. Void result. */
  "readable.init": { argTypes: [null, F64, BOOL, BOOL, F64], result: VOID },
  "writable.init": { argTypes: [null, F64, BOOL, BOOL, F64], result: VOID },
  "duplex.init": { argTypes: [null, F64, F64, BOOL, BOOL, BOOL, BOOL, BOOL, F64], result: VOID },
  "transform.init": { argTypes: [null, F64, F64, BOOL, BOOL, BOOL, BOOL, BOOL, F64], result: VOID },
  "passthrough.init": {
    argTypes: [null, F64, F64, BOOL, BOOL, BOOL, BOOL, BOOL, F64],
    result: VOID,
  },
  "readable.push": { argTypes: [null, BYTES_U8], result: BOOL },
  "readable.pushStr": { argTypes: [null, STRING], result: BOOL },
  "readable.pushNull": { argTypes: [null], result: BOOL },
  "readable.pushU": { argTypes: [null, null], result: BOOL },
  "readable.pushDyn": { argTypes: [null, DYN], result: BOOL },
  "readable.unshift": { argTypes: [null, BYTES_U8], result: VOID },
  "readable.unshiftStr": { argTypes: [null, STRING], result: VOID },
  "stream.onDyn": { argTypes: [null, STRING, DYN, BOOL, BOOL], result: VOID },
  "readable.readDyn": { argTypes: [null, DYN], result: DYN },
  "readable.read": { argTypes: [null, F64], result: VOID },
  "readable.pause": { argTypes: [null], result: VOID },
  "readable.setEncoding": { argTypes: [null, STRING], result: VOID },
  /** push(chunk, enc) with a literal non-utf8 encoding, and the
   * defaultEncoding option's push side (how push(string) decodes —
   * Buffer.from(chunk, enc)); both carry the CANONICAL literal. */
  "readable.pushStrEnc": { argTypes: [null, STRING, STRING], result: BOOL },
  "readable.pushEncoding": { argTypes: [null, STRING], result: VOID },
  /** for-await over a readable (the desugared loop's per-pass promise):
   * +1 promise of the next chunk — buffered content, the EOF sentinel
   * (empty Buffer / dyn undefined), or a rejection with the stream's
   * error. The Dyn twin boxes chunks by runtime tag (the JS lane).
   * readable.fromArr is Readable.from(array): a fully-seeded object-
   * entry stream (one whole chunk per element; strings per the flag). */
  "readable.nextChunk": { argTypes: [null], result: VOID },
  "readable.nextChunkDyn": { argTypes: [null], result: VOID },
  "readable.fromArr": { argTypes: [null, BOOL], result: VOID },
  "readable.resume": { argTypes: [null], result: VOID },
  "readable.isPaused": { argTypes: [null], result: BOOL },
  "readable.pipe": { argTypes: [null, null, BOOL], result: VOID },
  "readable.unpipe": { argTypes: [null], result: VOID },
  "readable.flowing": { argTypes: [null], result: VOID },
  "writable.write": { argTypes: [null, BYTES_U8], result: BOOL },
  "writable.writeStr": { argTypes: [null, STRING], result: BOOL },
  "writable.writeU": { argTypes: [null, null], result: BOOL },
  "writable.writeDyn": { argTypes: [null, DYN], result: BOOL },
  "writable.end": { argTypes: [null, F64], result: VOID },
  "writable.cork": { argTypes: [null], result: VOID },
  "writable.uncork": { argTypes: [null], result: VOID },
  "stream.destroy": { argTypes: [null], result: VOID },
  "stream.destroyErr": { argTypes: [null, null], result: VOID },
  /** AsyncIteratorClose for Readable[Symbol.asyncIterator](): destroy with
   * Node's AbortError/ABORT_ERR payload while the iterator's internal error
   * consumer prevents an unhandled-error crash. */
  "stream.iteratorClose": { argTypes: [null], result: VOID },
  "stream.prop": { argTypes: [null, STRING], result: VOID },
  "stream.errored": { argTypes: [null], result: VOID },
  // node:assert: pass/negated/deep/hasMsg are frontend-computed bools; the
  // message slot always carries a string ("" when hasMsg is false).
  /** node:assert (scr_assert.c; assert.match in scr_regex.c — every call
   * site carries a regex value, so the regex link switch is already on).
   * Failures throw a catchable AssertionError — a runtime %Error whose
   * name is "AssertionError" and whose code slot is "ERR_ASSERTION" — so
   * `instanceof Error`, `.name`, `.message`, and `.code` all answer like
   * Node's. Generated messages are Node's assertion_error.js scalar forms
   * byte-exactly (the short `a !== b` form, the stacked `+ actual
   * - expected` diff with the string `^` indicator, the inline-vs-block
   * not-equal split); composite deep failures carry the header line
   * without the rendered inspect diff (documented divergence).
   *
   * assert.ok: (pass, message) — the frontend computed the truthiness AND
   * the full message (the user's, or the compile-time source-text form —
   * assert.fail lowers here too with pass=false). assert.eqF64/eqBigInt/
   * eqStr/eqBool: (a, b, negated, deep, msg, hasMsg) — Object.is comparison,
   * covering strictEqual/notStrictEqual and the scalar deepStrictEqual
   * pair; msg is a typed dummy ("" literal) when hasMsg is false (Node
   * distinguishes an omitted message from an empty one per operator).
   * assert.deepResult: (equal, negated, msg, hasMsg) — the verdict of a
   * frontend-synthesized structural comparison, turned into Node's throw.
   * assert.sameValue: Object.is over doubles (the deep-equal helpers'
   * number leaf; never throws). assert.match: (s, regex, negated, msg,
   * hasMsg) — a fresh exec from index 0. assert.throwsNone: (rejection,
   * ename, hasEname, msg, hasMsg) — the "Missing expected
   * exception|rejection" throw of assert.throws/rejects whose callback
   * returned (fulfilled) normally, with Node's ` (${expected.name})`
   * detail when the expected class or shape carries a name.
   * assert.throwsMismatch: (expectedName, error) — the wrong-class throw
   * of the assert.throws(fn, ErrorClass) form. assert.eqSym:
   * (a, b, negated, deep, msg, hasMsg) — strict equality over symbol
   * values, pointer identity with v24's "Symbol(desc)" stacked-diff
   * messages (scr_symbol.c, the assert.match pattern — symbol-typed
   * slots already flip the symbol link switch). assert.eqDyn:
   * (a, b, negated, deep, msg, hasMsg) — the whole quartet over
   * checked-dynamic operands (both slots dyn; the frontend boxes a
   * static side with dynFrom first): SameValue for the strict pair over
   * the dyn kinds (boxed-closure identity for functions), the structural
   * dyn walk for the deep pair, with assertion_error.js's messages —
   * scalar forms byte-exact, composites rendered compact:false/sorted
   * through the checked-dynamic tree and diffed with the real myers line printer.
   *
   * The assert.throws(fn, {name/code/message}) shape check
   * (expectedException over the static error surface): shapeBegin
   * stashes the caught error, shapeStr/shapeRe add one expected key each
   * (key ids 0 code / 1 message / 2 name; shapeRe lives in scr_regex.c —
   * its regex argument flips the regex link switch — and tests eagerly
   * so scr_assert.c stays libregexp-free), then shapeEnd throws Node's
   * deep-equal Comparison diff BYTE-EXACTLY (the bounded key set makes
   * the rendering enumerable) or the custom message.
   * assert.throwsRegex: (regex, error, msg, hasMsg) — the
   * assert.throws(fn, /re/) check over String(error), Node's
   * regex-mismatch message. assert.regexErrTest: doesNotReject's silent
   * regex predicate over String(error) (never throws).
   * assert.unwantedRejection: (error, msg, hasMsg) — doesNotReject's
   * "Got unwanted rejection" throw.
   * assert.ifErrorErr/F64/Str/Bool: assert.ifError's per-type throws
   * ("ifError got unwanted exception: " + the error's message/name or
   * the value's inspection) — the frontend routes null/undefined to a
   * no-op and everything else here (Node throws for falsy values too).
   * All arguments are borrowed. */
  "assert.ok": { argTypes: [BOOL, STRING], result: VOID },
  "assert.eqF64": { argTypes: [F64, F64, BOOL, BOOL, STRING, BOOL], result: VOID },
  "assert.eqBigInt": { argTypes: [BIGINT_T, BIGINT_T, BOOL, BOOL, STRING, BOOL], result: VOID },
  "assert.eqStr": { argTypes: [STRING, STRING, BOOL, BOOL, STRING, BOOL], result: VOID },
  "assert.eqBool": { argTypes: [BOOL, BOOL, BOOL, BOOL, STRING, BOOL], result: VOID },
  "assert.deepResult": { argTypes: [BOOL, BOOL, STRING, BOOL], result: VOID },
  "assert.sameValue": { argTypes: [F64, F64], result: BOOL },
  // The deep-equality pair memo: both slots are program-dependent
  // (any cycle-capable record/array/map type).
  /* deepStrictEqual's pair memo over cycle-capable types: enter answers
   * true for a pair already being compared (Node's memo — equal cyclic
   * structures compare true); leave pops. */
  "assert.deqEnter": { argTypes: [null, null], result: BOOL },
  "assert.deqLeave": { argTypes: [], result: VOID },
  "assert.match": { argTypes: [STRING, REGEX, BOOL, STRING, BOOL], result: VOID },
  "assert.throwsNone": { argTypes: [BOOL, STRING, BOOL, STRING, BOOL], result: VOID },
  "assert.throwsMismatch": {
    argTypes: [STRING, { kind: "object", className: "%Error" }, STRING, BOOL],
    result: VOID,
  },
  "assert.throwsRegex": {
    argTypes: [REGEX, { kind: "object", className: "%Error" }, STRING, BOOL],
    result: VOID,
  },
  // Symbol strict equality (pointer identity; scr_symbol.c).
  "assert.eqSym": {
    argTypes: [{ kind: "symbol" }, { kind: "symbol" }, BOOL, BOOL, STRING, BOOL],
    result: VOID,
  },
  // The equality quartet over checked-dynamic operands (the frontend
  // boxes a static side into the checked-dynamic tree first).
  "assert.eqDyn": { argTypes: [DYN, DYN, BOOL, BOOL, STRING, BOOL], result: VOID },
  "assert.looseResult": { argTypes: [BOOL, BOOL, STRING, STRING, STRING, BOOL], result: VOID },
  // The throws(fn, {shape}) accumulator: begin/slot calls never throw;
  // shapeEnd throws the Comparison diff. The error slot is the
  // %Error-narrowed caught value.
  "assert.shapeBegin": { argTypes: [{ kind: "object", className: "%Error" }], result: VOID },
  "assert.shapeStr": { argTypes: [F64, STRING], result: VOID },
  "assert.shapeRe": { argTypes: [F64, REGEX], result: VOID },
  "assert.shapeEnd": { argTypes: [STRING, BOOL], result: VOID },
  "assert.regexErrTest": {
    argTypes: [REGEX, { kind: "object", className: "%Error" }],
    result: BOOL,
  },
  "assert.unwantedRejection": {
    argTypes: [{ kind: "object", className: "%Error" }, STRING, BOOL],
    result: VOID,
  },
  "assert.unwantedError": { argTypes: [STRING, BOOL, STRING, BOOL], result: VOID },
  "assert.noErrorPredicate": { argTypes: [DYN, DYN], result: BOOL },
  "assert.regexDynTest": { argTypes: [REGEX, DYN], result: BOOL },
  /** Node's expectsError over an error-INSTANCE expected (assert.throws/
   * rejects second argument): walk the expected dyn error's keys (name,
   * message, code — the %error marker skipped) and deep-compare each
   * against the caught value's; a mismatch throws the deep-equal
   * AssertionError (scr_assert.c). MAY THROW by design. */
  "assert.expectsErrDyn": { argTypes: [DYN, DYN, STRING, BOOL], result: VOID },
  // assert.ifError's typed entries (always throw; unit args never
  // lower). The error slot is program-dependent — any %Error-hierarchy
  // class, root or subclass (the insp.error precedent, null slot).
  "assert.ifErrorErr": { argTypes: [null], result: VOID },
  "assert.ifErrorF64": { argTypes: [F64], result: VOID },
  "assert.ifErrorStr": { argTypes: [STRING], result: VOID },
  "assert.ifErrorBool": { argTypes: [BOOL], result: VOID },
  "assert.ifErrorDyn": { argTypes: [DYN], result: VOID },
  // Bytes equality: the two value slots are any bytes kind (the frontend
  // gates both sides to ONE static bytes type; the libCall case checks
  // the kind and the pair below).
  "assert.refEqBytes": { argTypes: [null, null, BOOL, BOOL, STRING, BOOL], result: VOID },
  "assert.refEqFn": { argTypes: [null, null, BOOL, STRING, BOOL], result: VOID },
  "assert.bytesDeepEq": { argTypes: [null, null, BOOL], result: BOOL },
  // util.inspect: the error receiver is program-dependent (a builtin or
  // user error class — the error.toString precedent, null slot).
  /** util.inspect (scr_inspect.c — its own link switch, moduleUsesInspect):
   * the runtime half of the static rendering. Scalar formatters return +1
   * strings (insp.f64: JS ToString except -0; insp.str: the quoting
   * ladder + line splitting; insp.regex: /source/flags; insp.buffer:
   * <Buffer aa ..>). insp.error renders the STACKLESS [Name: message]
   * form with the code slot as its one property. insp.dyn walks the
   * checked-dynamic tree entirely in the runtime (its shape lives in the
   * value); insp.dynS is format's %s twin (dyn strings pass verbatim).
   * insp.jsval ([value, recurse, depth], --dynamic only) renders the
   * island scalars and THROWS a catchable TypeError on composites (the
   * may-throw seed set). begin/entry/moreItems/end drive the frame
   * engine from the compiler-synthesized per-type traversal helpers
   * (%util.insp.N — the deepStrictEqual precedent). */
  "insp.f64": { argTypes: [F64], result: STRING },
  /** util.format %j over a checked-dynamic argument: the runtime dyn
   * walk (JS-exact stringify; root undefined/function prints
   * "undefined"; a handle in the tree throws the loud fence). */
  "insp.jsonDyn": { argTypes: [DYN], result: STRING },
  "insp.str": { argTypes: [STRING], result: STRING },
  "insp.regex": { argTypes: [REGEX], result: STRING },
  "insp.buffer": { argTypes: [BYTES_U8], result: STRING },
  "insp.error": { argTypes: [null, F64, F64], result: STRING },
  "insp.dyn": { argTypes: [DYN, F64, F64], result: STRING },
  "insp.dynS": { argTypes: [DYN, F64], result: STRING },
  "insp.jsval": { argTypes: [JSVAL, F64, F64], result: STRING },
  "insp.begin": { argTypes: [F64], result: VOID },
  "insp.entry": { argTypes: [STRING, BOOL], result: VOID },
  // Circular references: the receiver slot is program-dependent (any
  // cycle-capable record/array/map/class type — the insp.error precedent).
  /* Circular references over cycle-capable composites (recursive record/
   * class types): circCheck answers a value's circular id when it is
   * already on the traversal stack (0 otherwise), seenPush/refWrap
   * bracket the frame (refWrap adds Node's "<ref *N> " prefix to values
   * the walk found circular), circular renders "[Circular *N]". */
  "insp.circCheck": { argTypes: [null], result: F64 },
  "insp.seenPush": { argTypes: [null], result: VOID },
  "insp.refWrap": { argTypes: [null, STRING], result: STRING },
  "insp.circular": { argTypes: [F64], result: STRING },
  "insp.key": { argTypes: [STRING], result: STRING },
  "insp.moreItems": { argTypes: [F64], result: STRING },
  "insp.end": { argTypes: [STRING, STRING, STRING, F64, BOOL, BOOL], result: STRING },
  /** node:string_decoder's utf8 StringDecoder (scr_string.c): the decoder
   * value is a one-field record whose f64 PACKS the pending partial
   * sequence (count + up to 3 raw bytes — Node buffers at most 3 for
   * every encoding); the frontend's interned %strdec helpers thread it,
   * with the decoder's CANONICAL encoding name first, through these pure
   * functions. write: (enc, pending, chunk) → the decoded complete
   * prefix of pending+chunk (+1); next: (enc, pending, chunk) → the
   * packed NEW pending; end: (enc, pending) → the buffered partial's
   * flush (+1). Node-exact per encoding (oracle-pinned); none throws. */
  "strdec.write": { argTypes: [STRING, F64, BYTES_U8], result: STRING },
  "strdec.next": { argTypes: [STRING, F64, BYTES_U8], result: F64 },
  "strdec.end": { argTypes: [STRING, F64], result: STRING },
  // node:readline: the interface handle is f64; the callbacks' func types
  // are program-dependent (zero-param or (answer: string) — the emitter
  // picks the adapter), so those slots are null like child.onExit's.
  /** node:readline's question/close slice (scr_readline.c, linked under
   * the events gate — these fns imply moduleUsesProcessEvents). The
   * interface value is an f64 handle (the Timeout-id precedent).
   * rl.create: [] → f64 — createInterface({ input: process.stdin,
   * output: process.stdout }), registering the unit's shared stdin
   * consumer (an OPEN interface keeps the loop alive until close/EOF,
   * Node's semantics). rl.question: [handle, query, cb] — writes the
   * query to stdout (Node writes under pipes too) and delivers the next
   * line's text through a backend-picked adapter (zero-param or
   * (answer: string)); THROWS Node's "readline was closed" on a closed
   * interface (may-throw). rl.close: [handle] — fires 'close' listeners
   * SYNCHRONOUSLY (Node's inline emit) and detaches the consumer (the
   * loop stops waiting on fd 0). rl.onClose: [handle, cb] — a zero-arg
   * listener (moves); stdin EOF closes every open interface with the
   * buffered partial line DISCARDED, like Node. */
  "rl.create": { argTypes: [], result: F64 },
  "rl.question": { argTypes: [F64, STRING, null], result: VOID },
  "rl.close": { argTypes: [F64], result: VOID },
  "rl.onClose": { argTypes: [F64, null], result: VOID },
  /** node:timers/promises — the promisified pair (scr_async.c, beside
   * the timer heap they ride): tp.setTimeout: [ms] → a pending void
   * promise a one-shot heap timer fulfills (the loop's timer phase, FIFO
   * against equal deadlines like Node); tp.setImmediate: [] → the same
   * through the immediate queue (fires before due timers of later loop
   * turns, Node's check phase). Neither throws. */
  "tp.setTimeout": { argTypes: [F64], result: { kind: "promise", inner: VOID } },
  "tp.setImmediate": { argTypes: [], result: { kind: "promise", inner: VOID } },
  /** node:diagnostics_channel (scr_dc.c, linked when any dc.* appears —
   * the zlib gating precedent): a process-global name→channel registry;
   * channel values are f64 handles (type-mapper.ts maps Channel to F64, the
   * readline.Interface pattern). Subscribers are dyn function values —
   * identity-compared by unsubscribe, called (message, name) by publish
   * over a SNAPSHOT of the list (a subscriber unsubscribing itself
   * mid-publish still lets its siblings fire, Node's behavior). dc.publish
   * MAY THROW: a subscriber's throw propagates out of publish (catchable
   * there) where Node routes it to triggerUncaughtException — the
   * documented divergence. subscribe/unsubscribe throw Node's
   * ERR_INVALID_ARG_TYPE TypeError for non-function subscribers. */
  "dc.channel": { argTypes: [STRING], result: F64 },
  "dc.subscribe": { argTypes: [STRING, DYN], result: VOID },
  "dc.unsubscribe": { argTypes: [STRING, DYN], result: BOOL },
  "dc.hasSubscribers": { argTypes: [STRING], result: BOOL },
  "dc.publish": { argTypes: [F64, DYN], result: VOID },
  "dc.chanSubscribe": { argTypes: [F64, DYN], result: VOID },
  "dc.chanUnsubscribe": { argTypes: [F64, DYN], result: BOOL },
  "dc.chanHasSubscribers": { argTypes: [F64], result: BOOL },
  "dc.chanName": { argTypes: [F64], result: STRING },
  /** TracingChannel (dc.tracingChannel): a registry entry of the five
   * event channels, an f64 handle like Channel (type-mapper.ts). tcSubscribe/
   * tcUnsubscribe walk a dyn handlers object's five event keys (truthy
   * non-function slots throw the per-channel ERR_INVALID_ARG_TYPE);
   * tcTraceSync/tcTraceCallback/tcTracePromise run Node's publish choreography in C over
   * dyn values (fn, ctx, thisArg, args-array) with thisArg bound as the
   * ambient receiver — the traced call's throw and any subscriber throw
   * both propagate (MAY THROW). tcTraceCallback wraps args[position] in a
   * native error/result + asyncStart/asyncEnd publisher and throws Node's
   * TypeError when that slot is not callable. tracingChannelOf is the
   * five-Channel collection form of the constructor. */
  /** setImmediate as a first-class dyn value (scr_async.c): a minted dyn
   * callable scheduling args[0](args[1..]) on the immediate queue — the
   * Node-suite traceCallback shape (`traceCallback(setImmediate, ...)`).
   * Calling it validates the callback (the dyn call machinery); minting
   * never throws. */
  "timers.setImmediateFnValue": { argTypes: [], result: DYN },
  /** `new Promise(setImmediate)` (the Node-suite early-exit shape): a
   * fresh promise an immediate fulfills with the undefined dyn value —
   * the executor IS setImmediate, so resolve rides the immediate queue
   * (scr_async.c). Never throws. */
  "timers.immediatePromise": { argTypes: [], result: { kind: "promise", inner: DYN } },
  "dc.tracingChannel": { argTypes: [STRING], result: F64 },
  "dc.tracingChannelOf": { argTypes: [F64, F64, F64, F64, F64], result: F64 },
  "dc.tcChannel": { argTypes: [F64, F64], result: F64 },
  "dc.tcHasSubscribers": { argTypes: [F64], result: BOOL },
  "dc.tcSubscribe": { argTypes: [F64, DYN], result: VOID },
  "dc.tcUnsubscribe": { argTypes: [F64, DYN], result: BOOL },
  "dc.tcTraceSync": { argTypes: [F64, DYN, DYN, DYN, DYN], result: DYN },
  "dc.tcTraceCallback": { argTypes: [F64, DYN, F64, DYN, DYN, DYN], result: DYN },
  /** tracePromise (scr_dc.c): start publish, the traced call, a wrap of
   * non-promise results, the end publish, and a REACTION FIBER that
   * awaits the traced promise and publishes asyncStart/asyncEnd (error
   * first on rejection) before settling the returned promise<dyn> with
   * the passed-through outcome. MAY THROW (the traced call and the
   * synchronous publishes). */
  "dc.tcTracePromise": {
    argTypes: [F64, DYN, DYN, DYN, DYN],
    result: { kind: "promise", inner: DYN },
  },
  /** process.on/once('unhandledRejection', fn): registers a dyn listener
   * the checkpoint report dispatches per never-observed rejection —
   * (reason, promise) — instead of printing and exiting 1 (scr_async.c).
   * The bool second arg is `once` (auto-removed after one delivery,
   * Node's once); off/removeListener remove by closure identity, the
   * offWarning stance. Throws Node's ERR_INVALID_ARG_TYPE on a
   * non-function. */
  /** Uncaught exception handlers and monitors: [callback dyn, once, monitor]. */
  "process.onUncaughtException": { argTypes: [DYN, BOOL, BOOL], result: VOID },
  "process.offUncaughtException": { argTypes: [DYN, BOOL], result: VOID },
  "process.onUnhandledRejection": { argTypes: [DYN, BOOL], result: VOID },
  "process.offUnhandledRejection": { argTypes: [DYN], result: VOID },
  /** process.on/once/off('rejectionHandled', fn): the sibling registry.
   * A handler attached after unhandledRejection delivery fires the event
   * once. Dispatch is synchronous at the attach, with the promise,
   * Node's payload. */
  "process.onRejectionHandled": { argTypes: [DYN, BOOL], result: VOID },
  "process.offRejectionHandled": { argTypes: [DYN], result: VOID },
  /** process warnings (scr_lib.c): onWarning/offWarning register dyn
   * listeners; emitWarning applies Node's full argument grammar over the
   * call's dyn argument vector (ERR_INVALID_ARG_TYPE TypeErrors — MAY
   * THROW; a listener throw propagates too) and always prints Node's
   * stderr report. Emission is synchronous (SEMANTICS.md). */
  "process.onWarning": { argTypes: [DYN], result: VOID },
  "process.offWarning": { argTypes: [DYN], result: VOID },
  "process.emitWarning": { argTypes: [DYN], result: VOID },
  /** AsyncLocalStorage (node:async_hooks — scr_async.c): stores are f64
   * handles; contexts are immutable fiber-carried snapshots (spawned
   * fibers inherit the spawner's — Node's init-time capture). run/exit
   * enter (or clear) the store, call the dyn function with forwarded
   * arguments, and restore (the finally); getStore answers the current
   * dyn value or undefined; enterWith installs with no restore point.
   * run/exit MAY THROW (the callback's own throws propagate). */
  /** `await v` over a checked-dynamic VALUE (scr_async.c): a dyn promise
   * adopts (rejections re-throw — MAY THROW), anything else takes JS's
   * one-microtask non-thenable await and answers itself. Only emitted
   * inside async bodies (the frontend's isAsync gate). */
  "async.awaitDyn": { argTypes: [DYN], result: DYN },
  /** The bare one-microtask hop (scr_await_hop): `await v` over a typed
   * NON-promise value — JS awaits non-thenables through exactly one
   * microtask turn and yields the value itself. Never throws. */
  "async.hop": { argTypes: [], result: VOID },
  "als.new": { argTypes: [], result: F64 },
  "als.get": { argTypes: [F64], result: DYN },
  "als.run": { argTypes: [F64, DYN, DYN, DYN], result: DYN },
  "als.exitRun": { argTypes: [F64, DYN, DYN], result: DYN },
  "als.enterWith": { argTypes: [F64, DYN], result: VOID },
  "als.disable": { argTypes: [F64], result: VOID },
  /** Channel.bindStore/unbindStore/runStores (scr_dc.c): the
   * AsyncLocalStorage integration — set-semantics bindings per store,
   * runStores entering every bound store with transform(data) around the
   * publish and the callback (MAY THROW: transforms, subscribers, and
   * the callback all run). */
  "dc.chanBindStore": { argTypes: [F64, F64, DYN], result: VOID },
  "dc.chanUnbindStore": { argTypes: [F64, F64], result: BOOL },
  "dc.chanRunStores": { argTypes: [F64, DYN, DYN, DYN, DYN], result: DYN },
  /** The Number statics with a static C implementation (scr_lib.c): one
   * f64 arg → bool, JS-exact BY CONSTRUCTION — Number.isFinite/isNaN/
   * isInteger/isSafeInteger never coerce, and the frontend routes only
   * f64-typed arguments here (other static types fence). None throws. */
  "number.isFinite": { argTypes: [F64], result: BOOL },
  "number.isNaN": { argTypes: [F64], result: BOOL },
  "number.isInteger": { argTypes: [F64], result: BOOL },
  "number.isSafeInteger": { argTypes: [F64], result: BOOL },
  /** Date (scr_lib.c). Values are TimeClip'd epoch-millisecond scalars:
   * construction/store/pass/getters are exact while identity and mutation
   * remain fenced. date.now is Node's integer milliseconds since epoch;
   * date.toISOString formats one raw f64 millisecond time value and
   * date.toISOStringValue formats a stored Date, both with Node's rules (UTC,
   * YYYY-MM-DDTHH:mm:ss.sssZ, expanded ±YYYYYY years outside 0–9999,
   * ToInteger truncation of fractional ms) and THROWS Node's "Invalid
   * time value" RangeError on NaN / out-of-range input (may-throw seed).
   * Results: f64 / owned (+1) string. */
  "date.now": { argTypes: [], result: F64 },
  "date.newNow": { argTypes: [], result: DATE_T },
  "date.newMs": { argTypes: [F64], result: DATE_T },
  "date.newString": { argTypes: [STRING], result: DATE_T },
  /** Date.parse(dateString), with its own reach witness for exact fences. */
  "date.parse": { argTypes: [STRING], result: F64 },
  "date.getTime": { argTypes: [DATE_T], result: F64 },
  "date.valueOf": { argTypes: [DATE_T], result: F64 },
  "date.toISOString": { argTypes: [F64], result: STRING },
  "date.toISOStringValue": { argTypes: [DATE_T], result: STRING },
  "date.getFullYear": { argTypes: [DATE_T], result: F64 },
  "date.getUTCFullYear": { argTypes: [DATE_T], result: F64 },
  "date.getMonth": { argTypes: [DATE_T], result: F64 },
  "date.getUTCMonth": { argTypes: [DATE_T], result: F64 },
  "date.getDate": { argTypes: [DATE_T], result: F64 },
  "date.getUTCDate": { argTypes: [DATE_T], result: F64 },
  "date.getDay": { argTypes: [DATE_T], result: F64 },
  "date.getUTCDay": { argTypes: [DATE_T], result: F64 },
  "date.getHours": { argTypes: [DATE_T], result: F64 },
  "date.getUTCHours": { argTypes: [DATE_T], result: F64 },
  "date.getMinutes": { argTypes: [DATE_T], result: F64 },
  "date.getUTCMinutes": { argTypes: [DATE_T], result: F64 },
  "date.getSeconds": { argTypes: [DATE_T], result: F64 },
  "date.getUTCSeconds": { argTypes: [DATE_T], result: F64 },
  "date.getMilliseconds": { argTypes: [DATE_T], result: F64 },
  "date.getUTCMilliseconds": { argTypes: [DATE_T], result: F64 },
  "date.getTimezoneOffset": { argTypes: [DATE_T], result: F64 },
  /** The composed `new Date(dateString).getTime()` read: one borrowed
   * string, f64 milliseconds since epoch. The parsed grammar is BOUNDED
   * (documented divergence — V8's parser accepts far more): the ASN.1
   * validity shape X509Certificate.validFrom/validTo answer ("Jul  1
   * 00:00:00 2026 GMT" — the portless cert-expiry read), and ECMA's own
   * date-time string format (YYYY-MM-DD[THH:mm[:ss[.sss]]][Z|±HH:MM] —
   * date-only forms are UTC, exactly the spec). Anything else is NaN,
   * Node's invalid-date getTime. Never throws. */
  "date.parseGetTime": { argTypes: [STRING], result: F64 },
  /** `Date.UTC(...)` — seven f64 arguments (the frontend completes the
   * spec's defaults for omitted trailing parts: month 0, date 1, time
   * parts 0), the spec's MakeDay/MakeTime/TimeClip exactly: 0–99 years
   * map to 1900+year, out-of-range months/dates roll over, non-finite
   * parts and out-of-range results answer NaN. Never throws. */
  "date.utc": { argTypes: [F64, F64, F64, F64, F64, F64, F64], result: F64 },
  /** WHATWG TextDecoder.decode over u8 bytes (scr_bytes.c): utf-8 with
   * default options — the same maximal-subpart replacement decode as
   * Buffer.toString("utf8"), with the leading BOM stripped (the one
   * behavioral difference; ignoreBOM defaults to false). Inline calls
   * lower directly; stored decoder records dispatch by encoding id.
   * TextEncoder.encode needs no libFn: its matching forms
   * lower to buffer.fromStr(s, "utf8") (identical bytes — ScrStr storage
   * is well-formed UTF-8). Borrowed arg; owned (+1) string; never throws. */
  "text.decode": { argTypes: [BYTES_U8], result: STRING },
  "bytes.bufferSource": { argTypes: [DYN], result: BYTES_U8 },
  "text.decodeBufferSource": { argTypes: [DYN], result: STRING },
  "text.decodeOptions": { argTypes: [BYTES_U8, BOOL, BOOL], result: STRING },
  "text.decodeStream": { argTypes: [DYN, BYTES_U8, F64, BOOL, BOOL, BOOL], result: STRING },
  "text.decodeLegacyOptions": { argTypes: [BYTES_U8, F64, BOOL, BOOL], result: STRING },
  /** TextDecoder.decode for a compile-time non-UTF-8 WHATWG label. The
   * second f64 is the frontend-owned encoding id consumed by scr_bytes.c;
   * label aliases/case/ASCII whitespace are canonicalized before IR. The
   * mapping tables are generated from the pinned Node 24 oracle, keeping
   * output portable without an ICU/iconv dependency. Borrowed args; owned
   * (+1) string; never throws. */
  "text.decodeLegacy": { argTypes: [BYTES_U8, F64], result: STRING },
  "text.decoderEncoding": { argTypes: [DYN], result: F64 },
  "text.decoderName": { argTypes: [F64], result: STRING },
  "text.encodeInto": { argTypes: [DYN, DYN], result: DYN },
  "buffer.isAscii": { argTypes: [DYN], result: BOOL },
  "buffer.isUtf8": { argTypes: [DYN], result: BOOL },
  "buffer.transcode": { argTypes: [DYN, DYN, DYN], result: BYTES_U8 },
  /** The fs option forms and friends (scr_lib.c), all throwing catchably
   * like the rest of sync fs. mkdirRecursiveSync is Node's recursive
   * algorithm (try mkdir, EEXIST-dir is fine, ENOENT creates the parent
   * first — errors report Node's errno at Node's path, EEXIST at a file
   * target, ENOTDIR at the full path past a file); the first-created-dir
   * return value has no lowering (statement position only, frontend-
   * fenced). rmOptsSync is rmSync with (recursive, force) bools: force
   * swallows ENOENT, recursive removes trees post-order, a directory
   * without recursive throws the EISDIR-worded error (divergence 13's
   * wording note). mkdtempSync appends the six X's and returns the
   * created path (+1). accessSync takes the F_OK/R_OK/W_OK/X_OK bits as
   * one f64 (the frontend bakes fs.constants.* as literals and completes
   * an omitted mode to 0). readFdSync/readFdSyncBytes are the
   * readFileSync(fd[, "utf8"]) forms — a read(2) loop to EOF on the fd
   * (the stdin path); errors carry Node's no-path message shape. */
  "fs.mkdirRecursiveSync": { argTypes: [STRING], result: VOID },
  "fs.rmOptsSync": { argTypes: [STRING, BOOL, BOOL], result: VOID },
  /** rmOptsSync's maxRetries/retryDelay form (path, recursive, force,
   * maxRetries, retryDelay): Node's linear-backoff retry on
   * EBUSY/EMFILE/ENFILE/ENOTEMPTY/EPERM — the tmpdir-harness shape
   * rmSync(p, { maxRetries: 3, recursive: true, force: true }). */
  "fs.rmRetrySync": { argTypes: [STRING, BOOL, BOOL, F64, F64], result: VOID },
  "fs.mkdtempSync": { argTypes: [STRING], result: STRING },
  "fs.accessSync": { argTypes: [STRING, F64], result: VOID },
  "fs.readFdSync": { argTypes: [F64, STRING], result: STRING },
  "fs.readFdSyncBytes": { argTypes: [F64], result: BYTES_U8 },
  /** Validated isatty(3) probe. Stream property lowering maps false to
   * undefined; tty.isatty exposes the boolean result directly. */
  "process.isTTY": { argTypes: [F64], result: BOOL },
  // Like process.envGet: the result is the module's interned
  // `number | undefined` union — checked by arms in the libCall case.
  /** Terminal width over an fd literal (1/2 — process.stdout/stderr
   * .columns): ioctl(TIOCGWINSZ). The result is the module's interned
   * `number | undefined` union — a non-TTY stream (or an ioctl refusal)
   * yields the undefined arm, exactly Node's missing `.columns`. Never
   * throws. */
  "process.columns": { argTypes: [F64], result: VOID },
  /** Terminal height, with the same fd and optional-number contract. */
  "process.rows": { argTypes: [F64], result: VOID },
  /** process.stdin.destroy(): a deliberate no-op (no stream machinery
   * exists to tear down; documented in SEMANTICS.md). */
  "process.stdinDestroy": { argTypes: [], result: VOID },
  /** process.stdin.setRawMode(mode) — one borrowed bool arg, void. On a
   * TTY stdin: termios raw mode on/off (libuv's UV_TTY_MODE_RAW flag set,
   * the mode Node's setRawMode(true) applies; false restores the entry
   * state). On a NON-TTY stdin Node's process.stdin has no such method at
   * all, so the call throws Node's exact catchable TypeError
   * ("process.stdin.setRawMode is not a function") — the may-throw seed
   * carries it. */
  "process.stdinSetRawMode": { argTypes: [BOOL], result: VOID },
  // Arg 0 is a packed f64[] OR a bytes value (the spread-typed-array
  // form) — checked in the libCall case.
  /** fromCharCode takes one packed f64[] or bytes arg and builds a string
   * from UTF-16 code units. Adjacent surrogate pairs combine; lone
   * surrogates follow the runtime's replacement policy. */
  "string.fromCharCode": { argTypes: [null], result: STRING },
  /** Numeric code points, with catchable RangeError for non-integers or
   * values outside 0..0x10ffff. Uses the same UTF-8 surrogate policy. */
  "string.fromCodePoint": { argTypes: [null], result: STRING },
  /** lastIndexOf returns the last UTF-16 start index, or -1. The two-arg
   * form searches at or before its numeric position; NaN starts at the end.
   * String arguments are borrowed and neither form throws. */
  "string.lastIndexOf": { argTypes: [STRING, STRING], result: F64 },
  "string.lastIndexOfFrom": { argTypes: [STRING, STRING, F64], result: F64 },
  /** String.raw(template, ...subs): the raw literals array (a string[]
   * read off the template record) interleaved with the PRE-STRINGIFIED
   * substitutions (the frontend applies the static ToString and packs
   * them into one string[] literal) — extra substitutions drop, missing
   * ones skip, the spec's loop exactly (scr_array.c). Borrowed args;
   * +1 string; never throws. */
  "string.raw": { argTypes: [arrayOf(STRING), arrayOf(STRING)], result: STRING },
});

/** A builtin name exists exactly when its runtime signature exists. */
export type IrLibFn = keyof typeof LIB_FN_SIGS;
