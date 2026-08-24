/* The FALLBACK Node-ish declarations — shipped into the program ONLY when
 * the target project has no @types/node (see loadProgram): console, the
 * process global, and the "node:fs" module, typed as exactly the supported
 * surface so unsupported uses are honest TYPE errors. Where a member is
 * part of the stock lib surface but has no lowering, prefer DECLARING it
 * (console's non-lowered members below): a program that typechecks under
 * its own tsc then reaches the per-site lowering fence with its hint,
 * instead of a fallback-manufactured type error it cannot reproduce.
 *
 * When the project's node_modules contains @types/node, this file STANDS
 * DOWN — its declarations would collide with @types/node's own (`declare
 * var process`, `declare var console`, `declare module "node:fs"`), and
 * the project's real types win. The LOWERED surface does not change: the
 * lowerer recognizes the same members by name + provenance (shipped
 * ambient OR @types/node — see isStdlibFile/isNodeTypesPath), and
 * everything else @types/node declares hits the SC2020-family fence at
 * its use site. scriptc.d.ts holds the always-shipped core (divergence
 * overrides, comptime, __island_eval, setTimeout — which MERGES with
 * @types/node's as an overload instead of colliding). */

/* NodeJS.ErrnoException — the Error shape @types/node attaches to fs and
 * child failures. The TYPE maps to the runtime Error root; only `code`
 * has a lowering (throw sites stamp the errno name — "ENOENT" and
 * friends; reads answer `string | undefined`), errno/syscall/path
 * typecheck and fence per member. */
declare namespace NodeJS {
  /* The process introspection records — named interfaces so the type
   * mapper interns their record shapes (the RemoteInfo pattern; the
   * names match @types/node's, so the mappings hold when it adopts). */
  interface CpuUsage {
    user: number;
    system: number;
  }
  interface ResourceUsage {
    userCPUTime: number;
    systemCPUTime: number;
    maxRSS: number;
    sharedMemorySize: number;
    unsharedDataSize: number;
    unsharedStackSize: number;
    minorPageFault: number;
    majorPageFault: number;
    swappedOut: number;
    fsRead: number;
    fsWrite: number;
    ipcSent: number;
    ipcReceived: number;
    signalsCount: number;
    voluntaryContextSwitches: number;
    involuntaryContextSwitches: number;
  }
  interface ErrnoException extends Error {
    errno?: number | undefined;
    code?: string | undefined;
    path?: string | undefined;
    syscall?: string | undefined;
  }
  /* The piped child-output stream (child.stdout / child.stderr under
   * stdio ["ignore", "pipe", "pipe"]): 'data' fires one Buffer chunk per
   * read (≤64KB, consumer-driven — no listener, no read), 'end' fires
   * once at EOF and always BEFORE the child's 'exit'. A flowing stream
   * keeps the loop alive. */
  interface ReadableStream {
    on(event: "data", listener: (chunk: Buffer) => void): void;
    on(event: "end", listener: () => void): void;
    once(event: "data", listener: (chunk: Buffer) => void): void;
    once(event: "end", listener: () => void): void;
    /* Declared surface without a lowering (chunks stay bytes; decode
     * with TextDecoder) — string-mode consumers typecheck and fence at
     * the reached site. With setEncoding in force Node hands strings to
     * 'data', hence the string arm on the listener above being absent:
     * the lowered surface is bytes-only. */
    setEncoding(encoding: string): void;
  }
}

/* log/info/debug write stdout (info and debug ARE log in Node); error and
 * warn are ONE stream (warn IS error under another name) and write stderr
 * with the exact same formatting. Each call submits its output promptly;
 * stdout settles first under merged 2>&1 output. Arguments take Node's
 * console semantics: strings verbatim, everything else through the static
 * util.inspect rendering — so the parameters are unknown[], like stock
 * lib's console; values inspect cannot render statically (functions inside
 * composites, class hierarchies, `any`) fence per argument with a hint.
 *
 * The REMAINING stock console members are declared too — not because they
 * lower (none do), but so a program that typechecks under its own tsc
 * reaches the per-site SC2020 fence naming the member and the supported
 * surface, instead of dying on a fallback-manufactured type error its own
 * tsc cannot reproduce. */
