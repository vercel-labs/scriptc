import { arrayOf, BOOL, BYTES_U8, DYN, F64, PROCSTREAM_T, STRING, VOID, setOf } from "../ir.js";
import { defineLibFnSignatures } from "./shared.js";

/** The process builtin call slots. */
export const processSignatures = defineLibFnSignatures({
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
  /** process.memoryUsage(): memoryUsageTake samples the resident set and
   * the runtime heap once (MAY THROW Node's uv_resident_set_memory error)
   * and memoryUsageField(k) reads that sample (0 rss, 1 heapTotal, 2
   * heapUsed, 3 external, 4 arrayBuffers). rss is memoryUsage.rss(). */
  "process.memoryUsageTake": { argTypes: [], result: VOID },
  "process.memoryUsageField": { argTypes: [F64], result: F64 },
  "process.rss": { argTypes: [], result: F64 },
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
  /** cpuUsage(prev) / threadCpuUsage(prev) for a prev the frontend cannot
   * type as { user, system }: Node's validation of a truthy prev (the
   * object and field TypeErrors, the non-negative finite ERR_INVALID_ARG_VALUE
   * RangeError) followed by one clock sample (thread != 0 picks the thread
   * clock), then cpuDynField(0/1) reads the user/system difference. */
  "process.cpuDynPrepare": { argTypes: [DYN, F64], result: VOID },
  "process.cpuDynField": { argTypes: [F64], result: F64 },
  "process.rusage": { argTypes: [F64], result: F64 },
  "process.activeResources": { argTypes: [], result: arrayOf(STRING) },
  // Signal listeners are zero-param (the ambient shape); exit/stdin
  // callbacks carry program-dependent one-param shapes — null slots, the
  // libCall case checks them (child.onExit precedent).
  /** Named process signal events: [name string, callback dyn, once bool]
   * or [name, callback] for removal. The runtime resolves platform signal
   * numbers and delivers (name, number). Listeners do not keep the loop
   * alive. Invalid callbacks and uncatchable signals throw. */
  "process.onSignal": { argTypes: [STRING, DYN, BOOL], result: VOID },
  "process.offSignal": { argTypes: [STRING, DYN], result: VOID },
  /** process.prependListener(<signal>, cb): the same listener in front of
   * the signal's existing registrations (Node appends with `on`, so the
   * two differ only in dispatch order). Never `once` — that is
   * prependOnceListener, which has no lowering. */
  "process.prependSignal": { argTypes: [STRING, DYN], result: VOID },
  /** The process 'exit' event — process.on/once/off("exit"). args: [cb,
   * once bool] / [cb]. Listeners run SYNCHRONOUSLY at termination
   * (normal exit, process.exit(), the uncaught/unhandled exit-1 paths)
   * with the exit code; anything they schedule never runs, like Node.
   * Callback shapes: () => void or (code: number) => void — the emitter
   * picks the runtime adapter. Never throw. */
  "process.onExit": { argTypes: [null, BOOL], result: VOID },
  "process.offExit": { argTypes: [null], result: VOID },
  /** process.prependListener("exit", cb): the same listener in front of
   * the exit registry's existing entries. */
  "process.prependExit": { argTypes: [null], result: VOID },
  /** The process 'beforeExit' event — process.on/once/off/removeListener/
   * prependListener("beforeExit"). Same callback shapes and adapters as
   * 'exit', but a registry of its own: listeners run each time the loop
   * runs out of ref'd work (main thread only) with process.exitCode, and
   * work they schedule re-enters the loop (Node re-emits at the next
   * exhaustion). Never throw. */
  "process.onBeforeExit": { argTypes: [null, BOOL], result: VOID },
  "process.offBeforeExit": { argTypes: [null], result: VOID },
  "process.prependBeforeExit": { argTypes: [null], result: VOID },
  /** umask(2): arg < 0 reads without setting (umask has no read-only form
   * — set 0, restore); otherwise sets and answers the PREVIOUS mask.
   * Never throws. */
  "process.umask": { argTypes: [F64], result: F64 },
  /** The umask argument validators Node runs before the call: an integer
   * in [0, 4294967295] (ERR_OUT_OF_RANGE RangeErrors, catchable). */
  "process.umaskChk": { argTypes: [F64], result: F64 },
  /** umask(expr) for a non-number expr: Node's parseFileMode — a string
   * must be octal ([0-7]+, else ERR_INVALID_ARG_VALUE), other types are
   * the ERR_INVALID_ARG_TYPE TypeError. */
  "process.umaskDyn": { argTypes: [DYN], result: F64 },
  /** chdir(2) — throws Node's fs-shaped error (ENOENT/EACCES/ENOTDIR,
   * syscall "chdir") on failure. */
  "process.chdir": { argTypes: [STRING], result: VOID },
  /** chdir(expr) for a non-string expr: Node's validateString rejects it
   * with the ERR_INVALID_ARG_TYPE "directory" message (no ToString — an
   * object, array, null and a symbol all throw), and a string takes the
   * same call. */
  "process.chdirDyn": { argTypes: [DYN], result: VOID },
  "process.loadEnvFile": { argTypes: [DYN], result: VOID },
  /** process._exiting: true once the exit sequence began (exit listeners
   * running) — the runtime flag scr_run_exit_listeners/process.exit set.
   * Never throws. */
  "process.exiting": { argTypes: [], result: BOOL },
  /** Static-native fork startup and IPC. process.forkTarget initializes a
   * re-executed child's inherited channel and returns its embedded target id
   * (-1 in the parent). The remaining entries mirror Node's JSON channel. */
  "process.forkTarget": { argTypes: [F64], result: F64 },
  "process.connected": { argTypes: [], result: BOOL },
  /** process.channel: the fork IPC channel (undefined without one, null
   * once disconnected, else the cached Control object with ref()/
   * unref()). +1. Never throws. */
  "process.channel": { argTypes: [], result: DYN },
  /** Whether this fork child opened its channel; part of process.send's
   * presence in programs with fork targets. Never throws. */
  "process.ipcOpen": { argTypes: [], result: BOOL },
  "process.send": { argTypes: [STRING], result: BOOL },
  "process.sendCb": { argTypes: [STRING, null], result: BOOL },
  "process.disconnect": { argTypes: [], result: VOID },
  "process.onMessage": { argTypes: [null, BOOL], result: VOID },
  "process.onDisconnect": { argTypes: [null, BOOL], result: VOID },
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
  "process.argv": { argTypes: [], result: arrayOf(STRING) },
  // The Node runtime flags a node:test binary took out of process.argv
  // (--test-update-snapshots and the reporter options), or []; a fresh
  // array per read.
  "process.execArgv": { argTypes: [], result: arrayOf(STRING) },
  /** process.allowedNodeEnvironmentFlags: the interned set of option
   * names the compatibility target accepts in NODE_OPTIONS (+1 read of
   * one stable set). */
  "process.allowedEnvFlags": { argTypes: [], result: setOf(STRING) },
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
  /** `process.env[expr]` with a key the frontend cannot fence to a string:
   * Node's proxy ToStrings the key (a Symbol reads undefined rather than
   * throwing — the runtime's envGetDyn does the same) and answers the
   * same interned `string | undefined` union as process.envGet. A key
   * object whose toString throws propagates that throw. */
  "process.envGetDyn": { argTypes: [DYN], result: VOID },
  /** `process.env[k] = v` for a non-string value: Node's proxy ToStrings
   * the value (a Symbol value throws the toString TypeError). */
  "process.envSetDyn": { argTypes: [STRING, DYN], result: VOID },
  /** Both sides dynamic: the key is ToString'd first, then the value —
   * Node's proxy order — so a key or value that throws throws in that
   * order. */
  "process.envSetKeyDyn": { argTypes: [DYN, DYN], result: VOID },
  /** setenv(3): (name, value) string args → void. Later envGet reads and
   * spawned children observe the write, like Node (a non-string RHS takes
   * the checked-dynamic envSetDyn, whose ToString Node's proxy runs).
   * The frontend rejects writes when --define fixes the variable. */
  "process.envSet": { argTypes: [STRING, STRING], result: VOID },
  /** `delete process.env[NAME]` — unsetenv(3): the mutation is visible to
   * every later read (process.envGet asks getenv fresh) and inherited by
   * spawned children, exactly Node. Statement position only (JS's boolean
   * result is constant true there). Borrows the name; never throws. */
  "process.envUnset": { argTypes: [STRING], result: VOID },
  /** `delete process.env[expr]`: the same unsetenv, with Node's proxy
   * ToString of the key (a Symbol key is a no-op answering true). */
  "process.envUnsetDyn": { argTypes: [DYN], result: VOID },
  /** The whole environment as alternating [k0, v0, k1, v1, ...] strings in
   * environ order — the raw material of the process.env SNAPSHOT record
   * (the frontend's interned %env.snapshot helper keyed-writes the pairs
   * into a fresh `{ [k: string]: string | undefined }` record). Fresh +1
   * array; never throws. */
  "process.envPairs": { argTypes: [], result: arrayOf(STRING) },
  "process.exit": { argTypes: [F64], result: VOID },
  /** process.abort(): settles stdout, then raises SIGABRT with the default
   * disposition (Node's dump names its own frames, so the compiled binary
   * raises the signal without it). Never returns. */
  "process.abort": { argTypes: [], result: VOID },
  /** process.finalization: the stable register/registerBeforeExit/
   * unregister object (fresh +1 reference to one cached value). */
  "process.finalization": { argTypes: [], result: DYN },
  /** process.exit(expr) for a non-number expr: Node's exitCode setter
   * converts ('' is a TypeError, ' ' is 0, '0x10' is 16, null and
   * undefined clear) before exiting with the resulting status. */
  "process.exitDyn": { argTypes: [DYN], result: VOID },
  /** Numeric process.exitCode write (integer validation, implicit exit status). */
  "process.setExitCode": { argTypes: [F64], result: VOID },
  /** The process.exitCode write of a program that also reads the
   * property: the same validation, and the code counts as assigned. */
  "process.setExitCodeTracked": { argTypes: [F64], result: VOID },
  /** Dyn process.exitCode writes: Node's conversion (' ' → 0, '0x10' →
   * 16, null/undefined clear, '' and non-numeric text are the TypeError)
   * then the integer validation. */
  "process.setExitCodeDyn": { argTypes: [DYN], result: VOID },
  "process.setExitCodeDynTracked": { argTypes: [DYN], result: VOID },
  /** The code for process.exit() with no argument, or zero when unset. */
  "process.currentExitCode": { argTypes: [], result: F64 },
  /** Whether process.exitCode reads a code rather than undefined. Never throws. */
  "process.hasExitCode": { argTypes: [], result: BOOL },
  "process.cwd": { argTypes: [], result: STRING },
  /** getpid(2) / getuid(2): zero args → f64. POSIX-only target, so both
   * always answer (the checker's `getuid?` optionality covers Windows —
   * `process.getuid?.()` lowers as the plain call). Never throw. */
  "process.pid": { argTypes: [], result: F64 },
  /** A sloppy-mode function's `this` from its receiver: the global object
   * for undefined and null, else the receiver. Never throws. */
  "process.getuid": { argTypes: [], result: F64 },
  "process.getgid": { argTypes: [], result: F64 },
  /** geteuid(2) / getegid(2) / getgroups(2) (the effective gid appended
   * when the list lacks it, like Node). Windows has no such members: the
   * calls throw the TypeError a missing member does (MAY THROW). */
  "process.geteuid": { argTypes: [], result: F64 },
  "process.getegid": { argTypes: [], result: F64 },
  "process.getgroups": { argTypes: [], result: arrayOf(F64) },
  /** setuid(2) / seteuid(2) / setgid(2) / setegid(2), setgroups(2) and
   * initgroups(3): Node's JS wrappers validate the id (a uint32 number or
   * a name string) and the runtime answers Node's ERR_UNKNOWN_CREDENTIAL,
   * ErrnoException and ERR_INVALID_ARG_TYPE errors (MAY THROW). */
  "process.setuid": { argTypes: [DYN], result: VOID },
  "process.seteuid": { argTypes: [DYN], result: VOID },
  "process.setgid": { argTypes: [DYN], result: VOID },
  "process.setegid": { argTypes: [DYN], result: VOID },
  "process.setgroups": { argTypes: [DYN], result: VOID },
  "process.initgroups": { argTypes: [DYN, DYN], result: VOID },
  /** process.hasUncaughtExceptionCaptureCallback() and its setter: the
   * setter takes a function or null, and a second callback throws Node's
   * ERR_UNCAUGHT_EXCEPTION_CAPTURE_ALREADY_SET. */
  "process.hasUncaughtCapture": { argTypes: [], result: BOOL },
  "process.setUncaughtCapture": { argTypes: [DYN], result: VOID },
  /** process.debugPort: 9229 until written; the setter keeps the previous
   * value when Node's range check refuses the write (ERR_OUT_OF_RANGE). */
  "process.debugPort": { argTypes: [], result: F64 },
  "process.setDebugPort": { argTypes: [DYN], result: VOID },
  /** process.sourceMapsEnabled: false until setSourceMapsEnabled(true);
   * the setter validates a boolean (ERR_INVALID_ARG_TYPE). */
  "process.sourceMapsEnabled": { argTypes: [], result: BOOL },
  "process.setSourceMapsEnabled": { argTypes: [DYN], result: VOID },
  /** process.ref(maybeRefable) / process.unref(maybeRefable): read the
   * nodejs.ref / nodejs.unref symbol (else the ref / unref member) and
   * call it with the receiver. */
  "process.ref": { argTypes: [DYN], result: VOID },
  "process.unref": { argTypes: [DYN], result: VOID },
  /** process.ppid: the parent's pid at the read. Never throws. */
  "process.ppid": { argTypes: [], result: F64 },
  /** process.title: libuv's process title (argv[0] until set); setTitle
   * writes it (truncated to the original argument area on POSIX, the
   * console title on Windows). Never throw. */
  "process.title": { argTypes: [], result: STRING },
  "process.setTitle": { argTypes: [STRING], result: VOID },
  /** process.title = expr for a non-string expr: Node ToStrings the value
   * (a Symbol throws; arrays join with ",") and writes the result. */
  "process.setTitleDyn": { argTypes: [DYN], result: VOID },
  /** process.argv0: the original argv[0]. Never throws. */
  "process.argv0": { argTypes: [], result: STRING },
  /** process.release: the compatibility target's stable release object
   * (name, lts, sourceUrl, headersUrl, and libUrl on Windows). +1. */
  "process.release": { argTypes: [], result: DYN },
  /** process.features: the stable object of Node's feature flags with a
   * compiled binary's values (the lowering's PROCESS_FEATURES table, in
   * Node's key order). +1. */
  "process.features": { argTypes: [], result: DYN },
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
  "process.builtinObject": { argTypes: [STRING, DYN, arrayOf(STRING)], result: DYN },
  "process.builtinUnsupported": { argTypes: [STRING, STRING], result: DYN },
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
  /** kill(pid, expr) and kill(expr, signal) for expressions outside the
   * fast paths: Node's loose `pid != (pid | 0)` guard (null and undefined
   * are the type error; "1", [], true and the empty string convert), its
   * signal grammar (a number that is not an int32 is ERR_UNKNOWN_SIGNAL
   * with util.format's text; falsy signals mean SIGTERM), and the
   * ToNumber/ToString conversions with their TypeError texts. */
  "process.killSigDyn": { argTypes: [F64, DYN], result: BOOL },
  "process.killDyn": { argTypes: [DYN, DYN], result: BOOL },
  /** The raw byte writes: one borrowed string arg → bool (constantly true
   * — this synchronous runtime never queues backpressure). stdoutWrite
   * shares console.log's stream, each call is submitted promptly, and
   * interleaved output keeps source order. No newline, no formatting,
   * never throws. */
  "process.stdoutWrite": { argTypes: [STRING], result: BOOL },
  "process.stdio": { argTypes: [F64], result: DYN },
  /** The same stream object for a procStream VALUE (the cursor methods'
   * receiver): its scalar representation IS the descriptor. */
  "process.stdioOf": { argTypes: [PROCSTREAM_T], result: DYN },
  /** The same stream object, reached by the typed write-slot lowering
   * (the write method as a value, its replacement, a patched program's
   * typed writes): identical at run time. */
  "process.stdioSlot": { argTypes: [F64], result: DYN },
  /** process.stdout/stderr.write(chunk) with a run-time chunk: Node's
   * Writable validation, then a synchronous write. */
  "process.stdioWriteDyn": { argTypes: [F64, DYN], result: BOOL },
  /** process.stdout/stderr.write(text) at an untyped call site: the same
   * write with the string as the only argument, calling a replaced
   * method. */
  "process.stdioWriteStr": { argTypes: [F64, STRING], result: DYN },
  "process.stderrWrite": { argTypes: [STRING], result: BOOL },
  /** process.on/once('unhandledRejection', fn): registers a dyn listener
   * the checkpoint report dispatches per never-observed rejection —
   * (reason, promise) — instead of printing and exiting 1 (scr_async.c).
   * The bool second arg is `once` (auto-removed after one delivery,
   * Node's once); off/removeListener remove by closure identity, the
   * offWarning stance. Throws Node's ERR_INVALID_ARG_TYPE on a
   * non-function. */
  /** Uncaught exception handlers and monitors: [callback dyn, once, monitor]. */
  "process.onUncaughtException": { argTypes: [DYN, BOOL, BOOL], result: VOID },
  /** Uncaught handlers registered in FRONT of the registry's existing
   * entries: [callback dyn, monitor] (never `once`). */
  "process.prependUncaughtException": { argTypes: [DYN, BOOL], result: VOID },
  "process.offUncaughtException": { argTypes: [DYN, BOOL], result: VOID },
  "process.onUnhandledRejection": { argTypes: [DYN, BOOL], result: VOID },
  "process.offUnhandledRejection": { argTypes: [DYN], result: VOID },
  /** process.on/once/off('rejectionHandled', fn): the sibling registry.
   * A handler attached after unhandledRejection delivery fires the event
   * once. Dispatch is synchronous at the attach, with the promise,
   * Node's payload. */
  "process.onRejectionHandled": { argTypes: [DYN, BOOL], result: VOID },
  "process.offRejectionHandled": { argTypes: [DYN], result: VOID },
  /** process.on/once/off('multipleResolves', fn): the third rejection-event
   * registry. A resolve/reject that reaches an already-resolved promise
   * delivers ('resolve' | 'reject', promise, value) on a nextTick queued
   * at that settle, once per settle in settle order, and the first
   * delivery that reaches a listener warns DEP0160 once per process. */
  "process.onMultipleResolves": { argTypes: [DYN, BOOL], result: VOID },
  "process.offMultipleResolves": { argTypes: [DYN], result: VOID },
  /** process warnings (scr_async_dyn.c): onWarning/offWarning register
   * dyn listeners; emitWarning applies Node's full argument grammar over
   * the call's dyn argument vector (ERR_INVALID_ARG_TYPE TypeErrors — MAY
   * THROW) and emits on the next tick, like Node: Node's stderr report,
   * then the listeners. */
  "process.onWarning": { argTypes: [DYN], result: VOID },
  "process.offWarning": { argTypes: [DYN], result: VOID },
  /** process.emit(event, ...args): Node's EventEmitter emit on process,
   * for the events whose listeners cross as checked-dynamic callbacks. The
   * event name and its argument vector arrive as checked values; the
   * result is whether any listener existed. */
  "process.emit": { argTypes: [DYN, DYN], result: BOOL },
  /** process.emit('error', ...): no listener can be registered for it, so
   * the runtime throws Node's unhandled-error contract. */
  "process.emitError": { argTypes: [DYN], result: VOID },
  "process.emitWarning": { argTypes: [DYN], result: VOID },
  /** A Warning-typed process warning with this message (the console
   * members' warnings), emitted on the next tick as Node's emitWarning
   * does (so the loop runs); an empty message emits nothing. */
  "process.emitWarningText": { argTypes: [STRING], result: VOID },
  /** process.noDeprecation (0) / process.throwDeprecation (1): the stored
   * value (undefined until assigned) and its assignment. util.deprecate's
   * warnings and DeprecationWarning emissions read their truthiness. */
  "process.deprecationFlag": { argTypes: [F64], result: DYN },
  "process.setDeprecationFlag": { argTypes: [F64, DYN], result: VOID },
  "process.setEmitWarning": { argTypes: [DYN], result: VOID },
  /** Validated isatty(3) probe. Stream property lowering maps false to
   * undefined; tty.isatty exposes the boolean result directly. */
  "process.isTTY": { argTypes: [F64], result: BOOL },
  "process.isTTYValue": { argTypes: [DYN], result: BOOL },
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
  /** process.stdin.isRaw: the raw-mode flag of a TTY stdin as the
   * module's interned `boolean | undefined` union (a pipe-backed stdin
   * has no such flag — Node answers undefined there). Never throws. */
  "process.stdinIsRaw": { argTypes: [], result: VOID },
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
});