declare const console: {
  log(...args: unknown[]): void;
  info(...args: unknown[]): void;
  debug(...args: unknown[]): void;
  error(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  assert(condition?: unknown, ...data: unknown[]): void;
  clear(): void;
  count(label?: string): void;
  countReset(label?: string): void;
  dir(item?: unknown, options?: unknown): void;
  dirxml(...data: unknown[]): void;
  group(...data: unknown[]): void;
  groupCollapsed(...data: unknown[]): void;
  groupEnd(): void;
  table(tabularData?: unknown, properties?: readonly string[]): void;
  time(label?: string): void;
  timeEnd(label?: string): void;
  timeLog(label?: string, ...data: unknown[]): void;
  timeStamp(label?: string): void;
  trace(...data: unknown[]): void;
};

/* The process global (Node-like, deliberately tiny). Every member lowers to
 * a `libCall` and is implemented in the runtime's scr_lib.c. `argv` is one
 * interned array (identity and mutation semantics match Node's stable
 * process.argv); `exit` flushes stdout and ends the process immediately.
 * `env` reads (`process.env.NAME` / `process.env[name]`) are getenv(3)
 * behind a `string | undefined` union — narrow with `!== undefined` before
 * use — and writes are setenv(3): later reads and spawned children observe
 * them, like Node. `process.env` as a WHOLE value is a fresh
 * `{ [k: string]: string | undefined }` SNAPSHOT record over environ
 * (spreads, Object.keys, spawn-env flows). `pid`/`getuid()` are the POSIX
 * identities (getuid is declared optional to match @types/node — the
 * `?.()` call lowers as the plain call on this POSIX-only target), and
 * `kill` has Node's exact semantics: signal names or numbers, SIGTERM
 * default, signal 0 as an existence probe, and Node's error shapes
 * (`kill ESRCH`/`kill EPERM` Errors, TypeErrors for unknown signals and
 * non-int32 pids). */
declare var process: {
  argv: string[];
  platform: string;
  /* The binary's OWN architecture ("arm64", "x64") — Node's answer for
   * its own build on the same machine. */
  readonly arch: string;
  /* versions.node is the runtime's Node COMPATIBILITY TARGET — no Node
   * exists under a compiled binary (SEMANTICS.md divergence 60); the
   * other components @types/node lists (v8, openssl, ...) do not exist
   * here. openssl and sqlite are DECLARED (optional, so absence reads
   * undefined) and LOWER to undefined — the honest capability probe
   * (`Boolean(process.versions.openssl)`) answers false: no OpenSSL and
   * no SQLite ship in a scriptc binary. Other members fence per site. */
  readonly versions: { readonly node: string; readonly openssl?: string; readonly sqlite?: string };
  /* The build-configuration snapshot Node exposes from its gyp config.
   * A scriptc binary has no V8 and no gyp, so `variables` answers the
   * honest capability record (v8_enable_i18n_support: 0 — no ICU; asan
   * mirrors the sanitizer build flag) and `target_defaults` is absent —
   * probe code takes its documented fallbacks. Reads of undeclared
   * variables go through the index signature (string | number | boolean
   * | undefined) and answer undefined. */
  readonly config: {
    readonly variables: { readonly [name: string]: string | number | boolean | undefined };
    readonly target_defaults?: { readonly default_configuration: string };
  };
  /* Node's feature probes — a compiled binary has no inspector and is
   * not a debug build; undeclared members read undefined through the
   * index signature. */
  readonly features: { readonly [name: string]: boolean | undefined };
  /* umask(2) — sets the file-mode creation mask and returns the previous
   * one; the no-argument form reads without setting (Node's shape). */
  umask(mask?: number): number;
  /* chdir(2) — failures throw Node's fs-shaped catchable error. */
  chdir(directory: string): void;
  /* The extra CLI arguments Node itself consumed (--expose-internals,
   * ...): a compiled binary consumed none, so this is always []. */
  readonly execArgv: string[];
  /* Node's internal "exit sequence started" flag (real, undocumented
   * surface — the test harness reads it): true while 'exit' listeners
   * run, false otherwise. */
  readonly _exiting: boolean;
  /* Node's raw synchronous stderr write (internal surface the test
   * harness uses on its failure paths). */
  _rawDebug(...args: unknown[]): void;
  pid: number;
  /* The compiled binary's own resolved absolute path — Node's is the node
   * executable's (SEMANTICS.md divergence 12, the argv[0]/argv[1] story). */
  readonly execPath: string;
  getuid?(): number;
  getgid?(): number;
  /* signal admits null (Node treats it as the SIGTERM default) — real
   * callers forward a `string | null` result field. */
  kill(pid: number, signal?: string | number | null): true;
  env: { [name: string]: string | undefined };
  /* `never`, like @types/node: code behind an early-exit guard narrows
   * (`if (!x) process.exit(1)` proves x afterwards) — typed `void` the
   * guard narrows nothing and correct programs fail preflight. The
   * lowering already handles the optional code (bare exit() is exit(0),
   * Node's behavior when exitCode was never set). */
  exit(code?: number | null): never;
  cwd(): string;
  /* The user tick queue: callbacks run before promise jobs at every loop
   * checkpoint (Node's tick-then-microtask order); trailing arguments
   * pass to the callback at fire time, like Node. */
  nextTick(callback: (...args: any[]) => void, ...args: any[]): void;
  /* The process introspection statics — Node's shapes and units. */
  uptime(): number;
  cpuUsage(previousValue?: NodeJS.CpuUsage): NodeJS.CpuUsage;
  threadCpuUsage(previousValue?: NodeJS.CpuUsage): NodeJS.CpuUsage;
  resourceUsage(): NodeJS.ResourceUsage;
  availableMemory(): number;
  constrainedMemory(): number;
  /* The loop's own bookkeeping: 'Timeout' per armed timer, 'Immediate'
   * per queued unfired immediate; unmodeled kinds absent (SEMANTICS.md). */
  getActiveResourcesInfo(): string[];
  /* The raw byte writes — no newline, no formatting. stdout shares
   * console.log's stream, each call is submitted promptly, and ordering is
   * preserved. The boolean is Node's backpressure signal — these synchronous
   * writes always return true. Static BufferEncoding arguments and the
   * completion callback overloads match Node's WritableStream surface. */
  stdout: {
    write(data: string | Uint8Array, callback?: (error?: Error | null) => void): boolean;
    write(data: string | Uint8Array, encoding: BufferEncoding, callback?: (error?: Error | null) => void): boolean;
    readonly isTTY: boolean;
  };
  stderr: {
    write(data: string | Uint8Array, callback?: (error?: Error | null) => void): boolean;
    write(data: string | Uint8Array, encoding: BufferEncoding, callback?: (error?: Error | null) => void): boolean;
    readonly isTTY: boolean;
  };
  /* The stdin stream, the piped-input slice: the TTY probe, the
   * data/end/error events (on and once — a 'data' listener keeps the
   * event loop alive until EOF, like Node's flowing stdin), destroy()
   * (full teardown: nothing fires after, the loop stops waiting), and
   * async iteration (`for await (const chunk of process.stdin)` — chunks
   * are Uint8Array values, ending at EOF). setEncoding has no lowering
   * (chunks stay bytes; decode with TextDecoder). */
  stdin: {
    readonly isTTY: boolean;
    on(event: "data", listener: (chunk: Uint8Array) => void): void;
    on(event: "end", listener: () => void): void;
    on(event: "error", listener: (err: Error) => void): void;
    once(event: "data", listener: (chunk: Uint8Array) => void): void;
    once(event: "end", listener: () => void): void;
    once(event: "error", listener: (err: Error) => void): void;
    destroy(): void;
    setEncoding(encoding: "utf8"): void;
    /* Termios raw mode on a TTY stdin (libuv's UV_TTY_MODE_RAW, the mode
     * Node applies); on a NON-TTY stdin the member does not exist in Node
     * and the call throws Node's exact catchable TypeError. Node returns
     * `this` for chaining; here the call is statement-position only. */
    setRawMode(mode: boolean): void;
    [Symbol.asyncIterator](): AsyncIterableIterator<Uint8Array>;
  };
  /* Process events, the CLI slice: SIGINT/SIGTERM handlers (watching a
   * signal replaces its default disposition; removing the last listener
   * restores it; signal listeners never keep the loop alive — all Node's
   * rules) and the 'exit' hook (runs synchronously at termination with
   * the exit code; scheduling anything from it is too late, like Node).
   * `once` auto-removes after the first delivery; `off` removes by
   * listener identity — bind the listener to a const so registration and
   * removal see the same value. */
  on(event: "SIGINT" | "SIGTERM", listener: () => void): void;
  on(event: "exit", listener: (code: number) => void): void;
  /* 'warning' — Node's process-warning channel: listeners receive the
   * warning Error (as a dyn value); emitWarning and the runtime's
   * deprecation sites dispatch synchronously (SEMANTICS.md). */
  on(event: "warning", listener: (warning: Error & { code?: string }) => void): void;
  /* 'unhandledRejection' — dispatched per never-observed rejection at
   * the completed nextTick/microtask checkpoint (reason, promise),
   * suppressing the default report. 'rejectionHandled' — the sibling
   * event, fired once when a delivered promise later gains a handler
   * (promise payload, Node's shape). */
  on(event: "unhandledRejection", listener: (reason: unknown, promise: unknown) => void): void;
  on(event: "rejectionHandled", listener: (promise: unknown) => void): void;
  once(event: "SIGINT" | "SIGTERM", listener: () => void): void;
  once(event: "exit", listener: (code: number) => void): void;
  once(event: "unhandledRejection", listener: (reason: unknown, promise: unknown) => void): void;
  once(event: "rejectionHandled", listener: (promise: unknown) => void): void;
  off(event: "SIGINT" | "SIGTERM", listener: () => void): void;
  off(event: "exit", listener: (code: number) => void): void;
  off(event: "warning", listener: (warning: Error & { code?: string }) => void): void;
  off(event: "unhandledRejection", listener: (reason: unknown, promise: unknown) => void): void;
  off(event: "rejectionHandled", listener: (promise: unknown) => void): void;
  /* removeListener IS off — Node aliases them; both lower identically. */
  removeListener(event: "SIGINT" | "SIGTERM", listener: () => void): void;
  removeListener(event: "exit", listener: (code: number) => void): void;
  removeListener(event: "warning", listener: (warning: Error & { code?: string }) => void): void;
  removeListener(event: "unhandledRejection", listener: (reason: unknown, promise: unknown) => void): void;
  removeListener(event: "rejectionHandled", listener: (promise: unknown) => void): void;
  /* emitWarning — Node's full grammar (string or Error warning; type/
   * ctor/options second; code/ctor third). */
  emitWarning(warning: string | Error, ...args: any[]): void;
};

/* ── globals a real CLI's sources reference (all @types/node or dyn-lib
 * territory; the fallback declares the slice so projects PREFLIGHT and
 * every reached use lands on the SC2020 fence — or a real lowering where
 * one exists — instead of "Cannot find name"). With @types/node these
 * stand down with the rest of the file. ─────────────────────────────── */

/* The CommonJS module globals. `__dirname`/`__filename` are compile-time
 * constants — each MODULE's real directory/file path (Node's per-module
 * values exactly; the build machine's paths are baked in, which is also
 * what Node answers when the same tree runs in place). In a file with ESM
 * syntax they fence: Node throws ReferenceError there. */
declare var __dirname: string;
declare var __filename: string;

/* `global` IS globalThis (Node's alias), and `declare var process` above
 * puts process on `typeof globalThis` — so `globalThis.process` and
 * `global.process` read the same object as the bare name. */
declare var global: typeof globalThis;

/* The `require` VALUE's non-call surface. require() CALLS are module
 * edges (the checker models them as imports); the object's own members
 * are declared here so harness idioms typecheck. `require.main` lowers
 * to the ENTRY module's record ({ filename } — a compiled binary's main
 * module is always the entry, Node's answer for a directly-run script);
 * the rest fences per site. */
declare var require: {
  /* The call signature types NON-IMPORT-SHAPED require expressions (the
   * checker models import-shaped requires as module aliases regardless,
   * exactly like under @types/node's NodeRequire). `any`, like
   * @types/node: the value's home is the module system, not the static
   * value model — reached uses fence per site. */
  (id: string): any;
  main: { filename: string } | undefined;
  resolve(id: string): string;
  cache: { [id: string]: unknown };
};

/* setImmediate/clearImmediate — Node's macrotask pair (fires after I/O
 * events of the current loop turn, before timers due later). The handle
 * follows the Timeout pattern: loop-liveness bookkeeping. */
interface Immediate {
  ref(): Immediate;
  unref(): Immediate;
  hasRef(): boolean;
}
declare function setImmediate(callback: () => void): Immediate;
/* The trailing-argument form — Node passes the extras to the callback. */
declare function setImmediate(callback: (...args: never[]) => void, ...args: unknown[]): Immediate;
declare function clearImmediate(handle?: Immediate | null | undefined): void;

/* queueMicrotask — the microtask queue (the promise-continuation queue:
 * runs before any timer/immediate/I/O callback scheduled later). */
declare function queueMicrotask(callback: () => void): void;

/* structuredClone — the JSON-safe + bytes subset clones deep (cycles
 * fence; functions throw the spec's DataCloneError; DOMException clones
 * per WebIDL serialization). `value` is optional and `options` is
 * `unknown` so Node's own RUNTIME errors fire (ERR_MISSING_ARGS for the
 * zero-argument call, the dictionary/sequence TypeErrors for bad
 * options) where a tighter signature would reject at compile time —
 * the suite exercises exactly those. */
declare function structuredClone<T = undefined>(value?: T, options?: unknown): T;

/* AbortController — the signal factory for the fetch-cancellation slice
 * (AbortSignal above). */
interface AbortController {
  readonly signal: AbortSignal;
  abort(reason?: unknown): void;
}
declare var AbortController: { new (): AbortController };

/* atob/btoa — Node globals since v16 (the "buffer" module re-exports
 * them below): base64 → binary string and back, Latin-1 domain like the
 * WHATWG originals. The parameter is `unknown` because WebIDL ToStrings
 * whatever arrives (Node's atob(null) decodes "null") — the coercion
 * runs in the runtime over the dyn kind, and the Node suite exercises
 * it; malformed input throws the catchable DOMException
 * InvalidCharacterError, the zero-argument call Node's TypeError
 * [ERR_MISSING_ARGS]. */
declare function atob(data?: unknown): string;
declare function btoa(data?: unknown): string;

/* DOMException — the web-standard error shape (a Node global since
 * v17): an Error subclass whose `code` is the WebIDL legacy NUMBER
 * (InvalidCharacterError = 5, 0 for off-table names) and whose options
 * form carries `cause`. `new DOMException(msg)` has name "Error" like
 * the spec's default. Subclassing is fenced (the runtime layout carries
 * hidden slots) — extend Error instead. */
interface DOMException extends Error {
  readonly code: number;
}
declare var DOMException: {
  new (message?: unknown, nameOrOptions?: unknown): DOMException;
  readonly prototype: DOMException;
};

/* Capability-gated globals harness code probes behind feature guards
 * (globalThis.crypto under a hasCrypto check, the SQLite-backed storage
 * pair): typed `unknown` — no lowering exists, the guard is expected to
 * be false in a compiled binary, and any reached use fences per site. */
declare var crypto: unknown;
declare var Crypto: unknown;
declare var CryptoKey: unknown;
declare var SubtleCrypto: unknown;
declare var localStorage: unknown;
declare var sessionStorage: unknown;

/* Node's Buffer, typed as a Uint8Array subtype with the members CLI code
 * touches — ONE runtime representation with Uint8Array (the u8 bytes
 * kind); the members beyond the lowered surface fence per site. */
/* Node's encoding-name union (aliases included — the compiler folds them
 * to the runtime's canonical spellings at the call site). */
type BufferEncoding =
  | "utf8"
  | "utf-8"
  | "hex"
  | "base64"
  | "base64url"
  | "latin1"
  | "ascii"
  | "binary"
  | "utf16le"
  | "utf-16le"
  | "ucs2"
  | "ucs-2";
interface Buffer<TArrayBuffer extends ArrayBufferLike = ArrayBufferLike> extends Uint8Array<TArrayBuffer> {
  toString(encoding?: BufferEncoding, start?: number, end?: number): string;
  equals(otherBuffer: Uint8Array): boolean;
  compare(target: Uint8Array, targetStart?: number, targetEnd?: number, sourceStart?: number, sourceEnd?: number): number;
  indexOf(value: string | number | Uint8Array, byteOffset?: number | BufferEncoding, encoding?: BufferEncoding): number;
  lastIndexOf(value: string | number | Uint8Array, byteOffset?: number | BufferEncoding, encoding?: BufferEncoding): number;
  includes(value: string | number | Buffer, byteOffset?: number | BufferEncoding, encoding?: BufferEncoding): boolean;
  fill(value: string | number | Uint8Array, offset?: number | BufferEncoding, end?: number | BufferEncoding, encoding?: BufferEncoding): this;
  copy(target: Uint8Array, targetStart?: number, sourceStart?: number, sourceEnd?: number): number;
  swap16(): Buffer;
  swap32(): Buffer;
  swap64(): Buffer;
  write(string: string, offset?: number | BufferEncoding, length?: number | BufferEncoding, encoding?: BufferEncoding): number;
  subarray(start?: number, end?: number): Buffer<TArrayBuffer>;
  /* @types/node's spelling — the ArrayBuffer instantiation keeps the
   * override compatible with the lib's Uint8Array.slice. */
  slice(start?: number, end?: number): Buffer<ArrayBuffer>;
  writeUInt8(value: number, offset?: number): number;
  writeUInt16BE(value: number, offset?: number): number;
  writeUInt16LE(value: number, offset?: number): number;
  writeUInt32BE(value: number, offset?: number): number;
  writeUInt32LE(value: number, offset?: number): number;
  writeInt8(value: number, offset?: number): number;
  writeInt16BE(value: number, offset?: number): number;
  writeInt16LE(value: number, offset?: number): number;
  writeInt32BE(value: number, offset?: number): number;
  writeInt32LE(value: number, offset?: number): number;
  writeFloatBE(value: number, offset?: number): number;
  writeFloatLE(value: number, offset?: number): number;
  writeDoubleBE(value: number, offset?: number): number;
  writeDoubleLE(value: number, offset?: number): number;
  writeUIntBE(value: number, offset: number, byteLength: number): number;
  writeUIntLE(value: number, offset: number, byteLength: number): number;
  writeIntBE(value: number, offset: number, byteLength: number): number;
  writeIntLE(value: number, offset: number, byteLength: number): number;
  readUInt8(offset?: number): number;
  readUInt16BE(offset?: number): number;
  readUInt16LE(offset?: number): number;
  readUInt32BE(offset?: number): number;
  readUInt32LE(offset?: number): number;
  readInt8(offset?: number): number;
  readInt16BE(offset?: number): number;
  readInt16LE(offset?: number): number;
  readInt32BE(offset?: number): number;
  readInt32LE(offset?: number): number;
  readFloatBE(offset?: number): number;
  readFloatLE(offset?: number): number;
  readDoubleBE(offset?: number): number;
  readDoubleLE(offset?: number): number;
  readUIntBE(offset: number, byteLength: number): number;
  readUIntLE(offset: number, byteLength: number): number;
  readIntBE(offset: number, byteLength: number): number;
  readIntLE(offset: number, byteLength: number): number;
}
interface BufferConstructor {
  from(data: string, encoding?: BufferEncoding): Buffer;
  /* The ArrayBuffer form is the VIEW construction: x.buffer with an
   * optional byte offset/length shares x's storage (the subarray rule). */
  from(data: ArrayBuffer, byteOffset?: number, length?: number): Buffer;
  from(data: Uint8Array | readonly number[]): Buffer;
  alloc(size: number, fill?: string | number | Uint8Array, encoding?: BufferEncoding): Buffer;
  compare(buf1: Uint8Array, buf2: Uint8Array): number;
  /* alloc without the zero-fill guarantee — the lowering zero-fills
   * anyway (never handing out uninitialized memory costs one memset). */
  allocUnsafe(size: number): Buffer;
  concat(list: readonly Uint8Array[], totalLength?: number): Buffer;
  isBuffer(obj: unknown): obj is Buffer;
  byteLength(input: string | Uint8Array, encoding?: BufferEncoding): number;
  isEncoding(encoding: string): boolean;
}
declare var Buffer: BufferConstructor;

/* The WHATWG encoders (Node globals). The COMPOSED forms lower —
 * `new TextEncoder().encode(s)` and `new TextDecoder().decode(bytes)` —
 * as do same-scope const store-then-call forms. Recognized literal WHATWG
 * labels compile statically; runtime-valued/unknown labels and the
 * fatal/ignoreBOM options fence at the use site). */
interface TextEncoder {
  encode(input?: string): Uint8Array;
}
declare var TextEncoder: { new (): TextEncoder };
interface TextDecoder {
  decode(input?: ArrayBufferView | ArrayBuffer): string;
}
declare var TextDecoder: { new (label?: string): TextDecoder };

/* The WHATWG event surface (Node globals since v15): declared so the
 * suite's event-plumbing tests typecheck and fence per SITE with the
 * member's own name. The dynamic island's web prelude implements
 * Event/CustomEvent/EventTarget/DOMException/AbortController for real;
 * the static tier has no lowering yet — construction and members fence
 * honestly (SC2020). */
interface Event {
  readonly type: string;
  readonly bubbles: boolean;
  readonly cancelable: boolean;
  readonly composed: boolean;
  readonly defaultPrevented: boolean;
  readonly eventPhase: number;
  readonly target: EventTarget | null;
  readonly currentTarget: EventTarget | null;
  readonly srcElement: EventTarget | null;
  readonly isTrusted: boolean;
  readonly timeStamp: number;
  cancelBubble: boolean;
  returnValue: boolean;
  preventDefault(): void;
  stopPropagation(): void;
  stopImmediatePropagation(): void;
  composedPath(): unknown[];
}
declare var Event: {
  new (type: string, eventInitDict?: { bubbles?: boolean; cancelable?: boolean; composed?: boolean }): Event;
  readonly prototype: Event;
  readonly NONE: 0;
  readonly CAPTURING_PHASE: 1;
  readonly AT_TARGET: 2;
  readonly BUBBLING_PHASE: 3;
};
interface CustomEvent<T = unknown> extends Event {
  readonly detail: T;
}
declare var CustomEvent: {
  new <T = unknown>(type: string, eventInitDict?: { detail?: T; bubbles?: boolean; cancelable?: boolean; composed?: boolean }): CustomEvent<T>;
  readonly prototype: CustomEvent;
};
interface MessageEvent<T = unknown> extends Event {
  readonly data: T;
  readonly origin: string;
  readonly lastEventId: string;
  readonly ports: readonly MessagePort[];
}
declare var MessageEvent: {
  new <T = unknown>(type: string, eventInitDict?: { data?: T; origin?: string; lastEventId?: string }): MessageEvent<T>;
  readonly prototype: MessageEvent;
};
interface AddEventListenerOptions {
  capture?: boolean;
  once?: boolean;
  passive?: boolean;
  signal?: AbortSignal;
}
interface EventTarget {
  addEventListener(
    type: string,
    listener: ((event: Event) => void) | { handleEvent(event: Event): void } | null,
    options?: AddEventListenerOptions | boolean,
  ): void;
  removeEventListener(
    type: string,
    listener: ((event: Event) => void) | { handleEvent(event: Event): void } | null,
    options?: { capture?: boolean } | boolean,
  ): void;
  dispatchEvent(event: Event): boolean;
}
declare var EventTarget: {
  new (): EventTarget;
  readonly prototype: EventTarget;
};

/* MessagePort/MessageChannel — the worker_threads pair Node exposes as
 * globals (v15+). The island's worker_threads shim implements the
 * same-thread subset (postMessage delivers structured-clone copies on a
 * microtask); the web prelude exposes the classes as engine globals.
 * Statically declared-not-lowered: per-site fences. */
interface MessagePort extends EventTarget {
  postMessage(value: unknown, transferOrOptions?: unknown): void;
  start(): void;
  close(): void;
  ref(): void;
  unref(): void;
  onmessage: ((event: MessageEvent) => void) | null;
  onmessageerror: ((event: MessageEvent) => void) | null;
  onclose: ((event: Event) => void) | null;
}
declare var MessagePort: {
  readonly prototype: MessagePort;
};
interface MessageChannel {
  readonly port1: MessagePort;
  readonly port2: MessagePort;
}
declare var MessageChannel: {
  new (): MessageChannel;
  readonly prototype: MessageChannel;
};

/* AbortSignal, the native fetch-cancellation slice. The three statics,
 * state/reason reads, throwIfAborted, and abort listeners all lower in
 * static builds; dynamic builds use the island's Web implementation. */
interface AbortSignal extends EventTarget {
  readonly aborted: boolean;
  readonly reason: unknown;
  onabort: ((event: Event) => void) | null;
  throwIfAborted(): void;
}
declare var AbortSignal: {
  timeout(ms: number): AbortSignal;
  abort(reason?: unknown): AbortSignal;
  any(signals: readonly AbortSignal[]): AbortSignal;
  readonly prototype: AbortSignal;
};

interface ReadableStreamReadValueResult<T> {
  done: false;
  value: T;
}
interface ReadableStreamReadDoneResult<T> {
  done: true;
  value: T | undefined;
}
type ReadableStreamReadResult<T> =
  | ReadableStreamReadValueResult<T>
  | ReadableStreamReadDoneResult<T>;
interface ReadableStreamDefaultReader<T = unknown> {
  readonly closed: Promise<void>;
  read(): Promise<ReadableStreamReadResult<T>>;
  cancel(reason?: unknown): Promise<void>;
  releaseLock(): void;
}
interface ReadableStreamDefaultController<T = unknown> {
  readonly desiredSize: number | null;
  enqueue(chunk?: T): void;
  close(): void;
  error(reason?: unknown): void;
}
interface UnderlyingSource<T = unknown> {
  start?(controller: ReadableStreamDefaultController<T>): unknown;
  pull?(controller: ReadableStreamDefaultController<T>): unknown;
  cancel?(reason?: unknown): unknown;
}
interface ReadableStream<T = unknown> {
  readonly locked: boolean;
  cancel(reason?: unknown): Promise<void>;
  getReader(): ReadableStreamDefaultReader<T>;
}
declare var ReadableStream: {
  new <T = unknown>(source?: UnderlyingSource<T>): ReadableStream<T>;
  from<T>(iterable: readonly T[]): ReadableStream<T>;
  from(iterable: Uint8Array): ReadableStream<number>;
  from(iterable: string): ReadableStream<string>;
  readonly prototype: ReadableStream<unknown>;
};

/* fetch, typed as the native JSON + readable-stream slice: one URL, an
 * optional init with the members CLI requests carry, and a Response
 * whose body is the same stream consumed by json(). json() returns
 * unknown — the same dynamic boundary as JSON.parse: cast and validate. */
/* Headers — a response's native header map (lowercase names,
 * combine-on-append, sorted iteration). The value is a checked-dynamic
 * native handle like Response itself; constructing one statically
 * (`new Headers()`) keeps the constructor fence. */
interface Headers {
  append(name: string, value: string): void;
  delete(name: string): void;
  get(name: string): string | null;
  getSetCookie(): string[];
  has(name: string): boolean;
  set(name: string, value: string): void;
  forEach(
    callbackfn: (value: string, key: string, parent: Headers) => void,
    thisArg?: unknown,
  ): void;
  [Symbol.iterator](): IterableIterator<[string, string]>;
}
declare var Headers: {
  new (init?: Record<string, string> | readonly (readonly [string, string])[]): Headers;
  readonly prototype: Headers;
};
interface Response {
  readonly ok: boolean;
  readonly status: number;
  readonly statusText: string;
  readonly url: string;
  readonly redirected: boolean;
  readonly headers: Headers;
  readonly body: ReadableStream<Uint8Array> | null;
  readonly bodyUsed: boolean;
  json(): Promise<unknown>;
  text(): Promise<string>;
  /* The whole body as bytes: bytes() answers a Uint8Array in both tiers.
   * arrayBuffer() remains dynamic-only because static programs have no
   * free-standing ArrayBuffer representation; the compiler diagnoses its
   * direct use and points at bytes(). */
  arrayBuffer(): Promise<ArrayBuffer>;
  bytes(): Promise<Uint8Array>;
}
interface ResponseInit {
  headers?:
    | Headers
    | Record<string, string>
    | readonly (readonly [string, string])[];
  status?: number;
  statusText?: string;
}
declare var Response: {
  new (
    body?: string | Uint8Array | ReadableStream<Uint8Array> | null,
    init?: ResponseInit,
  ): Response;
  readonly prototype: Response;
  error(): Response;
  json(data: unknown, init?: ResponseInit): Response;
  redirect(url: string | URL, status?: number): Response;
};
interface Request {
  readonly method: string;
  readonly url: string;
  readonly headers: Headers;
  readonly signal: AbortSignal;
  readonly body: ReadableStream<Uint8Array> | null;
  readonly bodyUsed: boolean;
  json(): Promise<unknown>;
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
  bytes(): Promise<Uint8Array>;
}
interface RequestInit {
  method?: string;
  headers?:
    | Headers
    | Record<string, string>
    | readonly (readonly [string, string])[];
  body?: string | Uint8Array | ReadableStream<Uint8Array> | null;
  duplex?: "half";
  redirect?: "follow" | "error" | "manual";
  signal?: AbortSignal;
}
declare var Request: {
  new (input: string | URL | Request, init?: RequestInit): Request;
  readonly prototype: Request;
};
declare function fetch(input: string | URL, init?: RequestInit): Promise<Response>;

/* The repeating timer pair (setTimeout lives in scriptc.d.ts — always
 * shipped). The handle is the Timeout interface, like Node's — it maps to
 * the numeric timer id, so ReturnType<typeof setInterval> stays a
 * representable type and `.unref()/.ref()/.hasRef()/.refresh()` chain over
 * setInterval results exactly like setTimeout's. clearInterval keeps the
 * historic number arm (the id IS the handle) alongside Node's undefined
 * tolerance. */
declare function setInterval(callback: () => void, ms?: number): Timeout;
/* The trailing-argument form — setTimeout's exact story, every tick. */
declare function setInterval(callback: (...args: never[]) => void, ms?: number, ...args: unknown[]): Timeout;
declare function clearInterval(handle?: Timeout | number | null | undefined): void;

/* node:timers — the module twins of the timer globals (Node's timers
 * module re-exports them: require('timers').setTimeout IS setTimeout).
 * Named imports, destructured requires, and namespace calls all lower to
 * the same libCalls as the globals; the surface beyond these six
 * (enroll/unenroll, promises) fences per member. */
declare module "node:timers" {
  export function setTimeout(callback: () => void, ms?: number): Timeout;
  export function setTimeout(callback: (...args: never[]) => void, ms?: number, ...args: unknown[]): Timeout;
  export function clearTimeout(handle?: Timeout | number | null | undefined): void;
  export function setInterval(callback: () => void, ms?: number): Timeout;
  export function setInterval(callback: (...args: never[]) => void, ms?: number, ...args: unknown[]): Timeout;
  export function clearInterval(handle?: Timeout | number | null | undefined): void;
  export function setImmediate(callback: () => void): Immediate;
  export function setImmediate(callback: (...args: never[]) => void, ...args: unknown[]): Immediate;
  export function clearImmediate(handle?: Immediate | null | undefined): void;
}
declare module "timers" {
  export * from "node:timers";
}

/* node:timers/promises — the promisified pair the Node test harness leans
 * on (`await setTimeout(ms)` as a sleep). setTimeout's delay-only form and
 * setImmediate's bare form lower (a void promise the shared timer heap
 * settles); the resolve-value, options (AbortSignal), and setInterval
 * async-iterator forms are declared surface that fences per site. */
declare module "node:timers/promises" {
  export function setTimeout(delay?: number): Promise<void>;
  export function setImmediate(): Promise<void>;
  export function setInterval(delay?: number, value?: unknown, options?: unknown): unknown;
  export const scheduler: {
    wait(delay?: number): Promise<void>;
    yield(): Promise<void>;
  };
}
declare module "timers/promises" {
  export * from "node:timers/promises";
}

/* node:diagnostics_channel — the in-process pub/sub core: named channels,
 * subscribe/unsubscribe (module-level and channel-level), publish with any
 * dyn-convertible message. Channel values are f64 handles into the
 * runtime's channel registry (the readline.Interface precedent — channels
 * are process-lived in Node too, its WeakRef machinery aside).
 * The store-binding surface (bindStore/unbindStore/runStores) lowers onto
 * the AsyncLocalStorage integration (dc.chan* libCalls).
 *
 * TracingChannel (tracingChannel) is the five-event-channel collection:
 * an f64 handle into the runtime's tracing registry (type-mapper.ts maps the
 * name like Channel). subscribe/unsubscribe walk a handlers object;
 * traceSync/traceCallback run Node's publish choreography in the runtime
 * (context defaults to a fresh {}); tracePromise is declared (the member
 * exists in Node) but fences at the call site — the traced function's
 * promise cannot cross the checked-dynamic tree boundary yet. */
declare module "node:diagnostics_channel" {
  export type ChannelListener = (message: unknown, name: string) => void;
  export interface Channel {
    readonly name: string;
    readonly hasSubscribers: boolean;
    publish(message: unknown): void;
    subscribe(onMessage: ChannelListener): void;
    unsubscribe(onMessage: ChannelListener): boolean;
    bindStore(store: import("async_hooks").AsyncLocalStorage<any>, transform?: (context: any) => any): void;
    unbindStore(store: import("async_hooks").AsyncLocalStorage<any>): boolean;
    runStores(context: unknown, fn: (...args: any[]) => any, thisArg?: any, ...args: any[]): any;
  }
  export function channel(name: string): Channel;
  export function subscribe(name: string, onMessage: ChannelListener): void;
  export function unsubscribe(name: string, onMessage: ChannelListener): boolean;
  export function hasSubscribers(name: string): boolean;
  export interface TracingChannelSubscribers {
    start?: (message: any) => void;
    end?: (message: any) => void;
    asyncStart?: (message: any) => void;
    asyncEnd?: (message: any) => void;
    error?: (message: any) => void;
  }
  export interface TracingChannelCollection {
    start: Channel;
    end: Channel;
    asyncStart: Channel;
    asyncEnd: Channel;
    error: Channel;
  }
  export interface TracingChannel {
    start: Channel;
    end: Channel;
    asyncStart: Channel;
    asyncEnd: Channel;
    error: Channel;
    readonly hasSubscribers: boolean;
    subscribe(subscribers: TracingChannelSubscribers): void;
    /** True when every present handler was found and removed (Node's
     * all-found conjunction; @types/node under-declares this as void). */
    unsubscribe(subscribers: TracingChannelSubscribers): boolean;
    traceSync<ThisArg = any, Args extends any[] = any[], Result = any>(
      fn: (this: ThisArg, ...args: Args) => Result,
      context?: object,
      thisArg?: ThisArg,
      ...args: Args
    ): Result;
    tracePromise<ThisArg = any, Args extends any[] = any[], Result = any>(
      fn: (this: ThisArg, ...args: Args) => Promise<Result>,
      context?: object,
      thisArg?: ThisArg,
      ...args: Args
    ): Promise<Result>;
    traceCallback<ThisArg = any, Args extends any[] = any[], Result = any>(
      fn: (this: ThisArg, ...args: Args) => Result,
      position?: number,
      context?: object,
      thisArg?: ThisArg,
      ...args: Args
    ): Result;
  }
  export function tracingChannel(nameOrChannels: string | TracingChannelCollection): TracingChannel;
}
declare module "diagnostics_channel" {
  export * from "node:diagnostics_channel";
}

/* node:perf_hooks — performance.now() over the runtime's process-start-
 * anchored monotonic clock (Node's timeOrigin for a compiled program),
 * fractional milliseconds. The .bind(performance) spelling lowers to the
 * same clock as a plain () => number function value (the mockable-clock idiom's
 * getTimestamp); everything else fences per member. */
declare module "node:perf_hooks" {
  export interface Performance {
    now(): number;
  }
  export const performance: Performance;
}
declare module "perf_hooks" {
  export * from "node:perf_hooks";
}
/* Node also exposes the same performance object as a GLOBAL (no import
 * needed) — the module export and the global are one value, so the global
 * spelling lowers through the identical perf_hooks tables (name +
 * provenance, like console/process). With @types/node present this file
 * stands down and its wider global serves; the lowered surface stays
 * performance.now() either way. */
declare var performance: import("node:perf_hooks").Performance;

/* node:module. createRequire's lowered shape is the version/config-
 * reading pattern real CLIs ship: a const binding over
 * createRequire(import.meta.url) (or __filename) whose require calls
 * take STATIC string literals — the indirection erases at compile time.
 * A builtin spec makes the binding a namespace import in const clothing;
 * a relative .json document bakes and parses (JSON.parse's `unknown`
 * stance — validate with a checked cast); an installed npm package loads
 * through the island's require-condition entry under --dynamic; a bare
 * name nothing installed resolves compiles to Node's catchable
 * MODULE_NOT_FOUND throw (the optional-dependency try/require pattern).
 * Dynamic specifiers fence: a compiled binary's module graph is fixed at
 * build time. builtinModules is the baked Node v24 list (a fresh
 * mutable array per read where Node ships one frozen singleton);
 * isBuiltin and syncBuiltinESMExports fence per site. Both spellings
 * name the builtin, like in Node (the builtin wins over the npm package
 * named "module" for the bare specifier there too). */
declare module "node:module" {
  export function createRequire(filename: string | URL): (id: string) => unknown;
  export const builtinModules: string[];
  export function isBuiltin(moduleName: string): boolean;
  export function syncBuiltinESMExports(): void;
}
declare module "module" {
  export * from "node:module";
}
/* import.meta: module-loader metadata with no value representation —
 * every read fences (SC1090) EXCEPT as createRequire's base, where it
 * only NAMES the containing file (import.meta.url, import.meta.filename,
 * and __filename all mean "this file" there). Declared so the pattern
 * typechecks under the fallback surface; @types/node's own augmentation
 * stands in when adopted. */
interface ImportMeta {
  url: string;
  filename: string;
  dirname: string;
}

/* The synchronous node:fs surface — utf8-only, no options objects, no
 * Buffers. Importing "node:fs" resolves here (preflight allowlists exactly
 * the ambient-declared node: modules); every function lowers to a `libCall`
 * with a scr_fs_* runtime implementation. Failures throw CATCHABLE string
 * values formatted like Node's error messages ("ENOENT: no such file or
 * directory, open 'x'"). `rmSync` removes FILES only (like Node without
 * `recursive`); empty directories go through `rmdirSync`. */
declare module "node:fs" {
  /* The lowered forms first. The string-encoding overload's result is
   * CONDITIONAL so a runtime encoding value (an untyped JS parameter —
   * test/common fixtures.js's readFixtureKey(name, enc)) infers `any`
   * (the lowering dispatches at runtime: undefined/null read Buffers,
   * utf8 a string, anything else throws) while a literal utf8 keeps the
   * string result TypeScript callers chain on. The encoding-less
   * overload is the Buffer read. */
  export function readFileSync<T extends string>(
    path: string,
    encoding: T,
  ): T extends "utf8" ? string : T extends "utf-8" ? string : any;
  export function readFileSync(path: string): Buffer;
  /* The file-descriptor forms — a read(2) loop to EOF from the current
   * position; the stdin pattern is readFileSync(0, "utf8"). */
  export function readFileSync(fd: number, encoding: "utf8" | "utf-8"): string;
  export function readFileSync(fd: number): Buffer;
  /* The options-object spelling of the utf8 form. */
  export function readFileSync(path: string, options: { encoding: "utf8" | "utf-8" }): string;
  /* The options form carries the mode (applied at CREATION only, like
   * Node — an existing file keeps its permissions) and/or the utf8
   * encoding spelling. */
  export function writeFileSync(
    path: string,
    data: string,
    /* The options-record stance (see http.RequestOptions): flag fences
     * by name at the call site; undocumented keys drop like Node. */
    options?: { mode?: number; encoding?: "utf8" | "utf-8"; flag?: string; [option: string]: unknown },
  ): void;
  /* The bare-encoding spelling — the options record's encoding key alone. */
  export function writeFileSync(path: string, data: string, encoding: "utf8" | "utf-8"): void;
  export function writeFileSync(path: string, data: Uint8Array): void;
  export function appendFileSync(path: string, data: string): void;
  export function existsSync(path: string): boolean;
  export function mkdirSync(path: string): void;
  export function mkdirSync(path: string, options: { recursive?: boolean; mode?: number }): void;
  export function unlinkSync(path: string): void;
  export function chmodSync(path: string, mode: number): void;
  export function chownSync(path: string, uid: number, gid: number): void;
  /* The 2-argument form only (Node's mode flags have no lowering). The
   * destination is created or truncated carrying the SOURCE's mode. */
  export function copyFileSync(src: string, dest: string): void;
  export function rename(oldPath: string, newPath: string, callback: (err: NodeJS.ErrnoException | null) => void): void;
  export function renameSync(oldPath: string, newPath: string): void;
  export function rmSync(path: string): void;
  /* maxRetries/retryDelay are accepted no-ops (Node retries around
   * EBUSY-class races; the synchronous lowering has no re-entrancy that
   * needs them). */
  export function rmSync(path: string, options: { recursive?: boolean; force?: boolean; maxRetries?: number; retryDelay?: number }): void;
  export function rmdirSync(path: string): void;
  export function readdirSync(path: string): string[];
  /* The withFileTypes form: Dirent rows (name + parentPath + the type
   * probes — the honest subset of Node's Dirent surface). The type is
   * interned explicitly in type-mapper.ts (the record's hidden %dtype field
   * carries the entry kind; isFile/isDirectory/isSymbolicLink lower as
   * reads of it in lower-builtins.ts). */
  export interface Dirent {
    name: string;
    parentPath: string;
    isFile(): boolean;
    isDirectory(): boolean;
    isSymbolicLink(): boolean;
  }
  export function readdirSync(
    path: string,
    /* The options-record stance (see http.RequestOptions): recursive
     * fences by name at the call site; undocumented keys drop like Node. */
    options: { withFileTypes: true; recursive?: boolean; [option: string]: unknown },
  ): Dirent[];
  export function accessSync(path: string, mode?: number): void;
  export function mkdtempSync(prefix: string): string;
  export const constants: {
    readonly F_OK: number;
    readonly R_OK: number;
    readonly W_OK: number;
    readonly X_OK: number;
  };
  /* A stat(2) snapshot (statSync follows symlinks, lstatSync does not —
   * Node's split) — immutable; the supported surface is exactly these
   * members. blocks is the allocated size in 512-byte units; the time
   * fields are milliseconds with their sub-second fractions. */
  export interface Stats {
    isFile(): boolean;
    isDirectory(): boolean;
    isSymbolicLink(): boolean;
    readonly size: number;
    readonly blocks: number;
    readonly nlink: number;
    readonly atimeMs: number;
    readonly mtimeMs: number;
  }
  export function statSync(path: string): Stats;
  export function lstatSync(path: string): Stats;
  /* The fd pair behind spawn's fd-stdio form: openSync(path, flags) →
   * the raw fd (string flags only — "r", "w", "a" and the +/x/s
   * variants), closeSync(fd). */
  export function openSync(path: string, flags: string): number;
  export function closeSync(fd: number): void;
  /* Read into a caller buffer from the fd's current position when position
   * is omitted/null, or from a numeric byte position without advancing the
   * fd. Answers the byte count, 0 at EOF. */
  export function readSync(fd: number, buffer: Uint8Array, offset: number, length: number, position?: number | null): number;
  /* Write a caller-buffer window, or a utf8 string, at the fd's current
   * position when position is omitted/null (advancing it), or at a numeric
   * byte position without advancing it. Answers the byte count. */
  export function writeSync(fd: number, buffer: Uint8Array, offset: number, length: number, position?: number | null): number;
  export function writeSync(fd: number, string: string, position?: number | null, encoding?: "utf8" | "utf-8"): number;
  /* statSync over an open fd — the same Stats snapshot. */
  export function fstatSync(fd: number): Stats;
  /* realpath(3) — resolves symlinks, `.`/`..`, throwing Node's fs error
   * shapes for missing paths. */
  export function realpathSync(path: string): string;
  /* statfs(2)/statvfs(3) — the filesystem-capacity snapshot (the fields
   * Node's statfsSync reports; bavail × bsize is the free-space probe). */
  export interface StatsFs {
    readonly type: number;
    readonly bsize: number;
    readonly blocks: number;
    readonly bfree: number;
    readonly bavail: number;
    readonly files: number;
    readonly ffree: number;
  }
  export function statfsSync(path: string): StatsFs;
  /* fs.watch — the file-watching slice (scr_watch.c, kqueue EVFILT_VNODE):
   * "rename"/"change" events on ONE path, watcher.close() to stop. The
   * listener takes zero parameters or the eventType string (the filename
   * parameter has no lowering); an open watcher keeps the loop alive. A
   * path that cannot be opened THROWS Node's fs error synchronously. */
  export interface FSWatcher {
    close(): void;
  }
  /* The options-record stance (see http.RequestOptions): persistent: true,
   * recursive: false, and encoding: "utf8" state the lowered behavior and
   * are accepted; persistent: false, recursive: true, and signal fence by
   * name at the call site; undocumented keys drop like Node. */
  export interface WatchOptions {
    persistent?: boolean;
    recursive?: boolean;
    encoding?: string;
    [option: string]: unknown;
  }
  export function watch(path: string, listener?: (eventType: string) => void): FSWatcher;
  export function watch(
    path: string,
    options: WatchOptions,
    listener?: (eventType: string) => void,
  ): FSWatcher;
  /* fs.promises IS the fs/promises module (Node's rule) — the namespace-
   * import form `fs.promises.readFile(...)` lowers through the same
   * fs/promises table as `import { readFile } from "node:fs/promises"`. */
  export const promises: typeof import("node:fs/promises");
}
/* Every builtin answers to BOTH specifier forms, like in Node: the bare
 * module re-exports its node:-prefixed twin (or holds the declarations
 * itself — one of the pair forwards). The lowerer recognizes members by
 * their import SPECIFIER, so both forms lower identically. */
declare module "fs" {
  export * from "node:fs";
}

/* fs/promises — the SAME synchronous operations behind already-settled
 * promises: success fulfills, failure REJECTS with the would-be thrown
 * error (catchable at the await, like Node). DOCUMENTED DIVERGENCE
 * (SEMANTICS.md): the syscall blocks the event loop, so I/O never
 * interleaves with timers or other fibers — observable only in concurrent
 * code. readFile is utf8-only, like readFileSync. */
declare module "fs/promises" {
  export interface FileReadResult<T extends Uint8Array> {
    bytesRead: number;
    buffer: T;
  }
  export interface FileWriteResult<T> {
    bytesWritten: number;
    buffer: T;
  }
  export interface FileHandle {
    readonly fd: number;
    close(): Promise<void>;
    read<T extends Uint8Array>(
      buffer: T,
      offset?: number | null,
      length?: number | null,
      position?: number | null,
    ): Promise<FileReadResult<T>>;
    write<T extends Uint8Array>(
      buffer: T,
      offset?: number | null,
      length?: number | null,
      position?: number | null,
    ): Promise<FileWriteResult<T>>;
    write(data: string, position?: number | null, encoding?: "utf8" | "utf-8" | null): Promise<FileWriteResult<string>>;
    readFile(options?: null): Promise<Buffer>;
    readFile(encoding: "utf8" | "utf-8"): Promise<string>;
    writeFile(data: string | Uint8Array, encoding?: "utf8" | "utf-8" | null): Promise<void>;
    appendFile(data: string | Uint8Array, encoding?: "utf8" | "utf-8" | null): Promise<void>;
    stat(): Promise<import("node:fs").Stats>;
  }
  export function open(path: string, flags?: string, mode?: number): Promise<FileHandle>;
  export function readFile(path: string, encoding: "utf8" | "utf-8"): Promise<string>;
  export function readFile(path: string): Promise<Buffer>;
  export function writeFile(
    path: string,
    data: string,
    options?: { mode?: number; encoding?: "utf8" | "utf-8"; flag?: string; [option: string]: unknown },
  ): Promise<void>;
  export function writeFile(path: string, data: string, encoding: "utf8" | "utf-8"): Promise<void>;
  export function mkdir(path: string, options?: { recursive?: boolean; mode?: number }): Promise<void>;
  export function readdir(path: string): Promise<string[]>;
  export function rm(path: string): Promise<void>;
  export function stat(path: string): Promise<import("node:fs").Stats>;
  export function unlink(path: string): Promise<void>;
  export function chmod(path: string, mode: number): Promise<void>;
  export function rename(oldPath: string, newPath: string): Promise<void>;
}
declare module "node:fs/promises" {
  export * from "fs/promises";
}

/* node:path — the TARGET platform's implementation (Node's rule): posix
 * on posix triples, path.win32 under a win32 triple, with the posix and
 * win32 namespaces answering their own platform anywhere. Every function
 * is a pure string algorithm matching Node's implementations
 * byte-for-byte; join/resolve are variadic like Node's. */
declare module "path" {
  export function join(...paths: string[]): string;
  export function resolve(...paths: string[]): string;
  export function normalize(path: string): string;
  export function dirname(path: string): string;
  export function basename(path: string, suffix?: string): string;
  export function extname(path: string): string;
  export function isAbsolute(path: string): boolean;
  export function relative(from: string, to: string): string;
  export function toNamespacedPath(path: string): string;
  /* The union @types/node declares: the bare module answers the TARGET
   * platform's value (a compile-time constant — "\\"/";" under a win32
   * triple, "/"/":" everywhere else). */
  export const sep: "\\" | "/";
  export const delimiter: ";" | ":";
  /* The platform-specific namespaces (real Node submodules too —
   * "node:path/posix" resolves). Each carries the FULL surface and
   * answers ITS platform's rules on any target, Node's own contract;
   * the bare module IS the target platform's implementation. */
  export const posix: typeof import("path/posix");
  export const win32: typeof import("path/win32");
}
declare module "node:path" {
  export * from "path";
}
declare module "path/posix" {
  export function join(...paths: string[]): string;
  export function resolve(...paths: string[]): string;
  export function normalize(path: string): string;
  export function dirname(path: string): string;
  export function basename(path: string, suffix?: string): string;
  export function extname(path: string): string;
  export function isAbsolute(path: string): boolean;
  export function relative(from: string, to: string): string;
  export function toNamespacedPath(path: string): string;
  export const sep: "/";
  export const delimiter: ":";
}
declare module "node:path/posix" {
  export * from "path/posix";
}
declare module "path/win32" {
  export function join(...paths: string[]): string;
  export function resolve(...paths: string[]): string;
  export function normalize(path: string): string;
  export function dirname(path: string): string;
  export function basename(path: string, suffix?: string): string;
  export function extname(path: string): string;
  export function isAbsolute(path: string): boolean;
  export function relative(from: string, to: string): string;
  export function toNamespacedPath(path: string): string;
  export const sep: "\\";
  export const delimiter: ";";
}
declare module "node:path/win32" {
  export * from "path/win32";
}

/* node:os — the slice a CLI needs: platform() (same implementation as
 * process.platform), homedir(), tmpdir() (Node's env cascade), EOL
 * (always "\n" — POSIX pinned, like path.sep), and networkInterfaces()
 * (getifaddrs(3); the interface shapes mirror @types/node's exactly so
 * both type worlds map to the same IR structure). */
declare module "os" {
  export function platform(): string;
  export function homedir(): string;
  export function tmpdir(): string;
  /* uname(2)'s release field — Node's own implementation. */
  export function release(): string;
  /* uname(2)'s sysname field ("Darwin", "Linux") — Node's os.type(). */
  export function type(): string;
  /* Total system memory in bytes (sysctl hw.memsize / sysconf). */
  export function totalmem(): number;
  /* The passwd-entry snapshot (uv_os_get_passwd): shell is `string |
   * null` to match @types/node (POSIX always answers the string arm);
   * homedir is pw_dir — NOT os.homedir()'s $HOME-first cascade. The type
   * is interned explicitly in type-mapper.ts (the AddressInfo pattern — this
   * concrete form and @types/node's UserInfo<string> both), and the call
   * assembles field-by-field in lowerOsUserInfoCall. */
  export interface UserInfo {
    username: string;
    uid: number;
    gid: number;
    shell: string | null;
    homedir: string;
  }
  export function userInfo(): UserInfo;
  /* The TARGET platform's line terminator (a compile-time constant:
   * "\r\n" under a win32 triple, "\n" everywhere else). */
  export const EOL: "\r\n" | "\n";
  export interface NetworkInterfaceBase {
    address: string;
    netmask: string;
    mac: string;
    internal: boolean;
    cidr: string | null;
    scopeid?: number;
  }
  export interface NetworkInterfaceInfoIPv4 extends NetworkInterfaceBase {
    family: "IPv4";
  }
  export interface NetworkInterfaceInfoIPv6 extends NetworkInterfaceBase {
    family: "IPv6";
    scopeid: number;
  }
  export type NetworkInterfaceInfo = NetworkInterfaceInfoIPv4 | NetworkInterfaceInfoIPv6;
  export function networkInterfaces(): { [name: string]: NetworkInterfaceInfo[] | undefined };
}
declare module "node:os" {
  export * from "os";
}

/* The WHATWG URL class (a Node global; the es2023 lib doesn't declare it),
 * typed as exactly the supported surface: construction from ONE absolute-
 * URL string (invalid input throws a catchable TypeError, like Node), the
 * protocol/pathname/href/host/hostname/search getters, searchParams (the
 * LIVE query view — mutations through it re-serialize into the URL, so
 * href reflects immediately; every read answers the same object, Node's
 * caching), and toString() (the href serialization).
 * URL values have no SETTERS — the component fields are read-only (the
 * one supported mutation path is searchParams) — and participate in
 * unions (URL | undefined). The parser covers the common CLI schemes
 * exactly (http/https/ws/wss/ftp/file authority URLs, opaque paths like
 * data: and mailto:) — divergences from the full WHATWG algorithm are
 * documented in SEMANTICS.md. */
interface URL {
  readonly protocol: string;
  readonly pathname: string;
  readonly href: string;
  readonly host: string;
  readonly hostname: string;
  readonly search: string;
  readonly searchParams: URLSearchParams;
  toString(): string;
}
declare var URL: {
  new (input: string): URL;
};

/* URLSearchParams — the WHATWG application/x-www-form-urlencoded list.
 * Constructed standalone (string / string[][] pairs / inline record
 * literal / another URLSearchParams) or read live off a URL via
 * url.searchParams. keys()/values()/entries() lower when a for-of head
 * consumes them directly; stored iterator OBJECTS have no lowering. */
interface URLSearchParams {
  readonly size: number;
  append(name: string, value: string): void;
  delete(name: string, value?: string): void;
  get(name: string): string | null;
  getAll(name: string): string[];
  has(name: string, value?: string): boolean;
  set(name: string, value: string): void;
  sort(): void;
  toString(): string;
  forEach(callback: (value: string, name: string, searchParams: URLSearchParams) => void): void;
  keys(): IterableIterator<string>;
  values(): IterableIterator<string>;
  entries(): IterableIterator<[string, string]>;
  [Symbol.iterator](): IterableIterator<[string, string]>;
}
declare var URLSearchParams: {
  new (init?: string | string[][] | { [key: string]: string } | URLSearchParams): URLSearchParams;
};

/* node:url — the file-URL bridge pair. fileURLToPath accepts a URL value
 * or a URL string and throws Node's TypeErrors (non-file scheme, encoded
 * slashes, non-empty host); pathToFileURL resolves the path and percent-
 * encodes it into a file: URL. */
declare module "url" {
  export function fileURLToPath(url: string | URL): string;
  export function pathToFileURL(path: string): URL;
}
declare module "node:url" {
  export * from "url";
}

/* node:crypto: randomUUID(), and randomBytes returning a REAL Buffer —
 * the composed randomBytes(n).toString("hex" | "base64") still lowers as
 * one fused string-producing operation (the Buffer never materializes
 * there); every other use gets an ordinary Buffer value. */
declare module "crypto" {
  export function randomUUID(): string;
  export function randomBytes(size: number): Buffer;
  /* The lowered Hash surface is exactly the COMPOSED chain
   * createHash("sha256" | "sha1").update(data).digest("hex" | "base64")
   * — fused into one call, the Hash handle never materializes (holding
   * one fences). sha1 exists for the RFC 6455 Sec-WebSocket-Accept
   * hash. */
  export interface Hash {
    update(data: string | Uint8Array): Hash;
    digest(encoding: "hex" | "base64"): string;
  }
  export function createHash(algorithm: string): Hash;
  /* The lowered X509Certificate surface is the data-record slice:
   * fingerprint (the SHA-1 of the DER, uppercase colon-separated) and
   * the validFrom/validTo validity window (Node's ASN1_TIME_print
   * strings — "Jul  1 00:00:00 2026 GMT"; the cert-expiry idiom composes
   * them with new Date(...).getTime()). All compute at construction;
   * unparseable input throws Node's ERR_OSSL_PEM_NO_START_LINE Error. */
  export class X509Certificate {
    constructor(buffer: Uint8Array | string);
    readonly fingerprint: string;
    readonly validFrom: string;
    readonly validTo: string;
  }
  /* The crypto introspection statics: getFips() answers 0 (a compiled
   * binary is never a FIPS build), the three name lists bake as fresh
   * string[] literals of Node v24 answers, and constants (below) bakes
   * per member like http2.constants. */
  export function getFips(): 1 | 0;
  export function getCiphers(): string[];
  export function getHashes(): string[];
  export function getCurves(): string[];
  /* Node v24 crypto.constants, literal-typed (the Http2Constants
   * stance). Every ACCESS bakes as its literal at lowering; the object
   * itself never materializes (bare crypto.constants value uses fence). */
  export interface CryptoConstants {
    readonly OPENSSL_VERSION_NUMBER: 810549328;
    readonly SSL_OP_ALL: 2147485776;
    readonly SSL_OP_ALLOW_NO_DHE_KEX: 1024;
    readonly SSL_OP_ALLOW_UNSAFE_LEGACY_RENEGOTIATION: 262144;
    readonly SSL_OP_CIPHER_SERVER_PREFERENCE: 4194304;
    readonly SSL_OP_CISCO_ANYCONNECT: 32768;
    readonly SSL_OP_COOKIE_EXCHANGE: 8192;
    readonly SSL_OP_CRYPTOPRO_TLSEXT_BUG: 2147483648;
    readonly SSL_OP_DONT_INSERT_EMPTY_FRAGMENTS: 2048;
    readonly SSL_OP_LEGACY_SERVER_CONNECT: 4;
    readonly SSL_OP_NO_COMPRESSION: 131072;
    readonly SSL_OP_NO_ENCRYPT_THEN_MAC: 524288;
    readonly SSL_OP_NO_QUERY_MTU: 4096;
    readonly SSL_OP_NO_RENEGOTIATION: 1073741824;
    readonly SSL_OP_NO_SESSION_RESUMPTION_ON_RENEGOTIATION: 65536;
    readonly SSL_OP_NO_SSLv2: 0;
    readonly SSL_OP_NO_SSLv3: 33554432;
    readonly SSL_OP_NO_TICKET: 16384;
    readonly SSL_OP_NO_TLSv1: 67108864;
    readonly SSL_OP_NO_TLSv1_1: 268435456;
    readonly SSL_OP_NO_TLSv1_2: 134217728;
    readonly SSL_OP_NO_TLSv1_3: 536870912;
    readonly SSL_OP_PRIORITIZE_CHACHA: 2097152;
    readonly SSL_OP_TLS_ROLLBACK_BUG: 8388608;
    readonly ENGINE_METHOD_RSA: 1;
    readonly ENGINE_METHOD_DSA: 2;
    readonly ENGINE_METHOD_DH: 4;
    readonly ENGINE_METHOD_RAND: 8;
    readonly ENGINE_METHOD_EC: 2048;
    readonly ENGINE_METHOD_CIPHERS: 64;
    readonly ENGINE_METHOD_DIGESTS: 128;
    readonly ENGINE_METHOD_PKEY_METHS: 512;
    readonly ENGINE_METHOD_PKEY_ASN1_METHS: 1024;
    readonly ENGINE_METHOD_ALL: 65535;
    readonly ENGINE_METHOD_NONE: 0;
    readonly DH_CHECK_P_NOT_SAFE_PRIME: 2;
    readonly DH_CHECK_P_NOT_PRIME: 1;
    readonly DH_UNABLE_TO_CHECK_GENERATOR: 4;
    readonly DH_NOT_SUITABLE_GENERATOR: 8;
    readonly RSA_PKCS1_PADDING: 1;
    readonly RSA_NO_PADDING: 3;
    readonly RSA_PKCS1_OAEP_PADDING: 4;
    readonly RSA_X931_PADDING: 5;
    readonly RSA_PKCS1_PSS_PADDING: 6;
    readonly RSA_PSS_SALTLEN_DIGEST: -1;
    readonly RSA_PSS_SALTLEN_MAX_SIGN: -2;
    readonly RSA_PSS_SALTLEN_AUTO: -2;
    readonly defaultCoreCipherList: "TLS_AES_256_GCM_SHA384:TLS_CHACHA20_POLY1305_SHA256:TLS_AES_128_GCM_SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-AES256-GCM-SHA384:DHE-RSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-SHA256:DHE-RSA-AES128-SHA256:ECDHE-RSA-AES256-SHA384:DHE-RSA-AES256-SHA384:ECDHE-RSA-AES256-SHA256:DHE-RSA-AES256-SHA256:HIGH:!aNULL:!eNULL:!EXPORT:!DES:!RC4:!MD5:!PSK:!SRP:!CAMELLIA";
    readonly TLS1_VERSION: 769;
    readonly TLS1_1_VERSION: 770;
    readonly TLS1_2_VERSION: 771;
    readonly TLS1_3_VERSION: 772;
    readonly POINT_CONVERSION_COMPRESSED: 2;
    readonly POINT_CONVERSION_UNCOMPRESSED: 4;
    readonly POINT_CONVERSION_HYBRID: 6;
    readonly defaultCipherList: "TLS_AES_256_GCM_SHA384:TLS_CHACHA20_POLY1305_SHA256:TLS_AES_128_GCM_SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-AES256-GCM-SHA384:DHE-RSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-SHA256:DHE-RSA-AES128-SHA256:ECDHE-RSA-AES256-SHA384:DHE-RSA-AES256-SHA384:ECDHE-RSA-AES256-SHA256:DHE-RSA-AES256-SHA256:HIGH:!aNULL:!eNULL:!EXPORT:!DES:!RC4:!MD5:!PSK:!SRP:!CAMELLIA";
  }
  export const constants: CryptoConstants;
}
declare module "node:crypto" {
  export * from "crypto";
}

/* node:child_process — the synchronous slice: spawnSync(command, args?)
 * runs the child to completion (posix_spawn + waitpid) with stdout/stderr
 * captured as utf8 strings. `status` is the exit code, or null when the
 * child died to a signal OR could not be spawned at all (nonexistent
 * binary, permission denied) — Node reports spawn failure through the
 * result's `error` property, which this surface does not carry, and types
 * stdout/stderr null there where scriptc returns "" (SEMANTICS.md).
 * No shell, no options object: the command runs directly (PATH-searched,
 * like Node). */
declare module "child_process" {
  export interface SpawnSyncReturns {
    readonly status: number | null;
    readonly stdout: string;
    readonly stderr: string;
    /* The termination signal's name ("SIGTERM", ...) when a signal
     * killed the child (a timeout's killSignal included), null otherwise
     * — Node's shape. */
    readonly signal: string | null;
    /* Node's spawn-failure carrier: a real Error ("spawnSync <file>
     * ENOENT", `code` stamped) when the spawn itself failed — status is
     * null and both outputs "" then — or ETIMEDOUT after a timeout kill;
     * undefined otherwise. */
    readonly error?: Error;
  }
  /* scriptc always captures utf8 strings; pass { encoding: "utf8" }
   * whenever stdout/stderr is READ so plain Node agrees (without it Node
   * hands Buffers). The other supported options: timeout (ms — sends
   * killSignal at the deadline and the result carries error: ETIMEDOUT +
   * the signal, never a throw), killSignal (a signal NAME literal),
   * stdio ("ignore"/"inherit"/"pipe" or a 3-tuple of those — captures
   * read "" for non-piped streams), and windowsHide (a POSIX no-op). */
  export function spawnSync(
    command: string,
    args?: string[],
    options?: {
      encoding?: "utf8" | "utf-8";
      timeout?: number;
      killSignal?: string;
      stdio?: "pipe" | "ignore" | "inherit" | ("pipe" | "ignore" | "inherit")[];
      windowsHide?: boolean;
    },
  ): SpawnSyncReturns;

  /* The asynchronous slice: spawn with stdio "ignore"/"inherit"/fd/"pipe"
   * tuples (piped stdout/stderr deliver through child.stdout/stderr) and
   * the two terminal events. "exit" fires once with the exit code, or
   * null when the child died to a signal; "error" fires ONLY when the
   * child could not be spawned at all (Node's split: a spawn failure
   * emits "error" and never "exit"). Listeners take at most one
   * parameter; Node's second "exit" parameter (the signal name) has no
   * lowering. `on` returns void here (Node returns the child; chaining
   * is fenced). The event loop keeps the process alive until every
   * spawned child is reaped, like Node — reaping polls at loop
   * quiescence (SEMANTICS.md documents the divergence). An "error"
   * event with no registered listener prints the error and exits 1,
   * exactly the unhandled-'error' EventEmitter behavior. */
  export interface ChildProcess {
    /* The exit listener may also take Node's second parameter — the
     * terminating signal's name, null for a normal exit. */
    on(event: "exit", listener: (code: number | null, signal: string | null) => void): void;
    on(event: "error", listener: (err: Error) => void): void;
    /* The lifecycle members, Node's exact shapes: pid is undefined exactly
     * when the spawn failed; exitCode is null while running, the code
     * after a normal exit, null for a signal death, and -errno once a
     * spawn failure's "error" event has fired; kill resolves signal names
     * through Node's table (unknown names throw the Unknown signal
     * TypeError), answers true when the signal was sent, false once the
     * child was reaped (or never spawned), and sets `killed` on success;
     * unref() drops the child from the event loop's keep-alive set (it is
     * still reaped while the loop runs for other reasons — SEMANTICS.md
     * has the reap story). */
    readonly pid: number | undefined;
    readonly exitCode: number | null;
    readonly killed: boolean;
    kill(signal?: string | number): boolean;
    unref(): void;
    /* The piped-output streams — non-null exactly when the matching
     * stdio slot was "pipe" (Node's shape). */
    readonly stdout: NodeJS.ReadableStream | null;
    readonly stderr: NodeJS.ReadableStream | null;
  }
  export function spawn(
    command: string,
    args?: string[],
    options?: {
      /* The 3-tuple form admits number fds in the stdout/stderr slots —
       * openSync results dup2'd into the child (the daemon-log idiom
       * ["ignore", logFd, logFd]) — and "pipe" there too (child.stdout/
       * child.stderr streams); piped STDIN stays a compile fence. */
      stdio: "ignore" | "inherit" | "pipe" | ("ignore" | "inherit" | "pipe" | number)[];
      /* detached gives the child its own session and process group
       * (POSIX_SPAWN_SETSID); env REPLACES the child environment; cwd
       * sets its working directory; windowsHide is a POSIX no-op. */
      detached?: boolean;
      env?: { [k: string]: string | undefined };
      cwd?: string;
      windowsHide?: boolean;
    },
  ): ChildProcess;

  /* The synchronous exec pair: execFileSync runs a file directly (no
   * shell), execSync runs a command through /bin/sh -c. Both capture
   * stdout as a utf8 string (pass { encoding: "utf8" } so plain Node
   * agrees — without it Node returns a Buffer) and THROW on a non-zero
   * exit / signal death — the Error's message is Node's "Command failed:
   * <cmd>" (with the captured stderr appended). Supported options:
   * encoding ("utf8"), cwd, env (REPLACES the child environment), input
   * (fed to stdin), timeout (ms — SIGTERMs the child, then throws
   * ETIMEDOUT), stdio ("pipe"/"ignore" or a 3-tuple of those — the
   * default captures stderr AND echoes it to the parent, like Node), and
   * maxBuffer (accepted, not enforced). Node's status/stdout/stderr error
   * properties are not carried (SEMANTICS.md). */
  interface ExecSyncOptions {
    encoding?: "utf8" | "utf-8";
    cwd?: string;
    env?: { [k: string]: string | undefined };
    input?: string;
    timeout?: number;
    stdio?: "pipe" | "ignore" | "inherit" | ("pipe" | "ignore" | "inherit")[];
    maxBuffer?: number;
    killSignal?: string;
    windowsHide?: boolean;
    shell?: boolean;
  }
  /* The named options interface for the string-encoding exec form —
   * @types/node's ExecFileSyncOptionsWithStringEncoding, narrowed to the
   * honestly-implemented members. VALUES of this type are a real record
   * (type-mapper.ts interns the shape), so a typed const or a runner function's
   * options parameter flows to execFileSync at runtime — the windows-ca
   * command-runner idiom. */
  export interface ExecFileSyncOptionsWithStringEncoding {
    encoding: "utf8" | "utf-8";
    cwd?: string;
    input?: string;
    timeout?: number;
    stdio?: "pipe" | "ignore" | "inherit" | ("pipe" | "ignore" | "inherit")[];
    maxBuffer?: number;
    windowsHide?: boolean;
  }
  export function execFileSync(file: string, args?: string[], options?: ExecSyncOptions): string;
  export function execSync(command: string, options?: ExecSyncOptions): string;
  /* The callback form exists to be PROMISIFIED — `const execFileAsync =
   * promisify(execFile)` is the one lowered use (see "util"); calling it
   * directly with a callback has no lowering and fences per site. */
  export function execFile(
    file: string,
    args?: string[] | null,
    options?: ExecSyncOptions,
  ): unknown;
  /* The async shell form — declared surface without full lowering (the
   * type-level tolerance story): harness code on paths tests don't reach
   * must typecheck; a reached call fences at its site. */
  export function exec(
    command: string,
    options?: ExecSyncOptions | ((error: Error | null, stdout: string, stderr: string) => void),
    callback?: (error: Error | null, stdout: string, stderr: string) => void,
  ): ChildProcess;
}
declare module "node:child_process" {
  export * from "child_process";
}

/* node:util — promisify, for exactly ONE target: child_process.execFile.
 * `const execFileAsync = promisify(execFile)` binds an async exec whose
 * calls run the file (no shell, PATH-searched) and settle with
 * { stdout, stderr } — fulfilled on exit 0, rejected with Node's
 * Command-failed / spawn-ENOENT errors otherwise. Other promisify
 * targets and bare promisify values fence per site. */
declare module "util" {
  export function promisify(
    fn: (file: string, args?: string[] | null, options?: object) => unknown,
  ): (
    file: string,
    args?: string[],
    options?: {
      encoding?: "utf8" | "utf-8";
      cwd?: string;
      env?: { [k: string]: string | undefined };
      timeout?: number;
      maxBuffer?: number;
      killSignal?: string;
      windowsHide?: boolean;
    },
  ) => Promise<{ stdout: string; stderr: string }>;
  /* Declared surface without full lowering (the type-level tolerance
   * story: guarded/diagnostic-path code must TYPECHECK; a reached use
   * without a lowering fences at its site). inspect's options carry the
   * documented knobs through an index signature. */
  export function inspect(object: unknown, options?: { depth?: number | null; colors?: boolean; [k: string]: unknown }): string;
  export function format(format?: unknown, ...args: unknown[]): string;
  export function formatWithOptions(
    inspectOptions: { depth?: number | null; colors?: boolean; [k: string]: unknown },
    format?: unknown,
    ...args: unknown[]
  ): string;
  export type ParseArgsOptionsType = "boolean" | "string";
  export interface ParseArgsOptionDescriptor {
    type: ParseArgsOptionsType;
    multiple?: boolean;
    short?: string;
    default?: string | boolean | string[] | boolean[];
  }
  export interface ParseArgsOptionsConfig {
    [longOption: string]: ParseArgsOptionDescriptor;
  }
  export interface ParseArgsConfig {
    args?: readonly string[];
    options?: ParseArgsOptionsConfig;
    strict?: boolean;
    allowPositionals?: boolean;
    allowNegative?: boolean;
    tokens?: boolean;
  }
  export type ParseArgsToken =
    | {
        kind: "option";
        index: number;
        name: string;
        rawName: string;
        value: string | undefined;
        inlineValue: boolean | undefined;
      }
    | { kind: "positional"; index: number; value: string }
    | { kind: "option-terminator"; index: number };
  export interface ParseArgsResult {
    values: { [longOption: string]: undefined | string | boolean | Array<string | boolean> };
    positionals: string[];
    tokens?: ParseArgsToken[];
  }
  export function parseArgs(config?: ParseArgsConfig): ParseArgsResult;
  /* util.getCallSites (Node ≥22.9): the captured-frame slice harness
   * code reads. No stack bookkeeping exists in a compiled binary — every
   * reached call fences per site. */
  export interface CallSite {
    readonly functionName: string;
    readonly scriptName: string;
    readonly lineNumber: number;
    readonly column: number;
  }
  export function getCallSites(frameCount?: number): CallSite[];
}
declare module "node:util" {
  export * from "util";
}

/* node:util/types — the type probes. isModuleNamespaceObject answers a
 * REAL question about compiled modules and fences until it lowers; the
 * rest of Node's surface is undeclared (honest type errors). */
declare module "util/types" {
  export function isModuleNamespaceObject(value: unknown): boolean;
}
declare module "node:util/types" {
  export * from "util/types";
}

/* node:assert — the static assertion surface. The module object IS a
 * callable function (`assert(x)` is `assert.ok(x)`), so the declaration
 * is the callable-namespace `export =` shape and BOTH `import assert
 * from "node:assert"` and `const assert = require("assert")` bind the
 * callable; named imports take the members. Failures throw
 * AssertionError (name "AssertionError", code "ERR_ASSERTION" — catch and
 * read .name/.message/.code). strictEqual/deepStrictEqual compare with
 * Object.is over scalars; deepStrictEqual compares composites
 * structurally per their static types. The messages here are plain
 * strings (Node accepts Errors — that form fences per site), and the
 * loose-equality quartet (equal/notEqual/deepEqual/notDeepEqual) is
 * declared so real code typechecks but fences at its use sites (== has
 * no lowering; assert/strict's equal IS strictEqual and lowers). */
/* node:test — the in-process test runner (prefix-only in Node too:
 * require("test") is MODULE_NOT_FOUND). test/it register tests (sync and
 * async bodies, skip/todo/only options and method twins), describe/suite
 * group them (bodies run at registration, Node's collection phase),
 * before/after/beforeEach/afterEach hook the enclosing suite, and the
 * TestContext argument carries subtests (t.test), t.skip/t.todo,
 * t.diagnostic, and t.assert. mock/run/snapshot are DECLARED so real
 * suites typecheck but fence at their use sites (no lowering). */
declare module "node:test" {
  type TestFn = (t: TestContext) => void | Promise<void>;
  type SuiteFn = () => void;
  type HookFn = () => void | Promise<void>;
  interface TestOptions {
    skip?: boolean | string;
    todo?: boolean | string;
    only?: boolean;
    concurrency?: number | boolean;
    timeout?: number;
    plan?: number;
  }
  interface TestContext {
    readonly name: string;
    readonly assert: TestContextAssert;
    test(name: string, fn?: TestFn): Promise<void>;
    test(name: string, options: TestOptions, fn?: TestFn): Promise<void>;
    skip(message?: string): void;
    todo(message?: string): void;
    diagnostic(message: string): void;
    plan(count: number): void;
    after(fn: HookFn): void;
    before(fn: HookFn): void;
    beforeEach(fn: HookFn): void;
    afterEach(fn: HookFn): void;
  }
  interface TestContextAssert {
    ok(value: unknown, message?: string): void;
    strictEqual(actual: unknown, expected: unknown, message?: string): void;
    notStrictEqual(actual: unknown, expected: unknown, message?: string): void;
    deepStrictEqual(actual: unknown, expected: unknown, message?: string): void;
    notDeepStrictEqual(actual: unknown, expected: unknown, message?: string): void;
    equal(actual: unknown, expected: unknown, message?: string): void;
    notEqual(actual: unknown, expected: unknown, message?: string): void;
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
    notDeepEqual(actual: unknown, expected: unknown, message?: string): void;
    fail(message?: string): never;
    throws(fn: () => unknown, expected?: unknown, message?: string): void;
    match(value: string, regExp: RegExp, message?: string): void;
    doesNotMatch(value: string, regExp: RegExp, message?: string): void;
  }
  function test(name: string, fn?: TestFn): Promise<void>;
  function test(name: string, options: TestOptions, fn?: TestFn): Promise<void>;
  namespace test {
    function skip(name: string, fn?: TestFn): Promise<void>;
    function skip(name: string, options: TestOptions, fn?: TestFn): Promise<void>;
    function todo(name: string, fn?: TestFn): Promise<void>;
    function todo(name: string, options: TestOptions, fn?: TestFn): Promise<void>;
    function only(name: string, fn?: TestFn): Promise<void>;
    function only(name: string, options: TestOptions, fn?: TestFn): Promise<void>;
  }
  const it: typeof test;
  function describe(name: string, fn?: SuiteFn): void;
  function describe(name: string, options: TestOptions, fn?: SuiteFn): void;
  namespace describe {
    function skip(name: string, fn?: SuiteFn): void;
    function todo(name: string, fn?: SuiteFn): void;
    function only(name: string, fn?: SuiteFn): void;
  }
  const suite: typeof describe;
  function before(fn: HookFn): void;
  function after(fn: HookFn): void;
  function beforeEach(fn: HookFn): void;
  function afterEach(fn: HookFn): void;
  /* Declared for typechecking only — every use fences (no lowering).
   * `assert` is the module-level custom-assertion registry (v24's
   * `const { assert } = require('node:test')`), not TestContext.assert. */
  const mock: unknown;
  const assert: { register(name: string, fn: (...args: unknown[]) => unknown): void };
  function run(options?: unknown): unknown;
  function snapshot(...args: unknown[]): unknown;
  export {
    test, it, describe, suite, before, after, beforeEach, afterEach,
    mock, assert, run, snapshot, TestContext, TestOptions,
  };
  export default test;
}

declare module "assert" {
  function assert(value: unknown, message?: string): void;
  namespace assert {
    function ok(value: unknown, message?: string): void;
    function strictEqual(actual: unknown, expected: unknown, message?: string): void;
    function notStrictEqual(actual: unknown, expected: unknown, message?: string): void;
    function deepStrictEqual(actual: unknown, expected: unknown, message?: string): void;
    function notDeepStrictEqual(actual: unknown, expected: unknown, message?: string): void;
    function equal(actual: unknown, expected: unknown, message?: string): void;
    function notEqual(actual: unknown, expected: unknown, message?: string): void;
    function deepEqual(actual: unknown, expected: unknown, message?: string): void;
    function notDeepEqual(actual: unknown, expected: unknown, message?: string): void;
    function fail(message?: string): never;
    function throws(fn: () => unknown, expected?: unknown, message?: string): void;
    function rejects(fn: (() => Promise<unknown>) | Promise<unknown>, expected?: unknown, message?: string): Promise<void>;
    function doesNotReject(fn: (() => Promise<unknown>) | Promise<unknown>, expected?: unknown, message?: string): Promise<void>;
    function match(value: string, regExp: RegExp, message?: string): void;
    function doesNotMatch(value: string, regExp: RegExp, message?: string): void;
    function ifError(value: unknown): void;
    const strict: typeof import("assert/strict");
  }
  export = assert;
}
declare module "node:assert" {
  import assert = require("assert");
  export = assert;
}
/* node:assert/strict — the same surface with the loose names bound to the
 * strict comparisons (equal IS strictEqual, ...), exactly Node's aliasing;
 * the module object is callable like assert's. */
declare module "assert/strict" {
  function strict(value: unknown, message?: string): void;
  namespace strict {
    function ok(value: unknown, message?: string): void;
    function equal(actual: unknown, expected: unknown, message?: string): void;
    function notEqual(actual: unknown, expected: unknown, message?: string): void;
    function deepEqual(actual: unknown, expected: unknown, message?: string): void;
    function notDeepEqual(actual: unknown, expected: unknown, message?: string): void;
    function strictEqual(actual: unknown, expected: unknown, message?: string): void;
    function notStrictEqual(actual: unknown, expected: unknown, message?: string): void;
    function deepStrictEqual(actual: unknown, expected: unknown, message?: string): void;
    function notDeepStrictEqual(actual: unknown, expected: unknown, message?: string): void;
    function fail(message?: string): never;
    function throws(fn: () => unknown, expected?: unknown, message?: string): void;
    function rejects(fn: (() => Promise<unknown>) | Promise<unknown>, expected?: unknown, message?: string): Promise<void>;
    function doesNotReject(fn: (() => Promise<unknown>) | Promise<unknown>, expected?: unknown, message?: string): Promise<void>;
    function match(value: string, regExp: RegExp, message?: string): void;
    function doesNotMatch(value: string, regExp: RegExp, message?: string): void;
    function ifError(value: unknown): void;
    const strict: typeof import("assert/strict");
  }
  export = strict;
}
declare module "node:assert/strict" {
  import strict = require("assert/strict");
  export = strict;
}

/* node:string_decoder — StringDecoder over Node's whole encoding set:
 * write() decodes complete sequences and buffers a trailing partial one
 * across chunk boundaries (utf8's truncated sequence, base64's mod-3
 * remainder, utf16le's odd byte / trailing lead surrogate; latin1, ascii
 * and hex are stateless); end() flushes the buffered partial. `encoding`
 * answers the normalized name. Node's exact algorithms (SEMANTICS.md);
 * the encoding must be a literal, and end(buffer) fences — write the
 * buffer, then end(). */
declare module "string_decoder" {
  export class StringDecoder {
    constructor(encoding?: BufferEncoding);
    readonly encoding: string;
    write(buffer: Uint8Array): string;
    end(buffer?: Uint8Array): string;
  }
}
declare module "node:string_decoder" {
  export * from "string_decoder";
}

/* node:querystring — Node's legacy query-string codec (NOT
 * URLSearchParams: '+' means space on the parse side and escape encodes
 * spaces as %20). parse answers the null-prototype dictionary as a pure
 * index-signature record (repeated keys become string[] buckets;
 * @types/node's Dict adds an undefined arm the lowering tolerates);
 * stringify serializes string/number/boolean values and arrays of those
 * (Node's rules: arrays expand to repeated keys, null/undefined and
 * anything else serialize as the empty value). The maxKeys option lowers
 * (0 removes the cap, Node's rule); the custom encoder/decoder options
 * typecheck under the options-record stance and fence by name at the
 * call. decode/encode are Node's own aliases of parse/stringify. */
declare module "querystring" {
  export interface ParseOptions {
    maxKeys?: number;
    decodeURIComponent?: (str: string) => string;
    [option: string]: unknown;
  }
  export interface StringifyOptions {
    encodeURIComponent?: (str: string) => string;
    [option: string]: unknown;
  }
  export interface ParsedUrlQuery {
    [key: string]: string | string[] | undefined;
  }
  export interface ParsedUrlQueryInput {
    [key: string]:
      | string
      | number
      | boolean
      | ReadonlyArray<string | number | boolean>
      | null
      | undefined;
  }
  export function parse(str: string, sep?: string | null, eq?: string | null, options?: ParseOptions): ParsedUrlQuery;
  export function stringify(obj?: ParsedUrlQueryInput, sep?: string | null, eq?: string | null, options?: StringifyOptions): string;
  export const decode: typeof parse;
  export const encode: typeof stringify;
  export function escape(str: string): string;
  export function unescape(str: string): string;
}
declare module "node:querystring" {
  export * from "querystring";
}

/* node:readline — the question/close slice: createInterface over exactly
 * { input: process.stdin, output: process.stdout }, question(query, cb)
 * (the query writes to stdout, the callback gets the next line's text),
 * close() (fires 'close' synchronously, like Node's inline emit), and
 * on("close", cb). An open interface keeps the process alive until
 * close()/EOF, Node's semantics; lines split on \n and \r\n. */
declare module "readline" {
  export interface Interface {
    question(query: string, callback: (answer: string) => void): void;
    close(): void;
    on(event: "close", listener: () => void): void;
  }
  export function createInterface(options: {
    input: unknown;
    output?: unknown;
    terminal?: boolean;
    /* crlfDelay: Infinity is accepted — the lowered splitter already
     * holds a trailing \r for the next chunk, Node's Infinity behavior;
     * completer and the history knobs fence by name (no interactive
     * terminal). The options-record stance (see http.RequestOptions)
     * admits every key; the walk decides. */
    crlfDelay?: number;
    completer?: unknown;
    [option: string]: unknown;
  }): Interface;
}
declare module "node:readline" {
  export * from "readline";
}

/* node:zlib — deflateSync/inflateSync lower (Buffer in, Buffer out,
 * Node's default options; libz links only into zlib-using binaries);
 * gzip and friends typecheck and fence at their use sites. */
declare module "zlib" {
  export function deflateSync(data: string | Uint8Array): Buffer;
  export function inflateSync(data: Uint8Array): Buffer;
  export function gzipSync(data: string | Uint8Array): Buffer;
  export function gunzipSync(data: Uint8Array): Buffer;
}
declare module "node:zlib" {
  export * from "zlib";
}

/* node:net — the inbound-networking slice (scr_net.c links only into
 * net-using binaries). TCP only, Node's shapes narrowed to what lowers:
 * createServer with an optional connection handler; listen(port[, cb])
 * with the real port discoverable as address().port (the composed read
 * is the lowered form — bare address() has no lowering); close([cb])
 * firing once connections drain; socket write/end/destroy/pipe and the
 * data/end/close/error/connect events (on and once — listeners take at
 * most the declared parameter). write/end return void here (Node returns
 * the backpressure boolean / the socket); on/once return void (chaining
 * is fenced). connect's host is a numeric IP or "localhost" (pinned to
 * 127.0.0.1 — SEMANTICS.md); every failure is the async 'error' event,
 * and an 'error' with no listener exits 1 like an unhandled EventEmitter
 * 'error'. */
declare module "net" {
  export interface Socket {
    readonly remoteAddress: string | undefined;
    /* true once the fd is gone (destroy() or full close) — Node's flag. */
    readonly destroyed: boolean;
    /* the write half is open: no end() yet, no FIN sent, fd alive. */
    readonly writable: boolean;
    /* true until the read half is done (peer FIN / destroy). */
    readonly readable: boolean;
    /* every byte the write paths accepted (buffered included — Node
     * counts those too; plaintext on TLS sockets). */
    readonly bytesWritten: number;
    write(data: string | Uint8Array): void;
    end(data?: string | Uint8Array): void;
    destroy(): void;
    /* Flow control: pause holds reads off (kernel/TCP backpressure is
     * the buffer); resume flows — and discards without listeners, so
     * 'end' stays reachable. Both chain, Node's shape. */
    pause(): Socket;
    resume(): Socket;
    /* TCP_NODELAY on the live fd; missing means true. Chains. */
    setNoDelay(noDelay?: boolean): Socket;
    /* end() now, destroy once the FIN actually flushed. */
    destroySoon(): void;
    /* setEncoding('utf8'): 'data' delivers strings — the IncomingMessage
     * twin's contract. */
    setEncoding(encoding: string): void;
    /* socket→socket, and socket→response (the extended-CONNECT bridge
     * leg: raw chunks become response body writes; EOF ends it). */
    pipe(destination: Socket | import("http").ServerResponse | import("http2").Http2ServerResponse): void;
    setTimeout(ms: number): void;
    /* The paused-mode demux surface: once('readable') + read(1) +
     * unshift — read answers exactly n buffered bytes or null. */
    read(size?: number): Buffer | null;
    unshift(chunk: Uint8Array): void;
    /* secureConnect/session are TLS-socket events declared on the shared
     * socket surface (the lowering collapses TLSSocket onto this kind):
     * the runtime gates on the transport, so a plain socket's
     * registration never fires — Node's exact split. 'session' fires
     * once with the serialized session (the received-ticket event). */
    on(event: "data", listener: (chunk: Buffer) => void): void;
    on(event: "end" | "close" | "connect" | "timeout" | "readable" | "finish" | "secureConnect", listener: () => void): void;
    on(event: "error", listener: (err: Error) => void): void;
    on(event: "session", listener: (session: Buffer) => void): void;
    /* addListener IS on (Node aliases them) — the suite spells both. */
    addListener(event: "data", listener: (chunk: Buffer) => void): void;
    addListener(event: "end" | "close" | "connect" | "timeout" | "readable" | "finish" | "secureConnect", listener: () => void): void;
    addListener(event: "error", listener: (err: Error) => void): void;
    addListener(event: "session", listener: (session: Buffer) => void): void;
    once(event: "data", listener: (chunk: Buffer) => void): void;
    once(event: "end" | "close" | "connect" | "timeout" | "readable" | "finish" | "secureConnect", listener: () => void): void;
    once(event: "error", listener: (err: Error) => void): void;
    once(event: "session", listener: (session: Buffer) => void): void;
  }
  export interface Server {
    /* Node answers the server itself (`return this` chaining). */
    listen(port: number, callback?: () => void): Server;
    /* The positional bind address (the options form's host in argument
     * spelling). */
    listen(port: number, host: string, callback?: () => void): Server;
    /* The explicit-interface bind: host is an IP literal (absent = the
     * host-less dual-stack any); ipv6Only sets IPV6_V6ONLY. */
    listen(options: { port: number; host?: string; ipv6Only?: boolean }, callback?: () => void): Server;
    close(callback?: () => void): void;
    /* The bound AddressInfo (Node answers null before listen — this
     * surface answers the record with port 0 there, the serverPort
     * stance). */
    address(): import("node:dgram").AddressInfo;
    /* The demux route: hand an accepted socket to another server. */
    emit(event: "connection", socket: Socket): boolean;
    on(event: "connection" | "secureConnection", listener: (socket: Socket) => void): void;
    on(event: "close" | "listening", listener: () => void): void;
    on(event: "error", listener: (err: Error) => void): void;
    /* The WebSocket handover: fires INSTEAD of 'request' for
     * Connection: upgrade requests, with the raw socket + head bytes. */
    on(event: "upgrade", listener: (req: import("http").IncomingMessage, socket: Socket, head: Buffer) => void): void;
    /* http.createServer(handler)'s event twin (a no-parser net server
     * never fires it, like Node). */
    on(event: "request", listener: (req: import("http").IncomingMessage, res: import("http").ServerResponse) => void): void;
    /* addListener IS on (Node aliases them) — the suite spells both. */
    addListener(event: "connection" | "secureConnection", listener: (socket: Socket) => void): void;
    addListener(event: "close" | "listening", listener: () => void): void;
    addListener(event: "error", listener: (err: Error) => void): void;
    addListener(event: "upgrade", listener: (req: import("http").IncomingMessage, socket: Socket, head: Buffer) => void): void;
    addListener(event: "request", listener: (req: import("http").IncomingMessage, res: import("http").ServerResponse) => void): void;
    once(event: "connection" | "secureConnection", listener: (socket: Socket) => void): void;
    once(event: "close" | "listening", listener: () => void): void;
    once(event: "error", listener: (err: Error) => void): void;
    once(event: "upgrade", listener: (req: import("http").IncomingMessage, socket: Socket, head: Buffer) => void): void;
    once(event: "request", listener: (req: import("http").IncomingMessage, res: import("http").ServerResponse) => void): void;
  }
  /* The Socket VALUE — the `x instanceof net.Socket` narrowing target
   * (the h2 compat 'connect' listener's test). Constructing bare sockets
   * has no lowering; the construct signature exists for instanceof. */
  export const Socket: abstract new () => Socket;
  export function createServer(connectionListener?: (socket: Socket) => void): Server;
  export function connect(port: number, host?: string, connectListener?: () => void): Socket;
  export function createConnection(port: number, host?: string, connectListener?: () => void): Socket;
  /* The caller-resolver dial (@types/node's net.LookupFunction, narrowed
   * to the lowered shape): the runtime invokes it as Node does and dials
   * the answered addresses in order under autoSelectFamily: true. */
  export type LookupFunction = (
    hostname: string,
    options: unknown,
    callback: (err: NodeJS.ErrnoException | null, addresses: { address: string; family: number }[]) => void,
  ) => void;
  export function connect(options: {
    port: number;
    host?: string;
    autoSelectFamily?: boolean;
    lookup?: LookupFunction;
  }, connectListener?: () => void): Socket;
  export function createConnection(options: {
    port: number;
    host?: string;
    autoSelectFamily?: boolean;
    lookup?: LookupFunction;
  }, connectListener?: () => void): Socket;
  /* The happy-eyeballs attempt budget (Node's process-wide knob; the
   * autoSelectFamily dial consults it): one runtime int, default 250ms
   * like Node's. */
  export function getDefaultAutoSelectFamilyAttemptTimeout(): number;
  export function setDefaultAutoSelectFamilyAttemptTimeout(value: number): void;
}
declare module "node:net" {
  export * from "net";
}

/* node:http — the SERVER and CLIENT slices (scr_http.c layers a
 * hand-written HTTP/1.1 parser + serializer on scr_net.c; both link only
 * into using binaries). createServer(handler) returns a net.Server —
 * listen/close/address().port/'error' are the same lowered surface. The
 * request carries url/method (always present on server requests),
 * statusCode (a number on client responses, undefined on server
 * requests), the underlying socket, and lowercased headers read as
 * `string | undefined`; the body streams through on("data"/"end"). The
 * response is setHeader/writeHead/write/end/destroy with Node's framing
 * (Content-Length for a single end(body), chunked after writeHead/write)
 * and the auto Date/Connection headers; writeHead's headers argument is
 * an object literal or a Record<string, string>. request/get dial one
 * connection per call (no agent pooling) with Node's exact wire head. */
declare module "http" {
  import { Server as NetServer, Socket } from "net";
  export interface Server extends NetServer {
    timeout: number;
    keepAliveTimeout: number;
    keepAliveTimeoutBuffer: number;
    headersTimeout: number;
    requestTimeout: number;
  }
  export type RequestListener =
    (req: IncomingMessage, res: ServerResponse) => void;
  /* The Server VALUE — Node's constructor works with and without `new`
   * (test/parallel's http.Server(fn) spelling); both route to the
   * createServer lowering. */
  export const Server: {
    new (requestListener?: (req: IncomingMessage, res: ServerResponse) => void): Server;
    new (options: ServerOptions, requestListener?: (req: IncomingMessage, res: ServerResponse) => void): Server;
    (requestListener?: (req: IncomingMessage, res: ServerResponse) => void): Server;
    (options: ServerOptions, requestListener?: (req: IncomingMessage, res: ServerResponse) => void): Server;
  };
  /* The options-record stance (the RequestOptions precedent): every
   * documented key typechecks; the lowering's option walk decides per
   * key — requireHostHeader: false, joinDuplicateHeaders, and
   * keepAliveTimeoutBuffer lower,
   * documented-but-unlowered keys fence by name, unknown keys drop. */
  export interface ServerOptions {
    requireHostHeader?: boolean;
    joinDuplicateHeaders?: boolean;
    keepAliveTimeoutBuffer?: number;
    [option: string]: unknown;
  }
  /* The outgoing-header shape, @types/node's matrix: numbers format via
   * String(n), arrays write one line per element (set-cookie's shape).
   * Incoming headers stay `string | undefined` — what the parser answers
   * (under @types/node the two SLOTS unify so `{ ...req.headers }`
   * merges into outgoing literals as a copy; the fallback keeps reads
   * simple and spreads target the same string | undefined slot). */
  export type OutgoingHttpHeaders = { [name: string]: number | string | string[] | undefined };
  export interface IncomingMessage {
    readonly url: string;
    readonly method: string;
    readonly statusCode: number | undefined;
    readonly statusMessage: string | undefined;
    readonly socket: Socket;
    readonly headers: { [name: string]: string | undefined };
    readonly rawHeaders: string[];
    resume(): void;
    destroy(): void;
    /* setEncoding('utf8'): 'data' delivers strings (other real encodings
     * fence loudly at runtime; unknown names throw ERR_UNKNOWN_ENCODING). */
    setEncoding(encoding: string): void;
    /* The proxy legs: the body streams into a ServerResponse, a
     * ClientRequest, or a raw Socket; natural end ends the destination. */
    pipe(destination: ServerResponse | ClientRequest | Socket): void;
    on(event: "data", listener: (chunk: any) => void): void;
    on(event: "end" | "close", listener: () => void): void;
    on(event: "error", listener: (err: Error) => void): void;
    /* addListener IS on (Node aliases them) — the suite spells both. */
    addListener(event: "data", listener: (chunk: any) => void): void;
    addListener(event: "end" | "close", listener: () => void): void;
    addListener(event: "error", listener: (err: Error) => void): void;
    once(event: "data", listener: (chunk: any) => void): void;
    once(event: "end" | "close", listener: () => void): void;
    once(event: "error", listener: (err: Error) => void): void;
  }
  export interface ServerResponse {
    readonly headersSent: boolean;
    /* Node's writable head properties: the implicit head reads them. */
    statusCode: number;
    statusMessage: string;
    setHeader(name: string, value: string | number): void;
    getHeader(name: string): string | undefined;
    hasHeader(name: string): boolean;
    removeHeader(name: string): void;
    /* Both overloads answer the response (`return this` chaining); the
     * headers argument also takes Node's flat [name, value, ...] array. */
    writeHead(statusCode: number, headers?: OutgoingHttpHeaders | string[]): ServerResponse;
    writeHead(statusCode: number, statusMessage: string, headers?: OutgoingHttpHeaders | string[]): ServerResponse;
    write(data: string | Uint8Array): void;
    /* end's callback forms fire once the body went out (the 'finish'
     * emit, deferred past the handler's synchronous tail). */
    end(data?: string | Uint8Array, callback?: () => void): void;
    end(callback: () => void): void;
    destroy(): void;
    on(event: "close", listener: () => void): void;
    /* addListener IS on (Node aliases them) — the suite spells both. */
    addListener(event: "close", listener: () => void): void;
    once(event: "close", listener: () => void): void;
  }
  /* The CLIENT slice (http.request/http.get): the options-object form
   * with hostname/host, port, path, method, timeout, and headers; the
   * callback receives the response as an IncomingMessage (statusCode,
   * headers, body via on("data"/"end")). */
  export interface RequestOptions {
    hostname?: string;
    host?: string;
    port?: number;
    path?: string;
    method?: string;
    timeout?: number;
    headers?: OutgoingHttpHeaders;
    /* The caller's own dialer (the proxy's loopback dial): invoked once,
     * synchronously; its socket carries the exchange. */
    createConnection?: () => Socket;
    /* agent: false is a one-shot dial with Connection: close — exactly
     * the compiled client's model; null/undefined are the default; an
     * Agent VALUE threads through (getName-keyed maxSockets accounting
     * over one-dial-per-request connections). */
    agent?: Agent | boolean | null;
    /* The options-record stance: Node ignores an options record's
     * unknown keys, so every key typechecks here — the option WALK in
     * the lowering decides per key (lower, fence by name, or drop
     * undocumented keys exactly like Node). */
    [option: string]: unknown;
  }
  /* The Agent lowers to a checked-dynamic HANDLE: option parsing at the
   * literal construction site, getName, destroy, the sockets/requests/
   * freeSockets snapshots, and REAL maxSockets accounting (over-limit
   * requests defer their dial and queue). keepAlive: true throws the
   * named pooling fence — this client dials one connection per request
   * and closes it with the response, so freeSockets is always
   * empty. */
  export interface AgentOptions {
    keepAlive?: boolean;
    keepAliveMsecs?: number;
    maxSockets?: number;
    maxFreeSockets?: number;
    maxTotalSockets?: number;
    scheduling?: string;
    timeout?: number;
    port?: number;
    [option: string]: unknown;
  }
  export class Agent {
    constructor(options?: AgentOptions);
    destroy(): void;
    /* Node's exact key shape: host:port:localAddress[:family][:socketPath]. */
    getName(options?: { host?: string; port?: number; localAddress?: string; family?: number; socketPath?: string; [option: string]: unknown }): string;
    maxSockets: number;
    maxFreeSockets: number;
    keepAliveMsecs: number;
    readonly keepAlive: boolean;
    readonly protocol: string;
    /* Settable — a portless request through this agent dials it (Node's
     * option merge). */
    defaultPort: number;
    readonly totalSocketCount: number;
    readonly sockets: { [key: string]: unknown[] };
    readonly freeSockets: { [key: string]: unknown[] };
    readonly requests: { [key: string]: unknown[] };
  }
  export const globalAgent: Agent;
  export interface ClientRequest {
    readonly destroyed: boolean;
    write(data: string | Uint8Array): void;
    end(data?: string | Uint8Array): void;
    destroy(): void;
    on(event: "response", listener: (res: IncomingMessage) => void): void;
    on(event: "upgrade", listener: (res: IncomingMessage, socket: Socket, head: Buffer) => void): void;
    on(event: "timeout" | "close", listener: () => void): void;
    on(event: "error", listener: (err: Error) => void): void;
    /* addListener IS on (Node aliases them) — the suite spells both. */
    addListener(event: "response", listener: (res: IncomingMessage) => void): void;
    addListener(event: "upgrade", listener: (res: IncomingMessage, socket: Socket, head: Buffer) => void): void;
    addListener(event: "timeout" | "close", listener: () => void): void;
    addListener(event: "error", listener: (err: Error) => void): void;
    once(event: "response", listener: (res: IncomingMessage) => void): void;
    once(event: "upgrade", listener: (res: IncomingMessage, socket: Socket, head: Buffer) => void): void;
    once(event: "timeout" | "close", listener: () => void): void;
    once(event: "error", listener: (err: Error) => void): void;
  }
  export function createServer(
    requestListener?: (req: IncomingMessage, res: ServerResponse) => void,
  ): Server;
  export function createServer(
    options: ServerOptions,
    requestListener?: (req: IncomingMessage, res: ServerResponse) => void,
  ): Server;
  /* One signature with a UNION first parameter rather than Node's two
   * overloads: `const requestFn = tls ? https.request : http.request`
   * (the portless isProxyRunning shape) unions two function types, and
   * resolving a call on that union collapses each constituent to a
   * single signature — with an overload SET on both sides the options
   * literal ends up checked against URL, in either declaration order.
   * A union parameter has nothing to collapse. The lowering dispatches
   * on the argument's own type, so it reads the same either way.
   *
   * `target` is a URL string or URL object (the spelling a from-scratch
   * client reaches for first — dialed directly, with a non-http scheme
   * an ERR_INVALID_PROTOCOL at runtime rather than a type error), or
   * the options record. */
  export function request(
    target: RequestOptions | string | URL,
    callback?: (res: IncomingMessage) => void,
  ): ClientRequest;
  export function get(
    target: RequestOptions | string | URL,
    callback?: (res: IncomingMessage) => void,
  ): ClientRequest;
}
declare module "node:http" {
  export * from "http";
}

/* node:tls — the TLS server slice (scr_tls.c over scr_net.c with the
 * vendored mbedTLS; linked only into using binaries).
 * createServer({ cert, key }, handler) returns a net.Server; the handler
 * is Node's 'secureConnection' — it fires post-handshake with a socket
 * that behaves exactly like a net socket (write/end/destroy/pipe and the
 * data/end/close/error events are the same lowered surface). cert/key
 * are PEM strings or Buffers. Handshake failures tear the socket down
 * silently, Node's default for 'tlsClientError' with no listener. */
declare module "tls" {
  import { Server, Socket } from "net";
  export { Server };
  export interface TlsOptions {
    /* Optional in the DECLARATION only (real Node programs build these
     * literals with every TLS knob): the lowering still requires both —
     * a literal without them fences at the call site. */
    cert?: string | Uint8Array;
    key?: string | Uint8Array;
    /* The options-record stance (see http.RequestOptions): every key
     * typechecks; the option walk fences documented-but-unlowered keys
     * by name and drops undocumented ones like Node. */
    [option: string]: unknown;
  }
  export function createServer(
    options: TlsOptions,
    secureConnectionListener?: (socket: Socket) => void,
  ): Server;
  /** TLSSocket — post-handshake it IS a net socket to every lowered
   * member (the mapping collapses it onto the socket kind; the
   * secureConnect/session events ride the shared socket declarations).
   * The TLS extras: authorized/authorizationError answer Node's verify
   * split — authorizationError is the verify-failure CODE STRING
   * (DEPTH_ZERO_SELF_SIGNED_CERT, ...), or null. */
  export interface TLSSocket extends Socket {
    authorized: boolean;
    authorizationError: string | null;
  }
  /** tls.connect options — the RUNTIME options record (members read at
   * runtime; port/host/rejectUnauthorized/ca/servername are the
   * honestly-implemented set, every other documented member throws the
   * runtime fence — the options-record stance's divergence-66 shape). */
  export interface ConnectionOptions {
    port?: number;
    host?: string;
    rejectUnauthorized?: boolean;
    ca?: string | Uint8Array | ReadonlyArray<string | Uint8Array>;
    servername?: string;
    [option: string]: unknown;
  }
  export function connect(options: ConnectionOptions, secureConnectListener?: () => void): TLSSocket;
  export function connect(port: number, options?: ConnectionOptions, secureConnectListener?: () => void): TLSSocket;
  export function connect(port: number, host?: string, options?: ConnectionOptions, secureConnectListener?: () => void): TLSSocket;
  /** An opaque parsed cert/key pair — what an SNI callback answers with
   * (the value is a runtime handle; the members are runtime-internal). */
  export interface SecureContext {}
  export function createSecureContext(options: TlsOptions): SecureContext;
  /** The CA-store introspection surface (scr_tls_ca.c): per-type cached
   * PEM string arrays. The host bundle stands in for Node's compiled-in
   * Mozilla roots ('bundled', and rootCertificates) AND the platform
   * store ('system') — the Windows certificate stores or POSIX bundle probe;
   * 'extra' reads NODE_EXTRA_CA_CERTS. An unknown type string throws
   * Node's ERR_INVALID_ARG_VALUE TypeError. */
  export function getCACertificates(type?: string): string[];
  export const rootCertificates: readonly string[];
  /** Replaces the 'default' set (deduped) and the trust anchors the TLS
   * client verifies against; a certificate-free non-empty array throws
   * Node's ERR_CRYPTO_OPERATION_FAILED Error. */
  export function setDefaultCACertificates(certs: readonly string[]): void;
}
declare module "node:tls" {
  export * from "tls";
}

/* node:https — http over the TLS transport (scr_tls.c).
 * createServer({ cert, key }, handler) is the http server behind a
 * handshake; request/get are the http client with port 443 default and
 * the local-CA knobs: `ca` (PEM string/Buffer) replaces the trust
 * anchors, rejectUnauthorized: false disables verification (the
 * self-signed probe shape). With neither, /etc/ssl/cert.pem stands in
 * for Node's bundled roots. */
declare module "https" {
  import { Server } from "http";
  import { Agent, ClientRequest, IncomingMessage, ServerResponse } from "http";
  export { Agent, Server };
  export interface ServerOptions {
    cert: string | Uint8Array;
    key: string | Uint8Array;
    /* The options-record stance (see http.RequestOptions). */
    [option: string]: unknown;
  }
  export interface RequestOptions {
    hostname?: string;
    host?: string;
    port?: number;
    path?: string;
    method?: string;
    timeout?: number;
    headers?: { [name: string]: string };
    rejectUnauthorized?: boolean;
    ca?: string | Uint8Array;
    agent?: Agent | boolean | null;
    /* The options-record stance (see http.RequestOptions). */
    [option: string]: unknown;
  }
  export function createServer(
    options: ServerOptions,
    requestListener: (req: IncomingMessage, res: ServerResponse) => void,
  ): Server;
  /* One signature with a union first parameter, for the request-fn
   * ternary's sake (see the http block). A URL target takes no options,
   * which means Node's defaults — the certificate is verified against
   * the default trust anchors. */
  export function request(
    target: RequestOptions | string | URL,
    callback?: (res: IncomingMessage) => void,
  ): ClientRequest;
  export function get(
    target: RequestOptions | string | URL,
    callback?: (res: IncomingMessage) => void,
  ): ClientRequest;
}
declare module "node:https" {
  export * from "https";
}

/* node:http2 — the compatibility surface: allowHTTP1 servers negotiate
 * h2 or HTTP/1.1 and expose the shared request/response API. HTTP/2
 * requests retain their backing stream; server session failures surface
 * through sessionError. */
declare module "http2" {
  import { Socket } from "net";
  export interface Http2Stream {
    on(event: "error" | "close", listener: (err: Error) => void): void;
    once(event: "error" | "close", listener: (err: Error) => void): void;
    destroy(): void;
  }
  export interface Http2ServerRequest {
    readonly url: string;
    readonly method: string;
    readonly statusCode: number | undefined;
    readonly socket: Socket;
    readonly headers: { [name: string]: string | undefined };
    readonly stream: Http2Stream;
    /* The h2 compat request's version triple ("2.0" over real h2 streams;
     * the allowHTTP1 lowering's HTTP/1.1 connections answer 1.x). */
    readonly httpVersion: string;
    readonly httpVersionMajor: number;
    readonly httpVersionMinor: number;
    readonly aborted: boolean;
    readonly complete: boolean;
    resume(): void;
    destroy(): void;
    setEncoding(encoding: string): void;
    pipe(destination: Socket | import("http").ClientRequest): void;
    on(event: "data", listener: (chunk: Buffer) => void): void;
    on(event: "end" | "close" | "aborted", listener: () => void): void;
    on(event: "error", listener: (err: Error) => void): void;
    /* addListener IS on (Node aliases them) — and the compat req IS the
     * http.IncomingMessage surface, so the alias mirrors here too. */
    addListener(event: "data", listener: (chunk: Buffer) => void): void;
    addListener(event: "end" | "close" | "aborted", listener: () => void): void;
    addListener(event: "error", listener: (err: Error) => void): void;
    once(event: "data", listener: (chunk: Buffer) => void): void;
    once(event: "end" | "close" | "aborted", listener: () => void): void;
    once(event: "error", listener: (err: Error) => void): void;
  }
  export interface Http2ServerResponse {
    readonly headersSent: boolean;
    /* The same lowered surface as http.ServerResponse — the allowHTTP1
     * lowering serves every connection as HTTP/1.1, where the compat
     * response IS this parser's response handle. */
    statusCode: number;
    statusMessage: string;
    setHeader(name: string, value: string | number): void;
    getHeader(name: string): string | undefined;
    hasHeader(name: string): boolean;
    removeHeader(name: string): void;
    writeHead(statusCode: number, headers?: import("http").OutgoingHttpHeaders | string[]): Http2ServerResponse;
    writeHead(statusCode: number, statusMessage: string, headers?: import("http").OutgoingHttpHeaders | string[]): Http2ServerResponse;
    write(data: string | Uint8Array): void;
    end(data?: string | Uint8Array, callback?: () => void): void;
    end(callback: () => void): void;
    destroy(): void;
    on(event: "close", listener: () => void): void;
    /* addListener IS on (Node aliases them) — and the compat res IS the
     * http.ServerResponse surface (assignability into ServerResponse
     * unions — IncomingMessage.pipe's destination — needs the alias). */
    addListener(event: "close", listener: () => void): void;
    once(event: "close", listener: () => void): void;
  }
  export interface Http2SecureServer {
    listen(port: number, callback?: () => void): void;
    close(callback?: () => void): void;
    /* The bound AddressInfo (Node answers null before listen — this
     * surface answers the record with port 0 there, the serverPort
     * stance). */
    address(): import("node:dgram").AddressInfo;
    emit(event: "connection", socket: Socket): void;
    on(event: "connection", listener: (socket: Socket) => void): void;
    on(event: "request", listener: (req: Http2ServerRequest, res: Http2ServerResponse) => void): void;
    on(event: "error", listener: (err: Error) => void): void;
    on(event: "close", listener: () => void): void;
    on(event: "sessionError", listener: (err: Error, session: ServerHttp2Session) => void): void;
    /* The ALPN=h2 server's surface (createSecureServer WITHOUT
     * allowHTTP1 — the real h2-over-TLS stack): per-stream and
     * per-session listeners, exactly the h2c server's. */
    on(event: "stream", listener: (stream: ServerHttp2Stream, headers: IncomingHttpHeaders, flags: number) => void): void;
    on(event: "session", listener: (session: ServerHttp2Session) => void): void;
    once(event: "stream", listener: (stream: ServerHttp2Stream, headers: IncomingHttpHeaders, flags: number) => void): void;
    once(event: "session", listener: (session: ServerHttp2Session) => void): void;
    /* HTTP CONNECT (and, in Node, the h2 extended CONNECT — which the
     * allowHTTP1 lowering never sees): the second argument is the raw
     * socket on HTTP/1.1 connections; narrow with instanceof. */
    on(event: "connect", listener: (req: Http2ServerRequest | import("http").IncomingMessage, resOrSocket: Http2ServerResponse | Socket) => void): void;
    once(event: "connection", listener: (socket: Socket) => void): void;
    once(event: "request", listener: (req: Http2ServerRequest, res: Http2ServerResponse) => void): void;
    once(event: "error", listener: (err: Error) => void): void;
    once(event: "close", listener: () => void): void;
  }
  export interface SecureServerOptions {
    allowHTTP1?: boolean;
    cert?: string | Uint8Array;
    key?: string | Uint8Array;
    SNICallback?: (
      servername: string,
      cb: (err: Error | null, ctx?: import("tls").SecureContext) => void,
    ) => void;
    /* The options-record stance (see http.RequestOptions): h2 session-
     * tuning knobs are accepted as literals and ignored (no h2 session
     * ever exists under the allowHTTP1 lowering); other documented keys
     * fence by name; undocumented keys drop like Node. */
    [option: string]: unknown;
  }
  /* The full Node v24 constants table (240 members), literal-typed so
   * computed header keys ([HTTP2_HEADER_PATH]: value) stay literal keys.
   * Every ACCESS bakes as its literal at lowering; the object itself
   * never materializes (bare http2.constants value uses fence). */
  export interface Http2Constants {
    readonly NGHTTP2_ERR_FRAME_SIZE_ERROR: -522;
    readonly NGHTTP2_SESSION_SERVER: 0;
    readonly NGHTTP2_SESSION_CLIENT: 1;
    readonly NGHTTP2_STREAM_STATE_IDLE: 1;
    readonly NGHTTP2_STREAM_STATE_OPEN: 2;
    readonly NGHTTP2_STREAM_STATE_RESERVED_LOCAL: 3;
    readonly NGHTTP2_STREAM_STATE_RESERVED_REMOTE: 4;
    readonly NGHTTP2_STREAM_STATE_HALF_CLOSED_LOCAL: 5;
    readonly NGHTTP2_STREAM_STATE_HALF_CLOSED_REMOTE: 6;
    readonly NGHTTP2_STREAM_STATE_CLOSED: 7;
    readonly NGHTTP2_FLAG_NONE: 0;
    readonly NGHTTP2_FLAG_END_STREAM: 1;
    readonly NGHTTP2_FLAG_END_HEADERS: 4;
    readonly NGHTTP2_FLAG_ACK: 1;
    readonly NGHTTP2_FLAG_PADDED: 8;
    readonly NGHTTP2_FLAG_PRIORITY: 32;
    readonly DEFAULT_SETTINGS_HEADER_TABLE_SIZE: 4096;
    readonly DEFAULT_SETTINGS_ENABLE_PUSH: 1;
    readonly DEFAULT_SETTINGS_MAX_CONCURRENT_STREAMS: 4294967295;
    readonly DEFAULT_SETTINGS_INITIAL_WINDOW_SIZE: 65535;
    readonly DEFAULT_SETTINGS_MAX_FRAME_SIZE: 16384;
    readonly DEFAULT_SETTINGS_MAX_HEADER_LIST_SIZE: 65535;
    readonly DEFAULT_SETTINGS_ENABLE_CONNECT_PROTOCOL: 0;
    readonly MAX_MAX_FRAME_SIZE: 16777215;
    readonly MIN_MAX_FRAME_SIZE: 16384;
    readonly MAX_INITIAL_WINDOW_SIZE: 2147483647;
    readonly NGHTTP2_SETTINGS_HEADER_TABLE_SIZE: 1;
    readonly NGHTTP2_SETTINGS_ENABLE_PUSH: 2;
    readonly NGHTTP2_SETTINGS_MAX_CONCURRENT_STREAMS: 3;
    readonly NGHTTP2_SETTINGS_INITIAL_WINDOW_SIZE: 4;
    readonly NGHTTP2_SETTINGS_MAX_FRAME_SIZE: 5;
    readonly NGHTTP2_SETTINGS_MAX_HEADER_LIST_SIZE: 6;
    readonly NGHTTP2_SETTINGS_ENABLE_CONNECT_PROTOCOL: 8;
    readonly PADDING_STRATEGY_NONE: 0;
    readonly PADDING_STRATEGY_ALIGNED: 1;
    readonly PADDING_STRATEGY_MAX: 2;
    readonly PADDING_STRATEGY_CALLBACK: 1;
    readonly NGHTTP2_NO_ERROR: 0;
    readonly NGHTTP2_PROTOCOL_ERROR: 1;
    readonly NGHTTP2_INTERNAL_ERROR: 2;
    readonly NGHTTP2_FLOW_CONTROL_ERROR: 3;
    readonly NGHTTP2_SETTINGS_TIMEOUT: 4;
    readonly NGHTTP2_STREAM_CLOSED: 5;
    readonly NGHTTP2_FRAME_SIZE_ERROR: 6;
    readonly NGHTTP2_REFUSED_STREAM: 7;
    readonly NGHTTP2_CANCEL: 8;
    readonly NGHTTP2_COMPRESSION_ERROR: 9;
    readonly NGHTTP2_CONNECT_ERROR: 10;
    readonly NGHTTP2_ENHANCE_YOUR_CALM: 11;
    readonly NGHTTP2_INADEQUATE_SECURITY: 12;
    readonly NGHTTP2_HTTP_1_1_REQUIRED: 13;
    readonly NGHTTP2_DEFAULT_WEIGHT: 16;
    readonly HTTP2_HEADER_STATUS: ":status";
    readonly HTTP2_HEADER_METHOD: ":method";
    readonly HTTP2_HEADER_AUTHORITY: ":authority";
    readonly HTTP2_HEADER_SCHEME: ":scheme";
    readonly HTTP2_HEADER_PATH: ":path";
    readonly HTTP2_HEADER_PROTOCOL: ":protocol";
    readonly HTTP2_HEADER_ACCEPT_ENCODING: "accept-encoding";
    readonly HTTP2_HEADER_ACCEPT_LANGUAGE: "accept-language";
    readonly HTTP2_HEADER_ACCEPT_RANGES: "accept-ranges";
    readonly HTTP2_HEADER_ACCEPT: "accept";
    readonly HTTP2_HEADER_ACCESS_CONTROL_ALLOW_CREDENTIALS: "access-control-allow-credentials";
    readonly HTTP2_HEADER_ACCESS_CONTROL_ALLOW_HEADERS: "access-control-allow-headers";
    readonly HTTP2_HEADER_ACCESS_CONTROL_ALLOW_METHODS: "access-control-allow-methods";
    readonly HTTP2_HEADER_ACCESS_CONTROL_ALLOW_ORIGIN: "access-control-allow-origin";
    readonly HTTP2_HEADER_ACCESS_CONTROL_EXPOSE_HEADERS: "access-control-expose-headers";
    readonly HTTP2_HEADER_ACCESS_CONTROL_REQUEST_HEADERS: "access-control-request-headers";
    readonly HTTP2_HEADER_ACCESS_CONTROL_REQUEST_METHOD: "access-control-request-method";
    readonly HTTP2_HEADER_AGE: "age";
    readonly HTTP2_HEADER_AUTHORIZATION: "authorization";
    readonly HTTP2_HEADER_CACHE_CONTROL: "cache-control";
    readonly HTTP2_HEADER_CONNECTION: "connection";
    readonly HTTP2_HEADER_CONTENT_DISPOSITION: "content-disposition";
    readonly HTTP2_HEADER_CONTENT_ENCODING: "content-encoding";
    readonly HTTP2_HEADER_CONTENT_LENGTH: "content-length";
    readonly HTTP2_HEADER_CONTENT_TYPE: "content-type";
    readonly HTTP2_HEADER_COOKIE: "cookie";
    readonly HTTP2_HEADER_DATE: "date";
    readonly HTTP2_HEADER_ETAG: "etag";
    readonly HTTP2_HEADER_FORWARDED: "forwarded";
    readonly HTTP2_HEADER_HOST: "host";
    readonly HTTP2_HEADER_IF_MODIFIED_SINCE: "if-modified-since";
    readonly HTTP2_HEADER_IF_NONE_MATCH: "if-none-match";
    readonly HTTP2_HEADER_IF_RANGE: "if-range";
    readonly HTTP2_HEADER_LAST_MODIFIED: "last-modified";
    readonly HTTP2_HEADER_LINK: "link";
    readonly HTTP2_HEADER_LOCATION: "location";
    readonly HTTP2_HEADER_RANGE: "range";
    readonly HTTP2_HEADER_REFERER: "referer";
    readonly HTTP2_HEADER_SERVER: "server";
    readonly HTTP2_HEADER_SET_COOKIE: "set-cookie";
    readonly HTTP2_HEADER_STRICT_TRANSPORT_SECURITY: "strict-transport-security";
    readonly HTTP2_HEADER_TRANSFER_ENCODING: "transfer-encoding";
    readonly HTTP2_HEADER_TE: "te";
    readonly HTTP2_HEADER_UPGRADE_INSECURE_REQUESTS: "upgrade-insecure-requests";
    readonly HTTP2_HEADER_UPGRADE: "upgrade";
    readonly HTTP2_HEADER_USER_AGENT: "user-agent";
    readonly HTTP2_HEADER_VARY: "vary";
    readonly HTTP2_HEADER_X_CONTENT_TYPE_OPTIONS: "x-content-type-options";
    readonly HTTP2_HEADER_X_FRAME_OPTIONS: "x-frame-options";
    readonly HTTP2_HEADER_KEEP_ALIVE: "keep-alive";
    readonly HTTP2_HEADER_PROXY_CONNECTION: "proxy-connection";
    readonly HTTP2_HEADER_X_XSS_PROTECTION: "x-xss-protection";
    readonly HTTP2_HEADER_ALT_SVC: "alt-svc";
    readonly HTTP2_HEADER_CONTENT_SECURITY_POLICY: "content-security-policy";
    readonly HTTP2_HEADER_EARLY_DATA: "early-data";
    readonly HTTP2_HEADER_EXPECT_CT: "expect-ct";
    readonly HTTP2_HEADER_ORIGIN: "origin";
    readonly HTTP2_HEADER_PURPOSE: "purpose";
    readonly HTTP2_HEADER_TIMING_ALLOW_ORIGIN: "timing-allow-origin";
    readonly HTTP2_HEADER_X_FORWARDED_FOR: "x-forwarded-for";
    readonly HTTP2_HEADER_PRIORITY: "priority";
    readonly HTTP2_HEADER_ACCEPT_CHARSET: "accept-charset";
    readonly HTTP2_HEADER_ACCESS_CONTROL_MAX_AGE: "access-control-max-age";
    readonly HTTP2_HEADER_ALLOW: "allow";
    readonly HTTP2_HEADER_CONTENT_LANGUAGE: "content-language";
    readonly HTTP2_HEADER_CONTENT_LOCATION: "content-location";
    readonly HTTP2_HEADER_CONTENT_MD5: "content-md5";
    readonly HTTP2_HEADER_CONTENT_RANGE: "content-range";
    readonly HTTP2_HEADER_DNT: "dnt";
    readonly HTTP2_HEADER_EXPECT: "expect";
    readonly HTTP2_HEADER_EXPIRES: "expires";
    readonly HTTP2_HEADER_FROM: "from";
    readonly HTTP2_HEADER_IF_MATCH: "if-match";
    readonly HTTP2_HEADER_IF_UNMODIFIED_SINCE: "if-unmodified-since";
    readonly HTTP2_HEADER_MAX_FORWARDS: "max-forwards";
    readonly HTTP2_HEADER_PREFER: "prefer";
    readonly HTTP2_HEADER_PROXY_AUTHENTICATE: "proxy-authenticate";
    readonly HTTP2_HEADER_PROXY_AUTHORIZATION: "proxy-authorization";
    readonly HTTP2_HEADER_REFRESH: "refresh";
    readonly HTTP2_HEADER_RETRY_AFTER: "retry-after";
    readonly HTTP2_HEADER_TRAILER: "trailer";
    readonly HTTP2_HEADER_TK: "tk";
    readonly HTTP2_HEADER_VIA: "via";
    readonly HTTP2_HEADER_WARNING: "warning";
    readonly HTTP2_HEADER_WWW_AUTHENTICATE: "www-authenticate";
    readonly HTTP2_HEADER_HTTP2_SETTINGS: "http2-settings";
    readonly HTTP2_METHOD_ACL: "ACL";
    readonly HTTP2_METHOD_BASELINE_CONTROL: "BASELINE-CONTROL";
    readonly HTTP2_METHOD_BIND: "BIND";
    readonly HTTP2_METHOD_CHECKIN: "CHECKIN";
    readonly HTTP2_METHOD_CHECKOUT: "CHECKOUT";
    readonly HTTP2_METHOD_CONNECT: "CONNECT";
    readonly HTTP2_METHOD_COPY: "COPY";
    readonly HTTP2_METHOD_DELETE: "DELETE";
    readonly HTTP2_METHOD_GET: "GET";
    readonly HTTP2_METHOD_HEAD: "HEAD";
    readonly HTTP2_METHOD_LABEL: "LABEL";
    readonly HTTP2_METHOD_LINK: "LINK";
    readonly HTTP2_METHOD_LOCK: "LOCK";
    readonly HTTP2_METHOD_MERGE: "MERGE";
    readonly HTTP2_METHOD_MKACTIVITY: "MKACTIVITY";
    readonly HTTP2_METHOD_MKCALENDAR: "MKCALENDAR";
    readonly HTTP2_METHOD_MKCOL: "MKCOL";
    readonly HTTP2_METHOD_MKREDIRECTREF: "MKREDIRECTREF";
    readonly HTTP2_METHOD_MKWORKSPACE: "MKWORKSPACE";
    readonly HTTP2_METHOD_MOVE: "MOVE";
    readonly HTTP2_METHOD_OPTIONS: "OPTIONS";
    readonly HTTP2_METHOD_ORDERPATCH: "ORDERPATCH";
    readonly HTTP2_METHOD_PATCH: "PATCH";
    readonly HTTP2_METHOD_POST: "POST";
    readonly HTTP2_METHOD_PRI: "PRI";
    readonly HTTP2_METHOD_PROPFIND: "PROPFIND";
    readonly HTTP2_METHOD_PROPPATCH: "PROPPATCH";
    readonly HTTP2_METHOD_PUT: "PUT";
    readonly HTTP2_METHOD_REBIND: "REBIND";
    readonly HTTP2_METHOD_REPORT: "REPORT";
    readonly HTTP2_METHOD_SEARCH: "SEARCH";
    readonly HTTP2_METHOD_TRACE: "TRACE";
    readonly HTTP2_METHOD_UNBIND: "UNBIND";
    readonly HTTP2_METHOD_UNCHECKOUT: "UNCHECKOUT";
    readonly HTTP2_METHOD_UNLINK: "UNLINK";
    readonly HTTP2_METHOD_UNLOCK: "UNLOCK";
    readonly HTTP2_METHOD_UPDATE: "UPDATE";
    readonly HTTP2_METHOD_UPDATEREDIRECTREF: "UPDATEREDIRECTREF";
    readonly HTTP2_METHOD_VERSION_CONTROL: "VERSION-CONTROL";
    readonly HTTP_STATUS_CONTINUE: 100;
    readonly HTTP_STATUS_SWITCHING_PROTOCOLS: 101;
    readonly HTTP_STATUS_PROCESSING: 102;
    readonly HTTP_STATUS_EARLY_HINTS: 103;
    readonly HTTP_STATUS_OK: 200;
    readonly HTTP_STATUS_CREATED: 201;
    readonly HTTP_STATUS_ACCEPTED: 202;
    readonly HTTP_STATUS_NON_AUTHORITATIVE_INFORMATION: 203;
    readonly HTTP_STATUS_NO_CONTENT: 204;
    readonly HTTP_STATUS_RESET_CONTENT: 205;
    readonly HTTP_STATUS_PARTIAL_CONTENT: 206;
    readonly HTTP_STATUS_MULTI_STATUS: 207;
    readonly HTTP_STATUS_ALREADY_REPORTED: 208;
    readonly HTTP_STATUS_IM_USED: 226;
    readonly HTTP_STATUS_MULTIPLE_CHOICES: 300;
    readonly HTTP_STATUS_MOVED_PERMANENTLY: 301;
    readonly HTTP_STATUS_FOUND: 302;
    readonly HTTP_STATUS_SEE_OTHER: 303;
    readonly HTTP_STATUS_NOT_MODIFIED: 304;
    readonly HTTP_STATUS_USE_PROXY: 305;
    readonly HTTP_STATUS_TEMPORARY_REDIRECT: 307;
    readonly HTTP_STATUS_PERMANENT_REDIRECT: 308;
    readonly HTTP_STATUS_BAD_REQUEST: 400;
    readonly HTTP_STATUS_UNAUTHORIZED: 401;
    readonly HTTP_STATUS_PAYMENT_REQUIRED: 402;
    readonly HTTP_STATUS_FORBIDDEN: 403;
    readonly HTTP_STATUS_NOT_FOUND: 404;
    readonly HTTP_STATUS_METHOD_NOT_ALLOWED: 405;
    readonly HTTP_STATUS_NOT_ACCEPTABLE: 406;
    readonly HTTP_STATUS_PROXY_AUTHENTICATION_REQUIRED: 407;
    readonly HTTP_STATUS_REQUEST_TIMEOUT: 408;
    readonly HTTP_STATUS_CONFLICT: 409;
    readonly HTTP_STATUS_GONE: 410;
    readonly HTTP_STATUS_LENGTH_REQUIRED: 411;
    readonly HTTP_STATUS_PRECONDITION_FAILED: 412;
    readonly HTTP_STATUS_PAYLOAD_TOO_LARGE: 413;
    readonly HTTP_STATUS_URI_TOO_LONG: 414;
    readonly HTTP_STATUS_UNSUPPORTED_MEDIA_TYPE: 415;
    readonly HTTP_STATUS_RANGE_NOT_SATISFIABLE: 416;
    readonly HTTP_STATUS_EXPECTATION_FAILED: 417;
    readonly HTTP_STATUS_TEAPOT: 418;
    readonly HTTP_STATUS_MISDIRECTED_REQUEST: 421;
    readonly HTTP_STATUS_UNPROCESSABLE_ENTITY: 422;
    readonly HTTP_STATUS_LOCKED: 423;
    readonly HTTP_STATUS_FAILED_DEPENDENCY: 424;
    readonly HTTP_STATUS_TOO_EARLY: 425;
    readonly HTTP_STATUS_UPGRADE_REQUIRED: 426;
    readonly HTTP_STATUS_PRECONDITION_REQUIRED: 428;
    readonly HTTP_STATUS_TOO_MANY_REQUESTS: 429;
    readonly HTTP_STATUS_REQUEST_HEADER_FIELDS_TOO_LARGE: 431;
    readonly HTTP_STATUS_UNAVAILABLE_FOR_LEGAL_REASONS: 451;
    readonly HTTP_STATUS_INTERNAL_SERVER_ERROR: 500;
    readonly HTTP_STATUS_NOT_IMPLEMENTED: 501;
    readonly HTTP_STATUS_BAD_GATEWAY: 502;
    readonly HTTP_STATUS_SERVICE_UNAVAILABLE: 503;
    readonly HTTP_STATUS_GATEWAY_TIMEOUT: 504;
    readonly HTTP_STATUS_HTTP_VERSION_NOT_SUPPORTED: 505;
    readonly HTTP_STATUS_VARIANT_ALSO_NEGOTIATES: 506;
    readonly HTTP_STATUS_INSUFFICIENT_STORAGE: 507;
    readonly HTTP_STATUS_LOOP_DETECTED: 508;
    readonly HTTP_STATUS_BANDWIDTH_LIMIT_EXCEEDED: 509;
    readonly HTTP_STATUS_NOT_EXTENDED: 510;
    readonly HTTP_STATUS_NETWORK_AUTHENTICATION_REQUIRED: 511;
  }
  export const constants: Http2Constants;
  /* The eager handler is the first COMPAT 'request' listener — Node's
   * route on either flavor (the allowHTTP1 server's HTTP/1.1 handles,
   * the ALPN=h2 server's compat handles over streams). */
  export function createSecureServer(
    options: SecureServerOptions,
    onRequestHandler?: (req: import("http").IncomingMessage, res: import("http").ServerResponse) => void,
  ): Http2SecureServer;

  /* ── the REAL h2c surface (scr_http2.c: frame codec + HPACK over the
   * net loop) — createServer/connect and the session/stream handles the
   * Node suite's http2 family exercises. Headers cross as the canonical
   * header record (the IncomingHttpHeaders index-signature shape); the
   * response :status reads back as a number. Members declared here
   * without a lowering fence by name at their use sites. */

  /** The http2 module's own header shapes: pure index-signature records
   * (the HEADER-FAMILY canonicalization — string[] arm included). */
  export interface IncomingHttpHeaders {
    [name: string]: number | string | string[] | undefined;
  }
  export interface OutgoingHttpHeaders {
    [name: string]: number | string | string[] | undefined;
  }

  export interface Http2Session {
    close(callback?: () => void): void;
    destroy(): void;
    readonly closed: boolean;
    readonly destroyed: boolean;
    readonly encrypted: boolean;
    readonly type: number;
    readonly alpnProtocol: string;
    readonly socket: import("net").Socket;
    readonly pendingSettingsAck: boolean;
    ref(): void;
    unref(): void;
    setTimeout(msecs: number, callback?: () => void): void;
    ping(callback: (err: Error | null, duration: number, payload: Uint8Array) => void): boolean;
    /* The settings surface rides the checked-dynamic machinery (records
     * cross as dyn values — the suite's mustCall listeners are dyn). */
    settings(settings?: any, callback?: any): void;
    readonly localSettings: any;
    readonly remoteSettings: any;
    goaway(code?: number, lastStreamID?: number, opaqueData?: Uint8Array): void;
    on(event: "close" | "timeout", listener: () => void): void;
    on(event: "error", listener: (err: Error) => void): void;
    on(event: "connect", listener: (session: Http2Session, socket: import("net").Socket) => void): void;
    on(event: "stream", listener: (stream: ServerHttp2Stream, headers: IncomingHttpHeaders, flags: number) => void): void;
    on(event: "goaway", listener: (errorCode: number, lastStreamID: number, opaqueData?: Uint8Array) => void): void;
    on(event: "localSettings" | "remoteSettings", listener: (settings: any) => void): void;
    on(event: "frameError", listener: (type: number, code: number, id: number) => void): void;
    on(event: "ping", listener: (payload: Uint8Array) => void): void;
    once(event: "close" | "timeout", listener: () => void): void;
    once(event: "error", listener: (err: Error) => void): void;
    once(event: "connect", listener: (session: Http2Session, socket: import("net").Socket) => void): void;
    once(event: "stream", listener: (stream: ServerHttp2Stream, headers: IncomingHttpHeaders, flags: number) => void): void;
    once(event: "goaway", listener: (errorCode: number, lastStreamID: number, opaqueData?: Uint8Array) => void): void;
    once(event: "localSettings" | "remoteSettings", listener: (settings: any) => void): void;
  }

  export interface ClientHttp2Session extends Http2Session {
    request(headers?: OutgoingHttpHeaders, options?: { endStream?: boolean; exclusive?: boolean; parent?: number; weight?: number; waitForTrailers?: boolean }): ClientHttp2Stream;
  }

  export interface ServerHttp2Session extends Http2Session {
    altsvc(alt: string, originOrStream: number | string): void;
    origin(...origins: string[]): void;
  }

  /** The shared Http2Stream core (both roles). 'data' chunks are Buffers
   * (strings once setEncoding('utf8') is in force — the IncomingMessage
   * chunk:any stance keeps both working). */
  interface Http2StreamCore {
    readonly id: number | undefined;
    readonly rstCode: number;
    readonly closed: boolean;
    readonly destroyed: boolean;
    readonly pending: boolean;
    readonly aborted: boolean;
    readonly session: Http2Session;
    readonly sentHeaders: OutgoingHttpHeaders;
    readonly state: Record<string, number>;
    write(chunk: string | Uint8Array, callback?: (err?: Error | null) => void): boolean;
    end(data?: string | Uint8Array, callback?: () => void): void;
    end(callback: () => void): void;
    close(code?: number, callback?: () => void): void;
    destroy(error?: Error): void;
    setEncoding(encoding: string): this;
    resume(): void;
    pause(): void;
    setTimeout(msecs: number, callback?: () => void): void;
    priority(options: Record<string, number | boolean>): void;
    sendTrailers(headers: OutgoingHttpHeaders): void;
  }

  export interface ServerHttp2Stream extends Http2StreamCore {
    on(event: "data", listener: (chunk: any) => void): void;
    on(event: "end" | "close" | "aborted" | "ready" | "timeout" | "drain" | "finish" | "wantTrailers", listener: () => void): void;
    on(event: "error", listener: (err: Error) => void): void;
    on(event: "frameError", listener: (type: number, code: number, id: number) => void): void;
    on(event: "trailers", listener: (trailers: IncomingHttpHeaders, flags: number) => void): void;
    once(event: "data", listener: (chunk: any) => void): void;
    once(event: "end" | "close" | "aborted" | "ready" | "timeout" | "drain" | "finish" | "wantTrailers", listener: () => void): void;
    once(event: "error", listener: (err: Error) => void): void;
    once(event: "trailers", listener: (trailers: IncomingHttpHeaders, flags: number) => void): void;
    respond(headers?: OutgoingHttpHeaders, options?: { endStream?: boolean; waitForTrailers?: boolean }): void;
    respondWithFile(path: string, headers?: OutgoingHttpHeaders, options?: Record<string, unknown>): void;
    respondWithFD(fd: number, headers?: OutgoingHttpHeaders, options?: Record<string, unknown>): void;
    pushStream(headers: OutgoingHttpHeaders, callback: (err: Error | null, pushStream: ServerHttp2Stream, headers: OutgoingHttpHeaders) => void): void;
    readonly headersSent: boolean;
    readonly pushAllowed: boolean;
    additionalHeaders(headers: OutgoingHttpHeaders): void;
  }

  export interface ClientHttp2Stream extends Http2StreamCore {
    on(event: "response", listener: (headers: IncomingHttpHeaders, flags: number) => void): void;
    on(event: "push", listener: (headers: IncomingHttpHeaders, flags: number) => void): void;
    on(event: "headers", listener: (headers: IncomingHttpHeaders, flags: number) => void): void;
    on(event: "data", listener: (chunk: any) => void): void;
    on(event: "end" | "close" | "aborted" | "ready" | "timeout" | "drain" | "finish" | "wantTrailers", listener: () => void): void;
    on(event: "error", listener: (err: Error) => void): void;
    on(event: "frameError", listener: (type: number, code: number, id: number) => void): void;
    on(event: "trailers", listener: (trailers: IncomingHttpHeaders, flags: number) => void): void;
    once(event: "response", listener: (headers: IncomingHttpHeaders, flags: number) => void): void;
    once(event: "push", listener: (headers: IncomingHttpHeaders, flags: number) => void): void;
    once(event: "data", listener: (chunk: any) => void): void;
    once(event: "end" | "close" | "aborted" | "ready" | "timeout" | "drain" | "finish" | "wantTrailers", listener: () => void): void;
    once(event: "error", listener: (err: Error) => void): void;
  }

  export interface Http2Server {
    listen(port?: number, callback?: () => void): void;
    listen(port: number, host: string, callback?: () => void): void;
    close(callback?: () => void): void;
    address(): import("node:dgram").AddressInfo;
    setTimeout(msecs?: number, callback?: () => void): void;
    ref(): void;
    unref(): void;
    on(event: "stream", listener: (stream: ServerHttp2Stream, headers: IncomingHttpHeaders, flags: number) => void): void;
    on(event: "session", listener: (session: ServerHttp2Session) => void): void;
    on(event: "request", listener: (req: Http2ServerRequest, res: Http2ServerResponse) => void): void;
    on(event: "error", listener: (err: Error) => void): void;
    on(event: "close" | "listening" | "timeout", listener: () => void): void;
    on(event: "connection", listener: (socket: import("net").Socket) => void): void;
    on(event: "sessionError", listener: (err: Error, session: ServerHttp2Session) => void): void;
    once(event: "stream", listener: (stream: ServerHttp2Stream, headers: IncomingHttpHeaders, flags: number) => void): void;
    once(event: "session", listener: (session: ServerHttp2Session) => void): void;
    once(event: "request", listener: (req: Http2ServerRequest, res: Http2ServerResponse) => void): void;
    once(event: "error", listener: (err: Error) => void): void;
    once(event: "close" | "listening" | "timeout", listener: () => void): void;
  }

  export interface ServerOptions {
    [option: string]: unknown;
  }

  export function createServer(onRequestHandler?: (req: Http2ServerRequest, res: Http2ServerResponse) => void): Http2Server;
  export function createServer(options: ServerOptions, onRequestHandler?: (req: Http2ServerRequest, res: Http2ServerResponse) => void): Http2Server;

  export function connect(authority: string, listener?: (session: ClientHttp2Session, socket: import("net").Socket) => void): ClientHttp2Session;
  export function connect(authority: string, options: Record<string, unknown>, listener?: (session: ClientHttp2Session, socket: import("net").Socket) => void): ClientHttp2Session;

  export function getDefaultSettings(): any;
  export function getPackedSettings(settings: Record<string, number | boolean>): Uint8Array;
  export const sensitiveHeaders: unique symbol;
}
declare module "node:http2" {
  export * from "http2";
}

/* node:dgram — UDP sockets over the event loop (scr_dgram.c, linked only
 * into using binaries). createSocket takes "udp4" or the
 * { type: "udp4", reuseAddr? } literal; bind/connect bind NOW and defer
 * 'listening'/'connect' to the next loop turn; send takes one string or
 * Buffer datagram with an explicit port + address (the connected-send
 * and callback forms have no lowering); address() returns the real
 * {address, family, port} record and THROWS "Not running" before bind,
 * like Node. 'error' with no listener exits 1 (the unhandled
 * EventEmitter 'error' behavior). Multicast has no lowering. */
declare module "dgram" {
  export interface AddressInfo {
    address: string;
    family: string;
    port: number;
  }
  export interface RemoteInfo {
    address: string;
    family: string;
    port: number;
    size: number;
  }
  export interface Socket {
    bind(port: number, address?: string, callback?: () => void): void;
    connect(port: number, address?: string, callback?: () => void): void;
    send(msg: string | Uint8Array, port: number, address: string): void;
    address(): AddressInfo;
    close(callback?: () => void): void;
    unref(): void;
    ref(): void;
    on(event: "message", listener: (msg: Buffer, rinfo: RemoteInfo) => void): void;
    on(event: "listening" | "close" | "connect", listener: () => void): void;
    on(event: "error", listener: (err: Error) => void): void;
    once(event: "message", listener: (msg: Buffer, rinfo: RemoteInfo) => void): void;
    once(event: "listening" | "close" | "connect", listener: () => void): void;
    once(event: "error", listener: (err: Error) => void): void;
  }
  export function createSocket(type: "udp4"): Socket;
  export function createSocket(options: { type: "udp4"; reuseAddr?: boolean }): Socket;
}
declare module "node:dgram" {
  export * from "dgram";
}

/* node:dns — the lookup slice (scr_dgram.c hosts it; getaddrinfo runs AT
 * CALL TIME and the callback defers to the next loop turn — SEMANTICS.md
 * documents the blocking divergence). Only the { family: 4 } options
 * form lowers; failures deliver Node's error shape ("getaddrinfo
 * ENOTFOUND <hostname>") as the callback's Error argument, with "" for
 * the address where Node passes undefined. */
declare module "dns" {
  export function lookup(
    hostname: string,
    /* The options-record stance (see http.RequestOptions): family is the
     * lowered option ({ family: 4 }); hints/all/order/verbatim fence by
     * name; undocumented keys drop like Node. */
    options: { family: number; [option: string]: unknown },
    callback: (err: Error | null, address: string, family: number) => void,
  ): void;
}
declare module "node:dns" {
  export * from "dns";
}

/* node:worker_threads — the MAIN-THREAD slice only. A compiled binary is
 * always the main thread (no JS-engine thread machinery exists), so
 * isMainThread lowers to `true` and threadId to 0 — Node's main-thread
 * answers exactly. Worker itself is declared surface without a lowering:
 * constructing one fences at the site; the CLASS as a value participates
 * in identity-only flows. */
declare module "worker_threads" {
  export const isMainThread: boolean;
  export const threadId: number;
  export class Worker {
    constructor(filename: string | URL, options?: unknown);
    on(event: string, listener: (...args: unknown[]) => void): void;
    postMessage(value: unknown): void;
    terminate(): Promise<number>;
  }
  export const parentPort: unknown;
  export const workerData: unknown;
}
declare module "node:worker_threads" {
  export * from "worker_threads";
}

/* node:buffer — the module spelling of the Buffer/atob/btoa globals.
 * Buffer re-exports the GLOBAL declaration, so an imported binding
 * resolves to the same symbol the lowerings already answer for (and
 * third-party .d.ts files that `import { Buffer } from "node:buffer"` —
 * file-entry-cache in a typed-JS source graph — typecheck). */
declare module "buffer" {
  export function atob(data: string): string;
  export function btoa(data: string): string;
  export const kMaxLength: number;
  export const kStringMaxLength: number;
  export const Buffer: BufferConstructor;
}
declare module "node:buffer" {
  export * from "buffer";
}

/* node:cluster — the primary-probe slice. A compiled binary never runs
 * as a cluster worker (cluster forks the node binary itself — the
 * mechanism is na for compiled programs), so isPrimary lowers to `true`
 * and isWorker to `false`; everything else is undeclared. */
declare module "cluster" {
  const cluster: {
    readonly isPrimary: boolean;
    readonly isMaster: boolean;
    readonly isWorker: boolean;
  };
  export = cluster;
}
declare module "node:cluster" {
  import cluster = require("cluster");
  export = cluster;
}

/* node:tty — the fd probe (the same isatty(3) behind process.*.isTTY). */
declare module "tty" {
  export function isatty(fd: number): boolean;
}
declare module "node:tty" {
  export * from "tty";
}

/* node:async_hooks — declared surface without lowering: async-hook
 * instrumentation is guarded behind env flags in harness code; a reached
 * use fences at its site. */
declare module "async_hooks" {
  /* AsyncLocalStorage: fiber-carried context snapshots — run/getStore/
   * exit/enterWith/disable lower onto the runtime's active-slot machinery
   * (als.* libCalls); values cross as dyn values. */
  export class AsyncLocalStorage<T = any> {
    constructor();
    run<R>(store: T, callback: (...args: any[]) => R, ...args: any[]): R;
    exit<R>(callback: (...args: any[]) => R, ...args: any[]): R;
    getStore(): T | undefined;
    enterWith(store: T): void;
    disable(): void;
  }
  export interface AsyncHook {
    enable(): AsyncHook;
    disable(): AsyncHook;
  }
  export function createHook(callbacks: {
    init?: (asyncId: number, type: string, triggerAsyncId: number, resource: unknown) => void;
    before?: (asyncId: number) => void;
    after?: (asyncId: number) => void;
    destroy?: (asyncId: number) => void;
  }): AsyncHook;
  export function executionAsyncId(): number;
  export function triggerAsyncId(): number;
}
declare module "node:async_hooks" {
  export * from "async_hooks";
}
/* node:events — the EventEmitter class (the module object IS the class,
 * like Node's `module.exports = EventEmitter`). Listener/emit signatures
 * mirror @types/node's untyped `...args: any[]` surface; the compiler's
 * lowering unifies each event name's argument tuple program-wide and
 * checks annotated listener parameters against it (unannotated non-empty
 * parameter lists have no static types and fence at the registration). */
declare module "events" {
  class EventEmitter {
    constructor();
    static defaultMaxListeners: number;
    on(eventName: string, listener: (...args: any[]) => void): this;
    addListener(eventName: string, listener: (...args: any[]) => void): this;
    once(eventName: string, listener: (...args: any[]) => void): this;
    prependListener(eventName: string, listener: (...args: any[]) => void): this;
    prependOnceListener(eventName: string, listener: (...args: any[]) => void): this;
    off(eventName: string, listener: (...args: any[]) => void): this;
    removeListener(eventName: string, listener: (...args: any[]) => void): this;
    removeAllListeners(eventName?: string): this;
    emit(eventName: string, ...args: any[]): boolean;
    listenerCount(eventName: string, listener?: (...args: any[]) => void): number;
    /* Declared as zero-parameter closures so the RESULT is statically
     * consumable (.length, indexing, identity): the lowering only admits
     * these calls for events whose argument tuple is empty — a listener
     * pulled from the array is then safely callable too. Events with
     * arguments fence (their element type would lie). */
    listeners(eventName: string): Array<() => void>;
    rawListeners(eventName: string): Array<() => void>;
    eventNames(): string[];
    setMaxListeners(n: number): this;
    getMaxListeners(): number;
  }
  import internal = require("node:events");
  namespace EventEmitter {
    // The class under its own name, so `import { EventEmitter }` resolves
    // (the @types/node namespace-alias pattern).
    export { internal as EventEmitter };
    export function once(emitter: EventEmitter, eventName: string): Promise<any[]>;
  }
  export = EventEmitter;
}
declare module "node:events" {
  import events = require("events");
  export = events;
}

/* node:stream — the static stream classes (runtime-provided, the
 * EventEmitter-hierarchy precedent). Phase 1 is the OPTIONS-OBJECT
 * constructor surface: `new Readable({ read() {} })`, `new Writable({
 * write(chunk, enc, cb) {} })`, Duplex/Transform/PassThrough, push/read,
 * flowing vs paused, write/end backpressure + 'drain', pipe/unpipe, and
 * destroy — with Node's event orderings. Chunks are BYTES (Buffer), with
 * utf8 strings converted at push/write like Node; objectMode and
 * setEncoding are declared so uses fence at their sites with their own
 * words. `class My extends Readable` (the _read override form) is a
 * separate feature and fences at the class declaration. The runtime-fired
 * events carry per-class FORCED argument tuples ('data' is one Buffer,
 * 'error' one Error, 'pipe'/'unpipe' one Readable, the rest empty) — the
 * overloads below hand tsc the same contract so unannotated listener
 * parameters contextually type in .js sources. */
declare module "stream" {
  import { EventEmitter } from "events";

  interface ReadableOptions {
    highWaterMark?: number;
    encoding?: string;
    objectMode?: boolean;
    read?(this: Readable, size: number): void;
    destroy?(this: Readable, error: Error | null, callback: (error?: Error | null) => void): void;
    construct?(this: Readable, callback: (error?: Error | null) => void): void;
    autoDestroy?: boolean;
    emitClose?: boolean;
    captureRejections?: boolean;
    defaultEncoding?: string;
    signal?: unknown;
  }
  interface WritableOptions {
    highWaterMark?: number;
    decodeStrings?: boolean;
    defaultEncoding?: string;
    objectMode?: boolean;
    write?(this: Writable, chunk: Buffer, encoding: string, callback: (error?: Error | null) => void): void;
    writev?(this: Writable, chunks: unknown[], callback: (error?: Error | null) => void): void;
    final?(this: Writable, callback: (error?: Error | null) => void): void;
    destroy?(this: Writable, error: Error | null, callback: (error?: Error | null) => void): void;
    construct?(this: Writable, callback: (error?: Error | null) => void): void;
    autoDestroy?: boolean;
    emitClose?: boolean;
    captureRejections?: boolean;
    signal?: unknown;
  }
  interface DuplexOptions {
    highWaterMark?: number;
    readableHighWaterMark?: number;
    writableHighWaterMark?: number;
    encoding?: string;
    decodeStrings?: boolean;
    objectMode?: boolean;
    readableObjectMode?: boolean;
    writableObjectMode?: boolean;
    allowHalfOpen?: boolean;
    read?(this: Duplex, size: number): void;
    write?(this: Duplex, chunk: Buffer, encoding: string, callback: (error?: Error | null) => void): void;
    final?(this: Duplex, callback: (error?: Error | null) => void): void;
    destroy?(this: Duplex, error: Error | null, callback: (error?: Error | null) => void): void;
    construct?(this: Duplex, callback: (error?: Error | null) => void): void;
    autoDestroy?: boolean;
    emitClose?: boolean;
    captureRejections?: boolean;
    readable?: boolean;
    writable?: boolean;
    defaultEncoding?: string;
    writev?(this: Duplex, chunks: unknown[], callback: (error?: Error | null) => void): void;
    signal?: unknown;
  }
  interface TransformOptions {
    highWaterMark?: number;
    readableHighWaterMark?: number;
    writableHighWaterMark?: number;
    encoding?: string;
    decodeStrings?: boolean;
    objectMode?: boolean;
    readableObjectMode?: boolean;
    writableObjectMode?: boolean;
    allowHalfOpen?: boolean;
    transform?(this: Transform, chunk: Buffer, encoding: string, callback: (error?: Error | null, data?: Buffer | string) => void): void;
    flush?(this: Transform, callback: (error?: Error | null, data?: Buffer | string) => void): void;
    destroy?(this: Transform, error: Error | null, callback: (error?: Error | null) => void): void;
    construct?(this: Transform, callback: (error?: Error | null) => void): void;
    read?(this: Transform, size: number): void;
    write?(this: Transform, chunk: Buffer, encoding: string, callback: (error?: Error | null) => void): void;
    final?(this: Transform, callback: (error?: Error | null) => void): void;
    writev?(this: Transform, chunks: unknown[], callback: (error?: Error | null) => void): void;
    autoDestroy?: boolean;
    emitClose?: boolean;
    captureRejections?: boolean;
    readable?: boolean;
    writable?: boolean;
    defaultEncoding?: string;
    signal?: unknown;
  }

  class Readable extends EventEmitter {
    constructor(opts?: ReadableOptions);
    /* The underscore-method surface (@types/node declares these on the
     * classes; assigning them post-construction shadows the prototype
     * method and the machinery calls through the assignment — lowered
     * onto the option-callback slots). */
    _read(size: number): void;
    _destroy(error: Error | null, callback: (error?: Error | null) => void): void;
    [Symbol.asyncIterator](): AsyncIterableIterator<any>;
    push(chunk: Buffer | string | null, encoding?: string): boolean;
    unshift(chunk: Buffer | string, encoding?: string): void;
    read(size?: number): Buffer | null;
    pause(): this;
    resume(): this;
    isPaused(): boolean;
    setEncoding(encoding: string): this;
    pipe<T extends Writable>(destination: T, options?: { end?: boolean }): T;
    unpipe(destination?: Writable): this;
    destroy(error?: Error): this;
    readonly readable: boolean;
    readonly readableEnded: boolean;
    readonly readableFlowing: boolean | null;
    readonly readableLength: number;
    readonly readableHighWaterMark: number;
    readonly readableObjectMode: boolean;
    readonly closed: boolean;
    readonly destroyed: boolean;
    readonly errored: Error | null;
    static from(iterable: unknown, options?: ReadableOptions): Readable;
    on(event: "data", listener: (chunk: any) => void): this;
    on(event: "end" | "close" | "readable" | "pause" | "resume", listener: () => void): this;
    on(event: "error", listener: (err: Error) => void): this;
    on(event: string, listener: (...args: any[]) => void): this;
    once(event: "data", listener: (chunk: any) => void): this;
    once(event: "end" | "close" | "readable" | "pause" | "resume", listener: () => void): this;
    once(event: "error", listener: (err: Error) => void): this;
    once(event: string, listener: (...args: any[]) => void): this;
    addListener(event: "data", listener: (chunk: any) => void): this;
    addListener(event: "end" | "close" | "readable" | "pause" | "resume", listener: () => void): this;
    addListener(event: "error", listener: (err: Error) => void): this;
    addListener(event: string, listener: (...args: any[]) => void): this;
    prependListener(event: "data", listener: (chunk: any) => void): this;
    prependListener(event: "end" | "close" | "readable" | "pause" | "resume", listener: () => void): this;
    prependListener(event: "error", listener: (err: Error) => void): this;
    prependListener(event: string, listener: (...args: any[]) => void): this;
    prependOnceListener(event: "data", listener: (chunk: any) => void): this;
    prependOnceListener(event: "end" | "close" | "readable" | "pause" | "resume", listener: () => void): this;
    prependOnceListener(event: "error", listener: (err: Error) => void): this;
    prependOnceListener(event: string, listener: (...args: any[]) => void): this;
    off(event: "data", listener: (chunk: any) => void): this;
    off(event: "end" | "close" | "readable" | "pause" | "resume", listener: () => void): this;
    off(event: "error", listener: (err: Error) => void): this;
    off(event: string, listener: (...args: any[]) => void): this;
    removeListener(event: "data", listener: (chunk: any) => void): this;
    removeListener(event: "end" | "close" | "readable" | "pause" | "resume", listener: () => void): this;
    removeListener(event: "error", listener: (err: Error) => void): this;
    removeListener(event: string, listener: (...args: any[]) => void): this;
  }

  class Writable extends EventEmitter {
    constructor(opts?: WritableOptions);
    /* The underscore-method surface (see Readable). */
    _write(chunk: any, encoding: string, callback: (error?: Error | null) => void): void;
    _writev(chunks: Array<{ chunk: any; encoding: string }>, callback: (error?: Error | null) => void): void;
    _final(callback: (error?: Error | null) => void): void;
    _destroy(error: Error | null, callback: (error?: Error | null) => void): void;
    write(chunk: Buffer | string, callback?: (error?: Error | null) => void): boolean;
    write(chunk: Buffer | string, encoding: string, callback?: (error?: Error | null) => void): boolean;
    end(callback?: () => void): this;
    end(chunk: Buffer | string, callback?: () => void): this;
    end(chunk: Buffer | string, encoding: string, callback?: () => void): this;
    cork(): void;
    uncork(): void;
    setDefaultEncoding(encoding: string): this;
    destroy(error?: Error): this;
    readonly writable: boolean;
    readonly writableEnded: boolean;
    readonly writableFinished: boolean;
    readonly writableLength: number;
    readonly writableHighWaterMark: number;
    readonly writableObjectMode: boolean;
    readonly writableNeedDrain: boolean;
    readonly writableCorked: number;
    readonly closed: boolean;
    readonly destroyed: boolean;
    readonly errored: Error | null;
    on(event: "drain" | "finish" | "close", listener: () => void): this;
    on(event: "error", listener: (err: Error) => void): this;
    on(event: "pipe" | "unpipe", listener: (src: Readable) => void): this;
    on(event: string, listener: (...args: any[]) => void): this;
    once(event: "drain" | "finish" | "close", listener: () => void): this;
    once(event: "error", listener: (err: Error) => void): this;
    once(event: "pipe" | "unpipe", listener: (src: Readable) => void): this;
    once(event: string, listener: (...args: any[]) => void): this;
    addListener(event: "drain" | "finish" | "close", listener: () => void): this;
    addListener(event: "error", listener: (err: Error) => void): this;
    addListener(event: "pipe" | "unpipe", listener: (src: Readable) => void): this;
    addListener(event: string, listener: (...args: any[]) => void): this;
    prependListener(event: "drain" | "finish" | "close", listener: () => void): this;
    prependListener(event: "error", listener: (err: Error) => void): this;
    prependListener(event: "pipe" | "unpipe", listener: (src: Readable) => void): this;
    prependListener(event: string, listener: (...args: any[]) => void): this;
    prependOnceListener(event: "drain" | "finish" | "close", listener: () => void): this;
    prependOnceListener(event: "error", listener: (err: Error) => void): this;
    prependOnceListener(event: "pipe" | "unpipe", listener: (src: Readable) => void): this;
    prependOnceListener(event: string, listener: (...args: any[]) => void): this;
    off(event: "drain" | "finish" | "close", listener: () => void): this;
    off(event: "error", listener: (err: Error) => void): this;
    off(event: "pipe" | "unpipe", listener: (src: Readable) => void): this;
    off(event: string, listener: (...args: any[]) => void): this;
    removeListener(event: "drain" | "finish" | "close", listener: () => void): this;
    removeListener(event: "error", listener: (err: Error) => void): this;
    removeListener(event: "pipe" | "unpipe", listener: (src: Readable) => void): this;
    removeListener(event: string, listener: (...args: any[]) => void): this;
  }

  /* Duplex is Readable + Writable in one object. TS single inheritance
   * mirrors @types/node: extends Readable, the writable half declared
   * again. The lowering treats both halves as first-class. */
  class Duplex extends Readable {
    constructor(opts?: DuplexOptions);
    /* The underscore-method surface (see Readable). */
    _write(chunk: any, encoding: string, callback: (error?: Error | null) => void): void;
    _writev(chunks: Array<{ chunk: any; encoding: string }>, callback: (error?: Error | null) => void): void;
    _final(callback: (error?: Error | null) => void): void;
    write(chunk: Buffer | string, callback?: (error?: Error | null) => void): boolean;
    write(chunk: Buffer | string, encoding: string, callback?: (error?: Error | null) => void): boolean;
    end(callback?: () => void): this;
    end(chunk: Buffer | string, callback?: () => void): this;
    end(chunk: Buffer | string, encoding: string, callback?: () => void): this;
    cork(): void;
    uncork(): void;
    setDefaultEncoding(encoding: string): this;
    readonly writable: boolean;
    readonly writableEnded: boolean;
    readonly writableFinished: boolean;
    readonly writableLength: number;
    readonly writableHighWaterMark: number;
    readonly writableObjectMode: boolean;
    readonly writableNeedDrain: boolean;
    readonly writableCorked: number;
    readonly allowHalfOpen: boolean;
    on(event: "data", listener: (chunk: any) => void): this;
    on(event: "end" | "close" | "readable" | "pause" | "resume" | "drain" | "finish", listener: () => void): this;
    on(event: "error", listener: (err: Error) => void): this;
    on(event: "pipe" | "unpipe", listener: (src: Readable) => void): this;
    on(event: string, listener: (...args: any[]) => void): this;
    once(event: "data", listener: (chunk: any) => void): this;
    once(event: "end" | "close" | "readable" | "pause" | "resume" | "drain" | "finish", listener: () => void): this;
    once(event: "error", listener: (err: Error) => void): this;
    once(event: "pipe" | "unpipe", listener: (src: Readable) => void): this;
    once(event: string, listener: (...args: any[]) => void): this;
    addListener(event: "data", listener: (chunk: any) => void): this;
    addListener(event: "end" | "close" | "readable" | "pause" | "resume" | "drain" | "finish", listener: () => void): this;
    addListener(event: "error", listener: (err: Error) => void): this;
    addListener(event: "pipe" | "unpipe", listener: (src: Readable) => void): this;
    addListener(event: string, listener: (...args: any[]) => void): this;
    prependListener(event: "data", listener: (chunk: any) => void): this;
    prependListener(event: "end" | "close" | "readable" | "pause" | "resume" | "drain" | "finish", listener: () => void): this;
    prependListener(event: "error", listener: (err: Error) => void): this;
    prependListener(event: "pipe" | "unpipe", listener: (src: Readable) => void): this;
    prependListener(event: string, listener: (...args: any[]) => void): this;
    prependOnceListener(event: "data", listener: (chunk: any) => void): this;
    prependOnceListener(event: "end" | "close" | "readable" | "pause" | "resume" | "drain" | "finish", listener: () => void): this;
    prependOnceListener(event: "error", listener: (err: Error) => void): this;
    prependOnceListener(event: "pipe" | "unpipe", listener: (src: Readable) => void): this;
    prependOnceListener(event: string, listener: (...args: any[]) => void): this;
    off(event: "data", listener: (chunk: any) => void): this;
    off(event: "end" | "close" | "readable" | "pause" | "resume" | "drain" | "finish", listener: () => void): this;
    off(event: "error", listener: (err: Error) => void): this;
    off(event: "pipe" | "unpipe", listener: (src: Readable) => void): this;
    off(event: string, listener: (...args: any[]) => void): this;
    removeListener(event: "data", listener: (chunk: any) => void): this;
    removeListener(event: "end" | "close" | "readable" | "pause" | "resume" | "drain" | "finish", listener: () => void): this;
    removeListener(event: "error", listener: (err: Error) => void): this;
    removeListener(event: "pipe" | "unpipe", listener: (src: Readable) => void): this;
    removeListener(event: string, listener: (...args: any[]) => void): this;
  }

  class Transform extends Duplex {
    constructor(opts?: TransformOptions);
    /* The underscore-method surface (see Readable). */
    _transform(chunk: any, encoding: string, callback: (error?: Error | null, data?: Buffer | string) => void): void;
    _flush(callback: (error?: Error | null, data?: Buffer | string) => void): void;
  }
  class PassThrough extends Transform {
    constructor(opts?: TransformOptions);
  }

  /* Declared so requires typecheck; each fences at its use site. */
  function pipeline(...streams: unknown[]): unknown;
  function finished(stream: unknown, callback: (err?: Error | null) => void): () => void;
  /* Folds to the TARGET platform's default at compile time (win32 16384,
   * else 65536 — Node's own state.js split); literal argument only. */
  function getDefaultHighWaterMark(objectMode: boolean): number;
  namespace promises {
    function pipeline(...streams: unknown[]): Promise<void>;
    function finished(stream: unknown): Promise<void>;
  }
  class Stream extends EventEmitter {}

  export { Readable, Writable, Duplex, Transform, PassThrough, Stream, pipeline, finished, getDefaultHighWaterMark, promises };
  export type { ReadableOptions, WritableOptions, DuplexOptions, TransformOptions };
}
declare module "node:stream" {
  import stream = require("stream");
  export = stream;
}
declare module "stream/promises" {
  /* The promise forms of finished/pipeline: a void promise the stream's
   * terminal point settles (rejected with the error, or
   * ERR_STREAM_PREMATURE_CLOSE on an early close). Stream arguments are
   * the lowered surface — iterables/generators/functions fence per site. */
  function pipeline(...streams: unknown[]): Promise<void>;
  function finished(stream: unknown): Promise<void>;
  export { pipeline, finished };
}
declare module "node:stream/promises" {
  import streamPromises = require("stream/promises");
  export = streamPromises;
}
declare module "stream/consumers" {
  /* The promise consumers over a readable: accumulate every chunk and
   * settle — text (the utf8 decode), json (the text through JSON.parse:
   * `unknown`, validated with a checked cast; malformed input rejects
   * with the parse's SyntaxError), buffer (the concatenated bytes;
   * string chunks contribute their utf8 bytes, Node's Blob rule).
   * Stream errors reject; an early close rejects with
   * ERR_STREAM_PREMATURE_CLOSE. arrayBuffer and blob fence per site:
   * neither value has a representation in a compiled binary. */
  function text(stream: unknown): Promise<string>;
  function json(stream: unknown): Promise<unknown>;
  function buffer(stream: unknown): Promise<Buffer>;
  function arrayBuffer(stream: unknown): Promise<ArrayBuffer>;
  function blob(stream: unknown): Promise<unknown>;
  export { arrayBuffer, blob, buffer, json, text };
}
declare module "node:stream/consumers" {
  import streamConsumers = require("stream/consumers");
  export = streamConsumers;
}
