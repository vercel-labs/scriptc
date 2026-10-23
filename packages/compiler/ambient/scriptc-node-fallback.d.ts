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
 * overrides, comptime, setTimeout — which MERGES with
 * @types/node's as an overload instead of colliding). */

/* NodeJS.ErrnoException — the Error shape @types/node attaches to fs and
 * child failures. The TYPE maps to the runtime Error root; only `code`
 * has a lowering (throw sites stamp the errno name — "ENOENT" and
 * friends; reads answer `string | undefined`), errno/syscall/path
 * typecheck and fence per member. */
declare namespace NodeJS {
  interface ProcessVersions {
    readonly node: string;
    readonly openssl?: string;
    readonly [name: string]: string | undefined;
  }
  /* The process introspection records — named interfaces so the type
   * mapper interns their record shapes (the RemoteInfo pattern; the
   * names match @types/node's, so the mappings hold when it adopts). */
  interface CpuUsage {
    user: number;
    system: number;
  }
  interface MemoryUsage {
    rss: number;
    heapTotal: number;
    heapUsed: number;
    external: number;
    arrayBuffers: number;
  }
  /* process.memoryUsage(): rss from the OS, heapTotal/heapUsed from the
   * runtime heap's own accounting; external and arrayBuffers are 0. */
  interface MemoryUsageFn {
    (): MemoryUsage;
    rss(): number;
  }
  interface ProcessRelease {
    name: string;
    sourceUrl?: string | undefined;
    headersUrl?: string | undefined;
    libUrl?: string | undefined;
    lts?: string | undefined;
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
  /* The readable-stream interface every Node stream implements. The
   * piped child-output stream (child.stdout / child.stderr under stdio
   * ["ignore", "pipe", "pipe"]) is declared with it: 'data' fires one
   * Buffer chunk per read (≤64KB, consumer-driven — no listener, no
   * read), 'end' fires once at EOF and always BEFORE the child's 'exit'. A
   * flowing stream keeps the loop alive. A program that also passes
   * other streams (fs, zlib, node:stream) where this interface is
   * expected compiles it as the node:stream Readable, with child output
   * bridged into one. */
  interface ReadableStream {
    on(event: "data", listener: (chunk: Buffer) => void): void;
    on(event: "data", listener: (chunk: string) => void): void;
    on(event: "end", listener: () => void): void;
    on(event: string, listener: (...args: any[]) => void): void;
    once(event: "data", listener: (chunk: Buffer) => void): void;
    once(event: "data", listener: (chunk: string) => void): void;
    once(event: "end", listener: () => void): void;
    once(event: string, listener: (...args: any[]) => void): void;
    /* setEncoding('utf8') makes subsequent data chunks strings, including
     * multibyte sequences split across native pipe reads. */
    setEncoding(encoding: string): this;
    readonly readable: boolean;
    pause(): this;
    resume(): this;
    isPaused(): boolean;
    pipe<T extends WritableStream>(destination: T, options?: { end?: boolean }): T;
    unpipe(destination?: WritableStream): this;
    [Symbol.asyncIterator](): AsyncIterableIterator<string | Buffer>;
  }
  /* The writable-stream interface every Node stream implements:
   * process.stdout/process.stderr, fs.WriteStream and the node:stream
   * Writable family. Written only to the process streams, it compiles as
   * their descriptor; with other streams flowing into it, as the
   * node:stream Writable (the process streams convert into one). */
  interface WritableStream {
    readonly writable: boolean;
    write(data: string | Uint8Array, callback?: (error?: Error | null) => void): boolean;
    write(
      data: string | Uint8Array,
      encoding: BufferEncoding,
      callback?: (error?: Error | null) => void,
    ): boolean;
    end(callback?: () => void): void;
    end(data: string | Uint8Array, callback?: () => void): void;
    end(data: string | Uint8Array, encoding: BufferEncoding, callback?: () => void): void;
    /* Node's EventEmitter signature: listeners take untyped arguments. */
    on(event: string, listener: (...args: any[]) => void): void;
    once(event: string, listener: (...args: any[]) => void): void;
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
 * assert, count/countReset, dir/dirxml, group/groupCollapsed/groupEnd,
 * table, time/timeEnd/timeLog, clear, and the inspector-only
 * profile/profileEnd/timeStamp lower on the global console.
 *
 * trace is declared too — not because it lowers, but so a program that
 * typechecks under its own tsc reaches the per-site SC2020 fence naming
 * the member and the supported surface, instead of dying on a
 * fallback-manufactured type error its own tsc cannot reproduce. */
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
  profile(label?: string): void;
  profileEnd(label?: string): void;
  trace(...data: unknown[]): void;
  Console: typeof import("node:console").Console;
};

// node:console exports the global instance's bound methods and the Console
// constructor: instances over process.stdout/process.stderr or node:stream
// writables lower their log/info/debug/error/warn members; their remaining
// methods are declared so unsupported uses reach named fences.
type ScriptcConsoleMethods = typeof console;
declare module "node:console" {
  export class Console {
    constructor(stdout: unknown, stderr?: unknown, ignoreErrors?: boolean);
  }
  export interface Console extends ScriptcConsoleMethods {}
  export const log: ScriptcConsoleMethods["log"];
  export const info: ScriptcConsoleMethods["info"];
  export const debug: ScriptcConsoleMethods["debug"];
  export const error: ScriptcConsoleMethods["error"];
  export const warn: ScriptcConsoleMethods["warn"];
  export const assert: ScriptcConsoleMethods["assert"];
  export const clear: ScriptcConsoleMethods["clear"];
  export const count: ScriptcConsoleMethods["count"];
  export const countReset: ScriptcConsoleMethods["countReset"];
  export const dir: ScriptcConsoleMethods["dir"];
  export const dirxml: ScriptcConsoleMethods["dirxml"];
  export const group: ScriptcConsoleMethods["group"];
  export const groupCollapsed: ScriptcConsoleMethods["groupCollapsed"];
  export const groupEnd: ScriptcConsoleMethods["groupEnd"];
  export const table: ScriptcConsoleMethods["table"];
  export const time: ScriptcConsoleMethods["time"];
  export const timeEnd: ScriptcConsoleMethods["timeEnd"];
  export const timeLog: ScriptcConsoleMethods["timeLog"];
  export const timeStamp: ScriptcConsoleMethods["timeStamp"];
  export const profile: ScriptcConsoleMethods["profile"];
  export const profileEnd: ScriptcConsoleMethods["profileEnd"];
  export const trace: ScriptcConsoleMethods["trace"];
  const defaultConsole: ScriptcConsoleMethods & { Console: typeof Console };
  export default defaultConsole;
}
declare module "console" {
  export * from "node:console";
  export { default } from "node:console";
}

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
  getBuiltinModule(id: string): unknown;
  hrtime: {
    (time?: [number, number]): [number, number];
    bigint(): bigint;
  };
  argv: string[];
  platform: string;
  /* The binary's OWN architecture ("arm64", "x64") — Node's answer for
   * its own build on the same machine. */
  readonly arch: string;
  /* Stable native dictionary. node and openssl name compatibility targets;
   * components absent from the runtime have no entries. */
  readonly versions: NodeJS.ProcessVersions;
  /* "v" plus versions.node: the compatibility target's release. */
  readonly version: string;
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
  loadEnvFile(path?: string | URL | Uint8Array): void;
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
  geteuid?(): number;
  getegid?(): number;
  getgroups?(): number[];
  readonly ppid: number;
  /* libuv's process title: argv[0] until set; a write is truncated to
   * the original argument area on POSIX and sets the console title on
   * Windows. */
  title: string;
  argv0: string;
  readonly release: NodeJS.ProcessRelease;
  /* signal admits null (Node treats it as the SIGTERM default) — real
   * callers forward a `string | null` result field. */
  kill(pid: number, signal?: string | number | null): true;
  env: { [name: string]: string | undefined };
  /** Numeric writes set the status returned by ordinary program exit. */
  exitCode?: number;
  /* Silence and throw DeprecationWarnings (util.deprecate,
   * process.emitWarning); undefined until assigned. */
  noDeprecation?: boolean;
  throwDeprecation?: boolean;
  /* `never`, like @types/node: code behind an early-exit guard narrows
   * (`if (!x) process.exit(1)` proves x afterwards) — typed `void` the
   * guard narrows nothing and correct programs fail preflight. The
   * lowering already handles the optional code (bare exit() uses exitCode,
   * or zero when it was never set). */
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
  memoryUsage: NodeJS.MemoryUsageFn;
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
  stdout: import("tty").WriteStream;
  stderr: import("tty").WriteStream;
  /* The stdin stream, the piped-input slice: the TTY probe, the
   * data/end/error events and readline's 'keypress' (on and once — a 'data' listener keeps the
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
    /* readline.emitKeypressEvents(process.stdin)'s keys */
    on(
      event: "keypress",
      listener: (str: string | undefined, key: import("readline").Key) => void,
    ): void;
    once(event: "data", listener: (chunk: Uint8Array) => void): void;
    once(event: "end", listener: () => void): void;
    once(event: "error", listener: (err: Error) => void): void;
    once(
      event: "keypress",
      listener: (str: string | undefined, key: import("readline").Key) => void,
    ): void;
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
  removeListener(
    event: "unhandledRejection",
    listener: (reason: unknown, promise: unknown) => void,
  ): void;
  removeListener(event: "rejectionHandled", listener: (promise: unknown) => void): void;
  /* emitWarning — Node's full grammar (string or Error warning; type/
   * ctor/options second; code/ctor third). */
  emitWarning(warning: string | Error, ...args: any[]): void;
  /** Present in a child created by child_process.fork(). */
  readonly connected: boolean;
  send?(message: object, callback?: (error: Error | null) => void): boolean;
  disconnect(): void;
  on(event: "message", listener: (message: any) => void): void;
  on(event: "disconnect", listener: () => void): void;
  once(event: "message", listener: (message: any) => void): void;
  once(event: "disconnect", listener: () => void): void;
};

/* Node's process module default export is the global process object. These
 * declaration aliases let the ESM spelling typecheck against the same
 * deliberately narrow fallback surface when @types/node is absent. */
declare module "process" {
  export = process;
}
declare module "node:process" {
  import process = require("process");
  export = process;
}

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

interface ScriptcModule {
  children: ScriptcModule[];
  exports: any;
  filename: string;
  id: string;
  isPreloading: boolean;
  loaded: boolean;
  parent: ScriptcModule | null | undefined;
  path: string;
  paths: string[];
  require(id: string): any;
}
declare var module: ScriptcModule;

/* `global` IS globalThis (Node's alias), and `declare var process` above
 * puts process on `typeof globalThis` — so `globalThis.process` and
 * `global.process` read the same object as the bare name. */
declare var global: typeof globalThis;

/* The `require` VALUE's non-call surface. require() CALLS are module
 * edges (the checker models them as imports); the object's own members
 * are declared here so harness idioms typecheck. The main/cache values and
 * the CommonJS module graph lower to native process-lifetime handles. */
interface ScriptcRequireResolveOptions {
  paths?: string[];
}
interface ScriptcRequireResolve {
  (id: string, options?: ScriptcRequireResolveOptions): string;
  paths(id: string): string[] | null;
}
interface ScriptcRequire {
  /* The call signature types NON-IMPORT-SHAPED require expressions (the
   * checker models import-shaped requires as module aliases regardless,
   * exactly like under @types/node's NodeRequire). `any`, like
   * @types/node: the value's home is the module system, not the static
   * value model — reached uses fence per site. */
  (id: string): any;
  main: ScriptcModule | undefined;
  resolve: ScriptcRequireResolve;
  cache: { [id: string]: ScriptcModule | undefined };
}
declare var require: ScriptcRequire;

/* setImmediate/clearImmediate — Node's macrotask pair (fires after I/O
 * events of the current loop turn, before timers due later). The handle
 * follows the Timeout pattern: loop-liveness bookkeeping. */
interface Immediate extends Disposable {
  ref(): Immediate;
  unref(): Immediate;
  hasRef(): boolean;
  [Symbol.dispose](): void;
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

/* WebCrypto (scr_webcrypto.c): crypto.subtle's importKey, generateKey and
 * exportKey for HMAC and AES keys (importKey also for PBKDF2 and HKDF
 * keys), AES-GCM/CBC/CTR encrypt and decrypt, wrapKey and unwrapKey of
 * secret keys (AES-KW or those ciphers), PBKDF2 and HKDF deriveBits and
 * deriveKey, HMAC sign/verify, generateKey, importKey, exportKey, sign
 * and verify for ECDSA, Ed25519, RSASSA-PKCS1-v1_5 and RSA-PSS, and the
 * SHA-1/SHA-2 digests, typed as exactly that surface (the declarations
 * mirror @types/node's webcrypto shapes), plus the global's randomUUID and
 * getRandomValues. Every other SubtleCrypto method and crypto member is
 * absent, so a use is an honest type error. CryptoKey values are native
 * handles whose four members read through the handle. */
declare var crypto: Crypto;
/* The Crypto and SubtleCrypto constructors (feature probes only) stay
 * `unknown`; the values keep this declaration order. */
declare var Crypto: unknown;
declare var CryptoKey: {
  prototype: CryptoKey;
  new (): CryptoKey;
};
declare var SubtleCrypto: unknown;
type KeyUsage =
  | "encrypt"
  | "decrypt"
  | "sign"
  | "verify"
  | "deriveKey"
  | "deriveBits"
  | "encapsulateBits"
  | "decapsulateBits"
  | "encapsulateKey"
  | "decapsulateKey"
  | "wrapKey"
  | "unwrapKey";
type KeyType = "private" | "public" | "secret";
interface Algorithm {
  name: string;
}
type AlgorithmIdentifier = Algorithm | string;
type HashAlgorithmIdentifier = AlgorithmIdentifier;
interface HmacImportParams extends Algorithm {
  hash: HashAlgorithmIdentifier;
  length?: number;
}
interface HmacKeyGenParams extends Algorithm {
  hash: HashAlgorithmIdentifier;
  length?: number;
}
interface AesKeyGenParams extends Algorithm {
  length: number;
}
interface AesGcmParams extends Algorithm {
  additionalData?: BufferSource;
  iv: BufferSource;
  tagLength?: number;
}
interface AesCbcParams extends Algorithm {
  iv: BufferSource;
}
interface AesCtrParams extends Algorithm {
  counter: BufferSource;
  length: number;
}
interface Pbkdf2Params extends Algorithm {
  hash: HashAlgorithmIdentifier;
  iterations: number;
  salt: BufferSource;
}
interface HkdfParams extends Algorithm {
  hash: HashAlgorithmIdentifier;
  info: BufferSource;
  salt: BufferSource;
}
interface AesDerivedKeyParams extends Algorithm {
  length: number;
}
interface KeyAlgorithm {
  name: string;
}
interface AesKeyAlgorithm extends KeyAlgorithm {
  length: number;
}
interface HmacKeyAlgorithm extends KeyAlgorithm {
  hash: KeyAlgorithm;
  length: number;
}
interface CryptoKey {
  readonly algorithm: KeyAlgorithm;
  readonly extractable: boolean;
  readonly type: KeyType;
  readonly usages: KeyUsage[];
}
type KeyFormat =
  | "jwk"
  | "pkcs8"
  | "raw"
  | "raw-private"
  | "raw-public"
  | "raw-secret"
  | "raw-seed"
  | "spki";
interface JsonWebKey {
  alg?: string;
  crv?: string;
  d?: string;
  dp?: string;
  dq?: string;
  e?: string;
  ext?: boolean;
  k?: string;
  key_ops?: string[];
  kty?: string;
  n?: string;
  p?: string;
  q?: string;
  qi?: string;
  use?: string;
  x?: string;
  y?: string;
}
interface EcKeyGenParams extends Algorithm {
  namedCurve: string;
}
interface EcKeyImportParams extends Algorithm {
  namedCurve: string;
}
interface EcdsaParams extends Algorithm {
  hash: HashAlgorithmIdentifier;
}
interface RsaHashedKeyGenParams extends Algorithm {
  modulusLength: number;
  publicExponent: Uint8Array;
  hash: HashAlgorithmIdentifier;
}
interface RsaHashedImportParams extends Algorithm {
  hash: HashAlgorithmIdentifier;
}
interface RsaPssParams extends Algorithm {
  saltLength: number;
}
interface EcKeyAlgorithm extends KeyAlgorithm {
  namedCurve: string;
}
interface RsaHashedKeyAlgorithm extends KeyAlgorithm {
  modulusLength: number;
  publicExponent: Uint8Array;
  hash: KeyAlgorithm;
}
interface CryptoKeyPair {
  privateKey: CryptoKey;
  publicKey: CryptoKey;
}
/* HMAC and AES keys generate, import and export as 'raw' and 'jwk'
 * (PBKDF2 and HKDF keys import as 'raw'); ECDSA and RSA keys generate,
 * import and export as 'spki', 'pkcs8' and 'jwk', and ECDSA public keys as
 * 'raw'. */
interface SubtleCrypto {
  decrypt(
    algorithm: AesGcmParams | AesCbcParams | AesCtrParams,
    key: CryptoKey,
    data: BufferSource,
  ): Promise<ArrayBuffer>;
  deriveBits(
    algorithm: Pbkdf2Params | HkdfParams,
    baseKey: CryptoKey,
    length?: number | null,
  ): Promise<ArrayBuffer>;
  deriveKey(
    algorithm: Pbkdf2Params | HkdfParams,
    baseKey: CryptoKey,
    derivedKeyType: AlgorithmIdentifier | AesDerivedKeyParams | HmacImportParams,
    extractable: boolean,
    keyUsages: readonly KeyUsage[],
  ): Promise<CryptoKey>;
  digest(algorithm: AlgorithmIdentifier, data: BufferSource): Promise<ArrayBuffer>;
  encrypt(
    algorithm: AesGcmParams | AesCbcParams | AesCtrParams,
    key: CryptoKey,
    data: BufferSource,
  ): Promise<ArrayBuffer>;
  exportKey(format: "jwk", key: CryptoKey): Promise<JsonWebKey>;
  exportKey(format: Exclude<KeyFormat, "jwk">, key: CryptoKey): Promise<ArrayBuffer>;
  generateKey(
    algorithm: EcKeyGenParams | RsaHashedKeyGenParams | "Ed25519" | { name: "Ed25519" },
    extractable: boolean,
    keyUsages: readonly KeyUsage[],
  ): Promise<CryptoKeyPair>;
  generateKey(
    algorithm: AesKeyGenParams | HmacKeyGenParams,
    extractable: boolean,
    keyUsages: readonly KeyUsage[],
  ): Promise<CryptoKey>;
  importKey(
    format: "jwk",
    keyData: JsonWebKey,
    algorithm: AlgorithmIdentifier | HmacImportParams | EcKeyImportParams | RsaHashedImportParams,
    extractable: boolean,
    keyUsages: readonly KeyUsage[],
  ): Promise<CryptoKey>;
  importKey(
    format: Exclude<KeyFormat, "jwk">,
    keyData: BufferSource,
    algorithm: AlgorithmIdentifier | HmacImportParams | EcKeyImportParams | RsaHashedImportParams,
    extractable: boolean,
    keyUsages: readonly KeyUsage[],
  ): Promise<CryptoKey>;
  sign(
    algorithm: AlgorithmIdentifier | EcdsaParams | RsaPssParams,
    key: CryptoKey,
    data: BufferSource,
  ): Promise<ArrayBuffer>;
  unwrapKey(
    format: KeyFormat,
    wrappedKey: BufferSource,
    unwrappingKey: CryptoKey,
    unwrapAlgorithm: AlgorithmIdentifier | AesGcmParams | AesCbcParams | AesCtrParams,
    unwrappedKeyAlgorithm: AlgorithmIdentifier | HmacImportParams,
    extractable: boolean,
    keyUsages: readonly KeyUsage[],
  ): Promise<CryptoKey>;
  verify(
    algorithm: AlgorithmIdentifier | EcdsaParams | RsaPssParams,
    key: CryptoKey,
    signature: BufferSource,
    data: BufferSource,
  ): Promise<boolean>;
  wrapKey(
    format: KeyFormat,
    key: CryptoKey,
    wrappingKey: CryptoKey,
    wrapAlgorithm: AlgorithmIdentifier | AesGcmParams | AesCbcParams | AesCtrParams,
  ): Promise<ArrayBuffer>;
}
interface Crypto {
  readonly subtle: SubtleCrypto;
  getRandomValues<
    T extends
      | Int8Array
      | Uint8Array
      | Uint8ClampedArray
      | Int16Array
      | Uint16Array
      | Int32Array
      | Uint32Array
      | BigInt64Array
      | BigUint64Array,
  >(
    typedArray: T,
  ): T;
  randomUUID(): `${string}-${string}-${string}-${string}-${string}`;
}

/* Capability-gated globals harness code probes behind feature guards
 * (the SQLite-backed storage pair): typed `unknown` — no lowering exists,
 * the guard is expected to be false in a compiled binary, and any reached
 * use fences per site. */
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
interface Buffer<
  TArrayBuffer extends ArrayBufferLike = ArrayBufferLike,
> extends Uint8Array<TArrayBuffer> {
  toString(encoding?: BufferEncoding, start?: number, end?: number): string;
  equals(otherBuffer: Uint8Array): boolean;
  compare(
    target: Uint8Array,
    targetStart?: number,
    targetEnd?: number,
    sourceStart?: number,
    sourceEnd?: number,
  ): number;
  indexOf(
    value: string | number | Uint8Array,
    byteOffset?: number | BufferEncoding,
    encoding?: BufferEncoding,
  ): number;
  lastIndexOf(
    value: string | number | Uint8Array,
    byteOffset?: number | BufferEncoding,
    encoding?: BufferEncoding,
  ): number;
  includes(
    value: string | number | Buffer,
    byteOffset?: number | BufferEncoding,
    encoding?: BufferEncoding,
  ): boolean;
  fill(
    value: string | number | Uint8Array,
    offset?: number | BufferEncoding,
    end?: number | BufferEncoding,
    encoding?: BufferEncoding,
  ): this;
  copy(target: Uint8Array, targetStart?: number, sourceStart?: number, sourceEnd?: number): number;
  swap16(): Buffer;
  swap32(): Buffer;
  swap64(): Buffer;
  write(
    string: string,
    offset?: number | BufferEncoding,
    length?: number | BufferEncoding,
    encoding?: BufferEncoding,
  ): number;
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
  writeBigInt64BE(value: bigint, offset?: number): number;
  writeBigInt64LE(value: bigint, offset?: number): number;
  writeBigUInt64BE(value: bigint, offset?: number): number;
  writeBigUInt64LE(value: bigint, offset?: number): number;
  writeBigUint64BE(value: bigint, offset?: number): number;
  writeBigUint64LE(value: bigint, offset?: number): number;
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
  readBigInt64BE(offset?: number): bigint;
  readBigInt64LE(offset?: number): bigint;
  readBigUInt64BE(offset?: number): bigint;
  readBigUInt64LE(offset?: number): bigint;
  readBigUint64BE(offset?: number): bigint;
  readBigUint64LE(offset?: number): bigint;
}
interface BufferConstructor {
  from(data: string, encoding?: BufferEncoding): Buffer;
  /* The ArrayBuffer form is the VIEW construction: x.buffer with an
   * optional byte offset/length shares x's storage (the subarray rule). */
  from(data: ArrayBuffer | SharedArrayBuffer, byteOffset?: number, length?: number): Buffer;
  from(data: Uint8Array | readonly number[]): Buffer;
  alloc(size: number, fill?: string | number | Uint8Array, encoding?: BufferEncoding): Buffer;
  compare(buf1: Uint8Array, buf2: Uint8Array): number;
  /* alloc without the zero-fill guarantee. Below Buffer.poolSize >>> 1
   * bytes it returns a view into the shared pool slab. */
  allocUnsafe(size: number): Buffer;
  allocUnsafeSlow(size: number): Buffer;
  /* The pool slab size for allocUnsafe, from, and concat. */
  poolSize: number;
  concat(list: readonly Uint8Array[], totalLength?: number): Buffer;
  isBuffer(obj: unknown): obj is Buffer;
  byteLength(input: string | Uint8Array, encoding?: BufferEncoding): number;
  isEncoding(encoding: string): boolean;
}
declare var Buffer: BufferConstructor;

/* The WHATWG codec constructors. Instance types live in scriptc.d.ts so
 * programs with @types/node have the same global type names. */
declare var TextEncoder: { new (): TextEncoder };
declare var TextDecoder: {
  new (label?: string, options?: { fatal?: boolean; ignoreBOM?: boolean }): TextDecoder;
};

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
  new (
    type: string,
    eventInitDict?: { bubbles?: boolean; cancelable?: boolean; composed?: boolean },
  ): Event;
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
  new <T = unknown>(
    type: string,
    eventInitDict?: { detail?: T; bubbles?: boolean; cancelable?: boolean; composed?: boolean },
  ): CustomEvent<T>;
  readonly prototype: CustomEvent;
};
interface MessageEvent<T = unknown> extends Event {
  readonly data: T;
  readonly origin: string;
  readonly lastEventId: string;
  readonly source: unknown;
  readonly ports: readonly MessagePort[];
}
declare var MessageEvent: {
  new <T = unknown>(
    type: string,
    eventInitDict?: { data?: T; origin?: string; lastEventId?: string },
  ): MessageEvent<T>;
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

interface QueuingStrategySize<T = unknown> {
  (chunk: T): number;
}
interface QueuingStrategy<T = unknown> {
  highWaterMark?: number;
  size?: QueuingStrategySize<T>;
}
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
  [Symbol.asyncIterator](options?: { preventCancel?: boolean }): AsyncIterableIterator<T>;
  values(options?: { preventCancel?: boolean }): AsyncIterableIterator<T>;
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
 * native handle like Response itself. */
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
  new (init?: Headers | Record<string, string> | readonly (readonly [string, string])[]): Headers;
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
   * arrayBuffer() remains unsupported because static programs have no
   * free-standing ArrayBuffer representation; the compiler diagnoses its
   * direct use and points at bytes(). */
  arrayBuffer(): Promise<ArrayBuffer>;
  bytes(): Promise<Uint8Array>;
}
interface ResponseInit {
  headers?: Headers | Record<string, string> | readonly (readonly [string, string])[];
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
/* Blob and File (node:buffer, also globals): immutable bytes with a
 * content type. Sources are copied when the Blob is built. */
interface BlobPropertyBag {
  endings?: "transparent" | "native";
  type?: string;
}
interface FilePropertyBag extends BlobPropertyBag {
  lastModified?: number;
}
interface Blob {
  readonly size: number;
  readonly type: string;
  slice(start?: number, end?: number, contentType?: string): Blob;
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
  bytes(): Promise<Uint8Array>;
  stream(): ReadableStream<Uint8Array>;
  textStream(): ReadableStream<string>;
}
declare var Blob: {
  new (
    sources?: readonly (string | ArrayBuffer | ArrayBufferView | Blob)[],
    options?: BlobPropertyBag,
  ): Blob;
  readonly prototype: Blob;
};
interface File extends Blob {
  readonly name: string;
  readonly lastModified: number;
}
declare var File: {
  new (
    sources: readonly (string | ArrayBuffer | ArrayBufferView | Blob)[],
    fileName: string,
    options?: FilePropertyBag,
  ): File;
  readonly prototype: File;
};
interface Request {
  readonly method: string;
  readonly url: string;
  readonly headers: Headers;
  readonly destination: string;
  readonly referrer: string;
  readonly referrerPolicy: string;
  readonly mode: string;
  readonly credentials: string;
  readonly cache: string;
  readonly redirect: "follow" | "error" | "manual";
  readonly integrity: string;
  readonly keepalive: boolean;
  readonly isReloadNavigation: boolean;
  readonly isHistoryNavigation: boolean;
  readonly duplex: "half";
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
  headers?: Headers | Record<string, string> | readonly (readonly [string, string])[];
  body?: string | Uint8Array | ReadableStream<Uint8Array> | null;
  duplex?: "half";
  redirect?: "follow" | "error" | "manual";
  signal?: AbortSignal;
}
declare var Request: {
  new (input: RequestInfo, init?: RequestInit): Request;
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
declare function setInterval(
  callback: (...args: never[]) => void,
  ms?: number,
  ...args: unknown[]
): Timeout;
declare function clearInterval(handle?: Timeout | number | null | undefined): void;

/* node:timers — the module twins of the timer globals (Node's timers
 * module re-exports them: require('timers').setTimeout IS setTimeout).
 * Named imports, destructured requires, and namespace calls all lower to
 * the same libCalls as the globals; the surface beyond these six
 * (enroll/unenroll, promises) fences per member. */
declare module "node:timers" {
  export function setTimeout(callback: () => void, ms?: number): Timeout;
  export function setTimeout(
    callback: (...args: never[]) => void,
    ms?: number,
    ...args: unknown[]
  ): Timeout;
  export function clearTimeout(handle?: Timeout | number | null | undefined): void;
  export function setInterval(callback: () => void, ms?: number): Timeout;
  export function setInterval(
    callback: (...args: never[]) => void,
    ms?: number,
    ...args: unknown[]
  ): Timeout;
  export function clearInterval(handle?: Timeout | number | null | undefined): void;
  export function setImmediate(callback: () => void): Immediate;
  export function setImmediate(callback: (...args: never[]) => void, ...args: unknown[]): Immediate;
  export function clearImmediate(handle?: Immediate | null | undefined): void;
}
declare module "timers" {
  export * from "node:timers";
}

/* node:timers/promises — the promisified pair the Node test harness leans
 * on (`await setTimeout(ms)` as a sleep). setTimeout and setImmediate
 * settle with their resolve value (undefined without one) from the shared
 * timer heap and the immediate queue; setInterval(delay, value) lowers to a
 * typed async iterator. The options object takes `ref`; AbortSignal
 * options remain declared surface that fences per site. */
declare module "node:timers/promises" {
  export interface TimerOptions {
    ref?: boolean;
    signal?: AbortSignal;
  }
  export function setTimeout<T = void>(
    delay?: number,
    value?: T,
    options?: TimerOptions,
  ): Promise<T>;
  export function setImmediate<T = void>(value?: T, options?: TimerOptions): Promise<T>;
  export function setInterval<T = unknown>(
    delay?: number,
    value?: T,
    options?: unknown,
  ): AsyncGenerator<T, void, undefined>;
  export const scheduler: {
    wait(delay?: number, options?: TimerOptions): Promise<void>;
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
    bindStore(
      store: import("async_hooks").AsyncLocalStorage<any>,
      transform?: (context: any) => any,
    ): void;
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
 * getTimestamp). mark, measure, the getEntries family and the clears run
 * over the thread's performance timeline with Node's validation; everything
 * else fences per member. */
declare module "node:perf_hooks" {
  export type EntryType = "mark" | "measure";
  export class PerformanceEntry {
    protected constructor();
    readonly duration: number;
    readonly name: string;
    readonly startTime: number;
    readonly entryType: EntryType;
    toJSON(): any;
  }
  export class PerformanceMark extends PerformanceEntry {
    readonly detail: any;
    readonly duration: 0;
    readonly entryType: "mark";
  }
  export class PerformanceMeasure extends PerformanceEntry {
    readonly detail: any;
    readonly entryType: "measure";
  }
  export interface MarkOptions {
    detail?: unknown | undefined;
    startTime?: number | undefined;
  }
  export interface MeasureOptions {
    detail?: unknown;
    duration?: number | undefined;
    end?: number | string | undefined;
    start?: number | string | undefined;
  }
  export interface Performance {
    now(): number;
    mark(name: string, options?: MarkOptions): PerformanceMark;
    measure(name: string, startMark?: string, endMark?: string): PerformanceMeasure;
    measure(name: string, options: MeasureOptions): PerformanceMeasure;
    getEntries(): PerformanceEntry[];
    getEntriesByName(name: string, type?: EntryType): PerformanceEntry[];
    getEntriesByType(type: EntryType): PerformanceEntry[];
    clearMarks(name?: string): void;
    clearMeasures(name?: string): void;
    eventLoopUtilization(
      utilization1?: EventLoopUtilization,
      utilization2?: EventLoopUtilization,
    ): EventLoopUtilization;
  }
  export const performance: Performance;
  /* Event-loop metrics: utilization (idle/active ms since the loop started)
   * and monitorEventLoopDelay's sampling histogram (nanoseconds). */
  export interface EventLoopUtilization {
    idle: number;
    active: number;
    utilization: number;
  }
  export interface EventLoopMonitorOptions {
    resolution?: number | undefined;
  }
  export interface Histogram {
    readonly count: number;
    readonly exceeds: number;
    readonly max: number;
    readonly mean: number;
    readonly min: number;
    readonly stddev: number;
    percentile(percentile: number): number;
    reset(): void;
  }
  export interface IntervalHistogram extends Histogram {
    enable(): boolean;
    disable(): boolean;
  }
  export function monitorEventLoopDelay(options?: EventLoopMonitorOptions): IntervalHistogram;
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

declare module "node:module" {
  export function createRequire(filename: string | URL): ScriptcRequire;
  export const builtinModules: string[];
  export function isBuiltin(moduleName: string): boolean;
  export function syncBuiltinESMExports(): void;
}
declare module "module" {
  export * from "node:module";
}
/* import.meta: module-loader metadata with no value representation —
 * direct file-backed fields lower to constants, while the object and
 * remaining members fence (SC1090) EXCEPT as createRequire's base, where it
 * only NAMES the containing file. Declared so unsupported forms reach their
 * named lowering fences; @types/node's own augmentation stands in when
 * adopted. */
interface ImportMeta {
  url: string;
  filename: string;
  dirname: string;
  main: boolean;
  resolve(specifier: string, parent?: string | URL): string;
}

/* The synchronous node:fs surface — utf8-only, no options objects, no
 * Buffers. Importing "node:fs" resolves here (preflight allowlists exactly
 * the ambient-declared node: modules); every function lowers to a `libCall`
 * with a scr_fs_* runtime implementation. Failures throw CATCHABLE string
 * values formatted like Node's error messages ("ENOENT: no such file or
 * directory, open 'x'"). `rmSync` removes FILES only (like Node without
 * `recursive`); empty directories go through `rmdirSync`. */
declare module "node:fs" {
  import { Readable, Writable } from "stream";
  export function readFileSync(path: string | number | URL, encoding: BufferEncoding): string;
  export function readFileSync(
    path: string | number | URL,
    options: { encoding: BufferEncoding },
  ): string;
  export function readFileSync(path: string | number | URL): Buffer;
  export function readFileSync(path: string | URL, options: unknown): string | Buffer;
  /* Error-first callbacks select string or Buffer data from their encoding.
   * Unknown options retain that union until the caller validates the value. */
  export function readFile(
    path: string,
    options: unknown,
    callback: (error: Error | null, data: string | Buffer) => void,
  ): void;
  /* The options form carries the mode (applied at CREATION only, like
   * Node — an existing file keeps its permissions) and/or the utf8
   * encoding spelling. */
  export function writeFileSync(
    path: string | URL,
    data: string,
    /* The options-record stance (see http.RequestOptions): flag fences
     * by name at the call site; undocumented keys drop like Node. */
    options?: {
      mode?: number;
      encoding?: "utf8" | "utf-8";
      flag?: string;
      [option: string]: unknown;
    },
  ): void;
  /* The bare-encoding spelling — the options record's encoding key alone. */
  export function writeFileSync(path: string | URL, data: string, encoding: "utf8" | "utf-8"): void;
  export function writeFileSync(path: string | URL, data: string | Uint8Array): void;
  export function appendFileSync(path: string | URL, data: string | Uint8Array): void;
  export function existsSync(path: string): boolean;
  export function mkdirSync(path: string | URL): void;
  export function mkdirSync(
    path: string | URL,
    options: { recursive?: boolean; mode?: number },
  ): void;
  export function unlinkSync(path: string | URL): void;
  export function chmodSync(path: string | URL, mode: number): void;
  export function fchmodSync(fd: number, mode: number): void;
  export function fsyncSync(fd: number): void;
  export function linkSync(
    existingPath: string | Uint8Array | URL,
    newPath: string | Uint8Array | URL,
  ): void;
  export function symlinkSync(
    target: string | Uint8Array | URL,
    path: string | Uint8Array | URL,
    type?: string | null,
  ): void;
  /* fs.cpSync / fs.cp: copies a file, symlink or (with recursive) a
   * directory tree. filter decides per path; the callback and promise
   * forms complete the copy before reporting. */
  export interface CopySyncOptions {
    dereference?: boolean;
    errorOnExist?: boolean;
    filter?: (source: string, destination: string) => boolean;
    force?: boolean;
    mode?: number;
    preserveTimestamps?: boolean;
    recursive?: boolean;
    verbatimSymlinks?: boolean;
  }
  export interface CopyOptions {
    dereference?: boolean;
    errorOnExist?: boolean;
    filter?: (source: string, destination: string) => boolean | Promise<boolean>;
    force?: boolean;
    mode?: number;
    preserveTimestamps?: boolean;
    recursive?: boolean;
    verbatimSymlinks?: boolean;
  }
  export function cpSync(
    source: string | URL,
    destination: string | URL,
    options?: CopySyncOptions,
  ): void;
  export function cp(
    source: string | URL,
    destination: string | URL,
    callback: (err: NodeJS.ErrnoException | null) => void,
  ): void;
  export function cp(
    source: string | URL,
    destination: string | URL,
    options: CopyOptions,
    callback: (err: NodeJS.ErrnoException | null) => void,
  ): void;
  export function symlink(
    target: string | Uint8Array | URL,
    path: string | Uint8Array | URL,
    callback: (err: NodeJS.ErrnoException | null) => void,
  ): void;
  export function symlink(
    target: string | Uint8Array | URL,
    path: string | Uint8Array | URL,
    type: string | null | undefined,
    callback: (err: NodeJS.ErrnoException | null) => void,
  ): void;
  export function link(
    existingPath: string | Uint8Array | URL,
    newPath: string | Uint8Array | URL,
    callback: (err: NodeJS.ErrnoException | null) => void,
  ): void;
  export function readlink(
    path: string | Uint8Array | URL,
    callback: (err: NodeJS.ErrnoException | null, target: string) => void,
  ): void;
  export function readlink(
    path: string | Uint8Array | URL,
    options: "buffer" | { encoding: "buffer" },
    callback: (err: NodeJS.ErrnoException | null, target: Buffer) => void,
  ): void;
  export function readlink(
    path: string | Uint8Array | URL,
    options: BufferEncoding | { encoding?: BufferEncoding | null } | null,
    callback: (err: NodeJS.ErrnoException | null, target: string) => void,
  ): void;
  export function readlink(
    path: string | Uint8Array | URL,
    options: string | { encoding?: string | null } | null,
    callback: (err: NodeJS.ErrnoException | null, target: string | Buffer) => void,
  ): void;
  export function readlinkSync(
    path: string | Uint8Array | URL,
    options: "buffer" | { encoding: "buffer" },
  ): Buffer;
  export function readlinkSync(
    path: string | Uint8Array | URL,
    options?: BufferEncoding | { encoding?: BufferEncoding | null } | null,
  ): string;
  export function readlinkSync(
    path: string | Uint8Array | URL,
    options: string | { encoding?: string | null } | null,
  ): string | Buffer;
  export function chownSync(path: string | URL, uid: number, gid: number): void;
  export function lchownSync(path: string | URL, uid: number, gid: number): void;
  export function fchownSync(fd: number, uid: number, gid: number): void;
  export function truncateSync(path: string | URL, len?: number): void;
  /* The 2-argument form only (Node's mode flags have no lowering). The
   * destination is created or truncated carrying the SOURCE's mode. */
  export function copyFileSync(src: string | URL, dest: string | URL): void;
  export function rename(
    oldPath: string,
    newPath: string,
    callback: (err: NodeJS.ErrnoException | null) => void,
  ): void;
  export function renameSync(oldPath: string | URL, newPath: string | URL): void;
  export function rmSync(path: string | URL): void;
  /* maxRetries/retryDelay are accepted no-ops (Node retries around
   * EBUSY-class races; the synchronous lowering has no re-entrancy that
   * needs them). */
  export function rmSync(
    path: string | URL,
    options: { recursive?: boolean; force?: boolean; maxRetries?: number; retryDelay?: number },
  ): void;
  export function rmdirSync(path: string | URL): void;
  export function readdirSync(path: string | URL): string[];
  /* The withFileTypes form: Dirent rows (name + parentPath + the type
   * probes — the honest subset of Node's Dirent surface). The type is
   * interned explicitly in type-mapper.ts (the record's hidden %dtype field
   * carries the entry kind; isFile/isDirectory/isSymbolicLink lower as
   * reads of it in builtins/process.ts). */
  export interface Dirent {
    name: string;
    parentPath: string;
    isFile(): boolean;
    isDirectory(): boolean;
    isSymbolicLink(): boolean;
  }
  export function readdirSync(
    path: string | URL,
    /* The options-record stance (see http.RequestOptions): recursive
     * fences by name at the call site; undocumented keys drop like Node. */
    options: { withFileTypes: true; recursive?: boolean; [option: string]: unknown },
  ): Dirent[];
  /* fs.globSync / fs.glob: Node's glob walk over the file system. Patterns
   * are minimatch globs (case-insensitive on macOS and Windows); results
   * are relative to cwd unless the pattern is absolute. withFileTypes must
   * be a literal so the result type is known. */
  export interface GlobOptions {
    cwd?: string | URL;
    exclude?: readonly string[] | ((fileName: string) => boolean);
    followSymlinks?: boolean;
    withFileTypes?: false;
  }
  export interface GlobOptionsWithFileTypes {
    cwd?: string | URL;
    exclude?: readonly string[];
    followSymlinks?: boolean;
    withFileTypes: true;
  }
  export function globSync(pattern: string | readonly string[], options?: GlobOptions): string[];
  export function globSync(
    pattern: string | readonly string[],
    options: GlobOptionsWithFileTypes,
  ): Dirent[];
  export function glob(
    pattern: string | readonly string[],
    callback: (err: NodeJS.ErrnoException | null, matches?: string[]) => void,
  ): void;
  export function glob(
    pattern: string | readonly string[],
    options: GlobOptions,
    callback: (err: NodeJS.ErrnoException | null, matches?: string[]) => void,
  ): void;
  /* fs.Dir: an open directory stream (opendirSync, fs.promises.opendir)
   * read one Dirent at a time in OS order; utf8 names, no recursive walk. */
  export interface Dir {
    readonly path: string;
    readSync(): Dirent | null;
    read(): Promise<Dirent | null>;
    closeSync(): void;
    close(): Promise<void>;
    [Symbol.asyncIterator](): AsyncIterableIterator<Dirent>;
  }
  export interface OpenDirOptions {
    encoding?: "utf8" | "utf-8";
    bufferSize?: number;
  }
  export function opendirSync(path: string | URL, options?: OpenDirOptions): Dir;
  /* fs.ReadStream / fs.WriteStream: runtime Readable and Writable streams
   * over a file (scr_fs_stream.c). The options are checked at runtime
   * with Node's rules; flags and mode are checked when the file opens, so
   * their errors arrive as 'error' events. Instances also emit 'open'
   * (with the fd) and 'ready'. */
  export interface StreamOptions {
    flags?: string;
    encoding?: BufferEncoding;
    fd?: number;
    mode?: number | string;
    autoClose?: boolean;
    emitClose?: boolean;
    start?: number;
    highWaterMark?: number;
  }
  export interface ReadStreamOptions extends StreamOptions {
    end?: number;
  }
  export interface WriteStreamOptions extends StreamOptions {
    flush?: boolean;
  }
  export class ReadStream extends Readable {
    readonly bytesRead: number;
    readonly path: string | Buffer;
    readonly pending: boolean;
    close(callback?: () => void): void;
  }
  export class WriteStream extends Writable {
    readonly bytesWritten: number;
    readonly path: string | Buffer;
    readonly pending: boolean;
    close(callback?: () => void): void;
  }
  export function createReadStream(
    path: string | Buffer | URL,
    options?: BufferEncoding | ReadStreamOptions,
  ): ReadStream;
  export function createWriteStream(
    path: string | Buffer | URL,
    options?: BufferEncoding | WriteStreamOptions,
  ): WriteStream;
  export function accessSync(path: string | URL, mode?: number): void;
  export function mkdtempSync(prefix: string | URL): string;
  export const constants: {
    readonly F_OK: number;
    readonly R_OK: number;
    readonly W_OK: number;
    readonly X_OK: number;
    readonly O_RDONLY: number;
    readonly O_WRONLY: number;
    readonly O_RDWR: number;
    readonly O_CREAT: number;
    readonly O_EXCL: number;
    readonly O_NOFOLLOW: number;
    readonly O_NONBLOCK: number;
    readonly O_TRUNC: number;
    readonly O_APPEND: number;
    readonly COPYFILE_EXCL: number;
    readonly COPYFILE_FICLONE: number;
    readonly COPYFILE_FICLONE_FORCE: number;
    readonly UV_FS_SYMLINK_DIR: number;
    readonly UV_FS_SYMLINK_JUNCTION: number;
    readonly UV_DIRENT_UNKNOWN: number;
    readonly UV_DIRENT_FILE: number;
    readonly UV_DIRENT_DIR: number;
    readonly UV_DIRENT_LINK: number;
    readonly UV_DIRENT_FIFO: number;
    readonly UV_DIRENT_SOCKET: number;
    readonly UV_DIRENT_CHAR: number;
    readonly UV_DIRENT_BLOCK: number;
    readonly UV_FS_O_FILEMAP: number;
    readonly UV_FS_O_TEMPORARY: number;
    readonly UV_FS_O_SHORT_LIVED: number;
    readonly UV_FS_O_SEQUENTIAL: number;
    readonly UV_FS_O_RANDOM: number;
    readonly UV_FS_COPYFILE_EXCL: number;
    readonly UV_FS_COPYFILE_FICLONE: number;
    readonly UV_FS_COPYFILE_FICLONE_FORCE: number;
    readonly S_IFMT: number;
    readonly S_IFREG: number;
    readonly S_IFDIR: number;
    readonly S_IFCHR: number;
    readonly S_IFBLK: number;
    readonly S_IFIFO: number;
    readonly S_IFLNK: number;
    readonly S_IFSOCK: number;
    readonly O_NOCTTY: number;
    readonly O_DIRECTORY: number;
    readonly O_NOATIME: number;
    readonly O_SYNC: number;
    readonly O_DSYNC: number;
    readonly O_SYMLINK: number;
    readonly O_DIRECT: number;
    readonly S_IRWXU: number;
    readonly S_IRUSR: number;
    readonly S_IWUSR: number;
    readonly S_IXUSR: number;
    readonly S_IRWXG: number;
    readonly S_IRGRP: number;
    readonly S_IWGRP: number;
    readonly S_IXGRP: number;
    readonly S_IRWXO: number;
    readonly S_IROTH: number;
    readonly S_IWOTH: number;
    readonly S_IXOTH: number;
  };
  /* A stat(2) snapshot (statSync follows symlinks, lstatSync does not —
   * Node's split) — immutable; the supported surface is exactly these
   * members. dev/ino identify the filesystem entry, blocks is the allocated
   * size in 512-byte units, and the time fields are milliseconds with their
   * sub-second fractions. */
  export interface Stats {
    isFile(): boolean;
    isDirectory(): boolean;
    isSymbolicLink(): boolean;
    isBlockDevice(): boolean;
    isCharacterDevice(): boolean;
    isFIFO(): boolean;
    isSocket(): boolean;
    readonly dev: number;
    readonly mode: number;
    readonly nlink: number;
    readonly uid: number;
    readonly gid: number;
    readonly rdev: number;
    readonly blksize: number;
    readonly ino: number;
    readonly size: number;
    readonly blocks: number;
    readonly atimeMs: number;
    readonly mtimeMs: number;
    readonly ctimeMs: number;
    readonly birthtimeMs: number;
    readonly atime: Date;
    readonly mtime: Date;
    readonly ctime: Date;
    readonly birthtime: Date;
  }
  /* throwIfNoEntry: false answers undefined for a missing entry (ENOENT or
   * ENOTDIR) instead of throwing. BigIntStats (bigint: true) has no
   * lowering. */
  export interface StatSyncOptions {
    bigint?: boolean;
    throwIfNoEntry?: boolean;
  }
  export function statSync(path: string | URL, options?: undefined): Stats;
  export function statSync(
    path: string | URL,
    options: StatSyncOptions & { bigint?: false; throwIfNoEntry: false },
  ): Stats | undefined;
  export function statSync(
    path: string | URL,
    options: StatSyncOptions & { bigint?: false; throwIfNoEntry?: true },
  ): Stats;
  /* bigint: true type-checks so the lowering can name it as unsupported. */
  export function statSync(path: string | URL, options: StatSyncOptions & { bigint: true }): Stats;
  export function statSync(path: string | URL, options: StatSyncOptions): Stats | undefined;
  export function lstatSync(path: string | URL, options?: undefined): Stats;
  export function lstatSync(
    path: string | URL,
    options: StatSyncOptions & { bigint?: false; throwIfNoEntry: false },
  ): Stats | undefined;
  export function lstatSync(
    path: string | URL,
    options: StatSyncOptions & { bigint?: false; throwIfNoEntry?: true },
  ): Stats;
  /* bigint: true type-checks so the lowering can name it as unsupported. */
  export function lstatSync(path: string | URL, options: StatSyncOptions & { bigint: true }): Stats;
  export function lstatSync(path: string | URL, options: StatSyncOptions): Stats | undefined;
  /* The fd pair behind spawn's fd-stdio form: openSync(path, flags) →
   * the raw fd. Numeric flags use an inline OR of the O_* constants. */
  export function openSync(path: string | URL, flags: string): number;
  export function openSync(path: string | URL, flags: number, mode?: number): number;
  export function closeSync(fd: number): void;
  export function fdatasyncSync(fd: number): void;
  export function ftruncateSync(fd: number, len?: number): void;
  export function utimesSync(
    path: string | Uint8Array | URL,
    atime: number | string | Date,
    mtime: number | string | Date,
  ): void;
  export function futimesSync(
    fd: number,
    atime: number | string | Date,
    mtime: number | string | Date,
  ): void;
  export function lutimesSync(
    path: string | Uint8Array | URL,
    atime: number | string | Date,
    mtime: number | string | Date,
  ): void;
  export function utimes(
    path: string | Uint8Array | URL,
    atime: number | string | Date,
    mtime: number | string | Date,
    callback: (err: NodeJS.ErrnoException | null) => void,
  ): void;
  export function futimes(
    fd: number,
    atime: number | string | Date,
    mtime: number | string | Date,
    callback: (err: NodeJS.ErrnoException | null) => void,
  ): void;
  export function lutimes(
    path: string | Uint8Array | URL,
    atime: number | string | Date,
    mtime: number | string | Date,
    callback: (err: NodeJS.ErrnoException | null) => void,
  ): void;
  export function readvSync(fd: number, buffers: Uint8Array[], position?: number | null): number;
  export function writevSync(fd: number, buffers: Uint8Array[], position?: number | null): number;
  /* Read into a caller buffer from the fd's current position when position
   * is omitted/null, or from a numeric byte position without advancing the
   * fd. Answers the byte count, 0 at EOF. */
  export interface ReadSyncOptions {
    offset?: number;
    length?: number;
    position?: number | null;
  }
  export function readSync(fd: number, buffer: Uint8Array, options?: ReadSyncOptions): number;
  export function readSync(
    fd: number,
    buffer: Uint8Array,
    offset: number,
    length: number,
    position?: number | null,
  ): number;
  /* Write a caller-buffer window, or a utf8 string, at the fd's current
   * position when position is omitted/null (advancing it), or at a numeric
   * byte position without advancing it. Answers the byte count. */
  export interface WriteSyncOptions {
    offset?: number;
    length?: number;
    position?: number | null;
  }
  export function writeSync(fd: number, buffer: Uint8Array, options: WriteSyncOptions): number;
  export function writeSync(
    fd: number,
    buffer: Uint8Array,
    offset?: number,
    length?: number,
    position?: number | null,
  ): number;
  export function writeSync(
    fd: number,
    string: string,
    position?: number | null,
    encoding?: "utf8" | "utf-8",
  ): number;
  /* statSync over an open fd — the same Stats snapshot. */
  export function fstatSync(fd: number): Stats;
  /* realpath(3) — resolves symlinks, `.`/`..`, throwing Node's fs error
   * shapes for missing paths. */
  export function realpathSync(path: string | URL): string;
  export namespace realpathSync {
    function native(path: string | URL): string;
  }
  /* statfs(2)/statvfs(3) — the filesystem-capacity snapshot (the fields
   * Node's statfsSync reports; bavail × bsize is the free-space probe). */
  export interface StatsFsBase<T> {
    type: T;
    bsize: T;
    blocks: T;
    bfree: T;
    bavail: T;
    files: T;
    ffree: T;
  }
  export interface StatsFs extends StatsFsBase<number> {}
  export interface BigIntStatsFs extends StatsFsBase<bigint> {}
  export interface StatFsOptions {
    bigint?: boolean;
  }
  export function statfsSync(
    path: string | Uint8Array | URL,
    options?: StatFsOptions & { bigint?: false },
  ): StatsFs;
  export function statfsSync(
    path: string | Uint8Array | URL,
    options: StatFsOptions & { bigint: true },
  ): BigIntStatsFs;
  export function statfsSync(
    path: string | Uint8Array | URL,
    options?: StatFsOptions,
  ): StatsFs | BigIntStatsFs;
  export function statfs(
    path: string | Uint8Array | URL,
    callback: (err: NodeJS.ErrnoException | null, stats: StatsFs) => void,
  ): void;
  export function statfs(
    path: string | Uint8Array | URL,
    options: (StatFsOptions & { bigint?: false }) | undefined,
    callback: (err: NodeJS.ErrnoException | null, stats: StatsFs) => void,
  ): void;
  export function statfs(
    path: string | Uint8Array | URL,
    options: StatFsOptions & { bigint: true },
    callback: (err: NodeJS.ErrnoException | null, stats: BigIntStatsFs) => void,
  ): void;
  export function statfs(
    path: string | Uint8Array | URL,
    options: StatFsOptions | undefined,
    callback: (err: NodeJS.ErrnoException | null, stats: StatsFs | BigIntStatsFs) => void,
  ): void;
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
/* graceful-fs — served as node:fs (it monkeypatches fs and retries on
 * EMFILE/ENFILE; compiled programs call fs directly, without the retry
 * queue). gracefulify is a no-op statement. The @types/graceful-fs shape. */
declare module "graceful-fs" {
  export * from "node:fs";
  export function gracefulify<T>(fsModule: T): T;
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
  export interface FileReadvResult<T extends Uint8Array[]> {
    bytesRead: number;
    buffers: T;
  }
  export interface FileWritevResult<T extends Uint8Array[]> {
    bytesWritten: number;
    buffers: T;
  }
  export interface FileReadOptions<T extends Uint8Array = Buffer> {
    buffer?: T;
    offset?: number | null;
    length?: number | null;
    position?: number | null;
  }
  /* The streams over a FileHandle (createReadStream, createWriteStream,
   * readLines): fs streams that hold the handle until they close; closing
   * the stream closes the handle unless autoClose is false. */
  export interface CreateReadStreamOptions {
    encoding?: BufferEncoding | null;
    autoClose?: boolean;
    emitClose?: boolean;
    start?: number;
    end?: number;
    highWaterMark?: number;
  }
  export interface CreateWriteStreamOptions {
    encoding?: BufferEncoding | null;
    autoClose?: boolean;
    emitClose?: boolean;
    start?: number;
    highWaterMark?: number;
    flush?: boolean;
  }
  export interface FileHandle extends AsyncDisposable {
    readonly fd: number;
    close(): Promise<void>;
    createReadStream(options?: CreateReadStreamOptions): import("node:fs").ReadStream;
    createWriteStream(options?: CreateWriteStreamOptions): import("node:fs").WriteStream;
    readLines(options?: CreateReadStreamOptions): import("node:readline").Interface;
    sync(): Promise<void>;
    datasync(): Promise<void>;
    truncate(len?: number): Promise<void>;
    chmod(mode: number): Promise<void>;
    utimes(atime: number | string | Date, mtime: number | string | Date): Promise<void>;
    readv<T extends Uint8Array[]>(
      buffers: T,
      position?: number | null,
    ): Promise<FileReadvResult<T>>;
    writev<T extends Uint8Array[]>(
      buffers: T,
      position?: number | null,
    ): Promise<FileWritevResult<T>>;
    read<T extends Uint8Array = Buffer>(
      options?: FileReadOptions<T> | null,
    ): Promise<FileReadResult<T>>;
    read<T extends Uint8Array>(
      buffer: T,
      options: Omit<FileReadOptions<T>, "buffer">,
    ): Promise<FileReadResult<T>>;
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
    write<T extends Uint8Array>(
      buffer: T,
      options: Omit<FileReadOptions<T>, "buffer">,
    ): Promise<FileWriteResult<T>>;
    write(
      data: string,
      position?: number | null,
      encoding?: "utf8" | "utf-8" | null,
    ): Promise<FileWriteResult<string>>;
    readFile(options?: null): Promise<Buffer>;
    readFile(encoding: "utf8" | "utf-8"): Promise<string>;
    writeFile(data: string | Uint8Array, encoding?: "utf8" | "utf-8" | null): Promise<void>;
    appendFile(data: string | Uint8Array, encoding?: "utf8" | "utf-8" | null): Promise<void>;
    stat(): Promise<import("node:fs").Stats>;
    [Symbol.asyncDispose](): Promise<void>;
  }
  export function open(path: string, flags?: string, mode?: number): Promise<FileHandle>;
  export function link(
    existingPath: string | Uint8Array | URL,
    newPath: string | Uint8Array | URL,
  ): Promise<void>;
  export function symlink(
    target: string | Uint8Array | URL,
    path: string | Uint8Array | URL,
    type?: string | null,
  ): Promise<void>;
  export function cp(
    source: string | URL,
    destination: string | URL,
    options?: import("node:fs").CopyOptions,
  ): Promise<void>;
  export function readlink(
    path: string | Uint8Array | URL,
    options: "buffer" | { encoding: "buffer" },
  ): Promise<Buffer>;
  export function readlink(
    path: string | Uint8Array | URL,
    options?: BufferEncoding | { encoding?: BufferEncoding | null } | null,
  ): Promise<string>;
  export function readlink(
    path: string | Uint8Array | URL,
    options: string | { encoding?: string | null } | null,
  ): Promise<string | Buffer>;
  export function utimes(
    path: string | Uint8Array | URL,
    atime: number | string | Date,
    mtime: number | string | Date,
  ): Promise<void>;
  export function lutimes(
    path: string | Uint8Array | URL,
    atime: number | string | Date,
    mtime: number | string | Date,
  ): Promise<void>;
  export function readFile(path: string, encoding: "utf8" | "utf-8"): Promise<string>;
  export function readFile(
    path: string,
    options: BufferEncoding | { encoding: BufferEncoding },
  ): Promise<string>;
  export function readFile(path: string): Promise<Buffer>;
  export function writeFile(
    path: string,
    data: string,
    options?: {
      mode?: number;
      encoding?: "utf8" | "utf-8";
      flag?: string;
      [option: string]: unknown;
    },
  ): Promise<void>;
  export function writeFile(path: string, data: string, encoding: "utf8" | "utf-8"): Promise<void>;
  export function mkdir(
    path: string,
    options?: { recursive?: boolean; mode?: number },
  ): Promise<void>;
  export function readdir(path: string): Promise<string[]>;
  export function readdir(
    path: string,
    options: {
      encoding?: "utf8" | "utf-8";
      withFileTypes: true;
      recursive?: boolean;
      [option: string]: unknown;
    },
  ): Promise<import("node:fs").Dirent[]>;
  /* The async iterator form of fs.globSync: iterate it with for await. */
  export function glob(
    pattern: string | readonly string[],
    options?: import("node:fs").GlobOptions,
  ): AsyncIterableIterator<string>;
  export function glob(
    pattern: string | readonly string[],
    options: import("node:fs").GlobOptionsWithFileTypes,
  ): AsyncIterableIterator<import("node:fs").Dirent>;
  export function rm(path: string): Promise<void>;
  export function rm(
    path: string,
    options: { recursive?: boolean; force?: boolean; maxRetries?: number; retryDelay?: number },
  ): Promise<void>;
  export function stat(path: string): Promise<import("node:fs").Stats>;
  export function statfs(
    path: string | Uint8Array | URL,
    options?: import("node:fs").StatFsOptions & { bigint?: false },
  ): Promise<import("node:fs").StatsFs>;
  export function statfs(
    path: string | Uint8Array | URL,
    options: import("node:fs").StatFsOptions & { bigint: true },
  ): Promise<import("node:fs").BigIntStatsFs>;
  export function statfs(
    path: string | Uint8Array | URL,
    options?: import("node:fs").StatFsOptions,
  ): Promise<import("node:fs").StatsFs | import("node:fs").BigIntStatsFs>;
  export function realpath(path: string): Promise<string>;
  export function lstat(path: string): Promise<import("node:fs").Stats>;
  export function unlink(path: string): Promise<void>;
  export function chmod(path: string, mode: number): Promise<void>;
  export function chown(path: string, uid: number, gid: number): Promise<void>;
  export function lchown(path: string, uid: number, gid: number): Promise<void>;
  export function access(path: string, mode?: number): Promise<void>;
  export function truncate(path: string, len?: number): Promise<void>;
  export function appendFile(path: string, data: string | Uint8Array): Promise<void>;
  export function copyFile(src: string, dest: string): Promise<void>;
  export function mkdtemp(prefix: string): Promise<string>;
  export function rmdir(path: string): Promise<void>;
  export function rename(oldPath: string, newPath: string): Promise<void>;
  export function opendir(
    path: string,
    options?: import("node:fs").OpenDirOptions,
  ): Promise<import("node:fs").Dir>;
}
declare module "node:fs/promises" {
  export * from "fs/promises";
}

/* node:path — the TARGET platform's implementation (Node's rule): posix
 * on posix triples, path.win32 under a win32 triple, with the posix and
 * win32 namespaces answering their own platform anywhere. Every function
 * is a pure string algorithm matching Node's implementations
 * exactly; join/resolve are variadic like Node's. */
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
  /* matchesGlob() is Node's glob matcher: brace expansion, extglobs, POSIX
   * classes and the ** and dot rules. */
  export function matchesGlob(path: string, pattern: string): boolean;
  /* parse() splits a path into its root, directory, base, extension and
   * name; format() joins those fields back (Node's `||` defaults). */
  export interface ParsedPath {
    root: string;
    dir: string;
    base: string;
    ext: string;
    name: string;
  }
  export interface FormatInputPathObject {
    root?: string | undefined;
    dir?: string | undefined;
    base?: string | undefined;
    ext?: string | undefined;
    name?: string | undefined;
  }
  export function parse(path: string): ParsedPath;
  export function format(pathObject: FormatInputPathObject): string;
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
  export function matchesGlob(path: string, pattern: string): boolean;
  export function parse(path: string): import("path").ParsedPath;
  export function format(pathObject: import("path").FormatInputPathObject): string;
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
  export function matchesGlob(path: string, pattern: string): boolean;
  export function parse(path: string): import("path").ParsedPath;
  export function format(pathObject: import("path").FormatInputPathObject): string;
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
  export function availableParallelism(): number;
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
  /* Host facts, libuv's answers: model/speed/times per logical CPU, the
   * host name, the 1/5/15-minute load averages, uptime in seconds, free
   * memory in bytes, process.arch, uname's machine and version fields,
   * the byte order, and a process's scheduling priority (an omitted pid
   * is the current process). Shapes mirror @types/node's. */
  export interface CpuInfo {
    model: string;
    speed: number;
    times: {
      user: number;
      nice: number;
      sys: number;
      idle: number;
      irq: number;
    };
  }
  export function cpus(): CpuInfo[];
  export function hostname(): string;
  export function loadavg(): number[];
  export function uptime(): number;
  export function freemem(): number;
  export function arch(): string;
  export function machine(): string;
  export function version(): string;
  export function endianness(): "BE" | "LE";
  export function getPriority(pid?: number): number;
  export function setPriority(priority: number): void;
  export function setPriority(pid: number, priority: number): void;
  /* The TARGET platform's null device ("\\\\.\\nul" under a win32 triple). */
  export const devNull: string;
  /* The platform's constants: null-prototype objects with read-only
   * members, `signals` frozen (Node's internalBinding('constants').os). */
  export type SignalConstants = {
    [
      key in
        | "SIGABRT"
        | "SIGALRM"
        | "SIGBUS"
        | "SIGCHLD"
        | "SIGCONT"
        | "SIGFPE"
        | "SIGHUP"
        | "SIGILL"
        | "SIGINT"
        | "SIGIO"
        | "SIGIOT"
        | "SIGKILL"
        | "SIGPIPE"
        | "SIGPOLL"
        | "SIGPROF"
        | "SIGPWR"
        | "SIGQUIT"
        | "SIGSEGV"
        | "SIGSTKFLT"
        | "SIGSTOP"
        | "SIGSYS"
        | "SIGTERM"
        | "SIGTRAP"
        | "SIGTSTP"
        | "SIGTTIN"
        | "SIGTTOU"
        | "SIGUNUSED"
        | "SIGURG"
        | "SIGUSR1"
        | "SIGUSR2"
        | "SIGVTALRM"
        | "SIGWINCH"
        | "SIGXCPU"
        | "SIGXFSZ"
        | "SIGBREAK"
        | "SIGLOST"
        | "SIGINFO"
    ]: number;
  };
  export namespace constants {
    const UV_UDP_REUSEADDR: number;
    namespace signals {}
    const signals: SignalConstants;
    namespace errno {
      const E2BIG: number;
      const EACCES: number;
      const EADDRINUSE: number;
      const EADDRNOTAVAIL: number;
      const EAFNOSUPPORT: number;
      const EAGAIN: number;
      const EALREADY: number;
      const EBADF: number;
      const EBADMSG: number;
      const EBUSY: number;
      const ECANCELED: number;
      const ECHILD: number;
      const ECONNABORTED: number;
      const ECONNREFUSED: number;
      const ECONNRESET: number;
      const EDEADLK: number;
      const EDESTADDRREQ: number;
      const EDOM: number;
      const EDQUOT: number;
      const EEXIST: number;
      const EFAULT: number;
      const EFBIG: number;
      const EHOSTUNREACH: number;
      const EIDRM: number;
      const EILSEQ: number;
      const EINPROGRESS: number;
      const EINTR: number;
      const EINVAL: number;
      const EIO: number;
      const EISCONN: number;
      const EISDIR: number;
      const ELOOP: number;
      const EMFILE: number;
      const EMLINK: number;
      const EMSGSIZE: number;
      const EMULTIHOP: number;
      const ENAMETOOLONG: number;
      const ENETDOWN: number;
      const ENETRESET: number;
      const ENETUNREACH: number;
      const ENFILE: number;
      const ENOBUFS: number;
      const ENODATA: number;
      const ENODEV: number;
      const ENOENT: number;
      const ENOEXEC: number;
      const ENOLCK: number;
      const ENOLINK: number;
      const ENOMEM: number;
      const ENOMSG: number;
      const ENOPROTOOPT: number;
      const ENOSPC: number;
      const ENOSR: number;
      const ENOSTR: number;
      const ENOSYS: number;
      const ENOTCONN: number;
      const ENOTDIR: number;
      const ENOTEMPTY: number;
      const ENOTSOCK: number;
      const ENOTSUP: number;
      const ENOTTY: number;
      const ENXIO: number;
      const EOPNOTSUPP: number;
      const EOVERFLOW: number;
      const EPERM: number;
      const EPIPE: number;
      const EPROTO: number;
      const EPROTONOSUPPORT: number;
      const EPROTOTYPE: number;
      const ERANGE: number;
      const EROFS: number;
      const ESPIPE: number;
      const ESRCH: number;
      const ESTALE: number;
      const ETIME: number;
      const ETIMEDOUT: number;
      const ETXTBSY: number;
      const EWOULDBLOCK: number;
      const EXDEV: number;
      const WSAEINTR: number;
      const WSAEBADF: number;
      const WSAEACCES: number;
      const WSAEFAULT: number;
      const WSAEINVAL: number;
      const WSAEMFILE: number;
      const WSAEWOULDBLOCK: number;
      const WSAEINPROGRESS: number;
      const WSAEALREADY: number;
      const WSAENOTSOCK: number;
      const WSAEDESTADDRREQ: number;
      const WSAEMSGSIZE: number;
      const WSAEPROTOTYPE: number;
      const WSAENOPROTOOPT: number;
      const WSAEPROTONOSUPPORT: number;
      const WSAESOCKTNOSUPPORT: number;
      const WSAEOPNOTSUPP: number;
      const WSAEPFNOSUPPORT: number;
      const WSAEAFNOSUPPORT: number;
      const WSAEADDRINUSE: number;
      const WSAEADDRNOTAVAIL: number;
      const WSAENETDOWN: number;
      const WSAENETUNREACH: number;
      const WSAENETRESET: number;
      const WSAECONNABORTED: number;
      const WSAECONNRESET: number;
      const WSAENOBUFS: number;
      const WSAEISCONN: number;
      const WSAENOTCONN: number;
      const WSAESHUTDOWN: number;
      const WSAETOOMANYREFS: number;
      const WSAETIMEDOUT: number;
      const WSAECONNREFUSED: number;
      const WSAELOOP: number;
      const WSAENAMETOOLONG: number;
      const WSAEHOSTDOWN: number;
      const WSAEHOSTUNREACH: number;
      const WSAENOTEMPTY: number;
      const WSAEPROCLIM: number;
      const WSAEUSERS: number;
      const WSAEDQUOT: number;
      const WSAESTALE: number;
      const WSAEREMOTE: number;
      const WSASYSNOTREADY: number;
      const WSAVERNOTSUPPORTED: number;
      const WSANOTINITIALISED: number;
      const WSAEDISCON: number;
      const WSAENOMORE: number;
      const WSAECANCELLED: number;
      const WSAEINVALIDPROCTABLE: number;
      const WSAEINVALIDPROVIDER: number;
      const WSAEPROVIDERFAILEDINIT: number;
      const WSASYSCALLFAILURE: number;
      const WSASERVICE_NOT_FOUND: number;
      const WSATYPE_NOT_FOUND: number;
      const WSA_E_NO_MORE: number;
      const WSA_E_CANCELLED: number;
      const WSAEREFUSED: number;
    }
    namespace dlopen {
      const RTLD_LAZY: number;
      const RTLD_NOW: number;
      const RTLD_GLOBAL: number;
      const RTLD_LOCAL: number;
      const RTLD_DEEPBIND: number;
    }
    namespace priority {
      const PRIORITY_LOW: number;
      const PRIORITY_BELOW_NORMAL: number;
      const PRIORITY_NORMAL: number;
      const PRIORITY_ABOVE_NORMAL: number;
      const PRIORITY_HIGH: number;
      const PRIORITY_HIGHEST: number;
    }
  }
}
declare module "node:os" {
  export * from "os";
}

/* The WHATWG URL class (a Node global; the es2023 lib doesn't declare it),
 * typed as exactly the supported surface: construction from an input and
 * optional base (invalid input throws a catchable TypeError, like Node), the
 * protocol/origin/username/pathname/href/host/hostname/port/search/hash getters, searchParams (the
 * LIVE query view — mutations through it re-serialize into the URL, so
 * href reflects immediately; every read answers the same object, Node's
 * caching), toString()/toJSON() (href serialization), and the non-throwing
 * canParse()/parse() factories (conversion errors still propagate).
 * URL components except origin and searchParams support assignment;
 * the live searchParams view also mutates the query. URL values participate in
 * unions (URL | undefined). The parser covers the common CLI schemes
 * exactly (http/https/ws/wss/ftp/file authority URLs, opaque paths like
 * data: and mailto:) — divergences from the full WHATWG algorithm are
 * documented in SEMANTICS.md. */
interface URL {
  protocol: string;
  readonly origin: string;
  username: string;
  password: string;
  pathname: string;
  href: string;
  host: string;
  hostname: string;
  port: string;
  search: string;
  hash: string;
  readonly searchParams: URLSearchParams;
  toString(): string;
  toJSON(): string;
}
declare var URL: {
  new (input: string | { toString: () => string }, base?: string | URL): URL;
  canParse(input: string | URL, base?: string | URL): boolean;
  parse(input: string | URL, base?: string | URL): URL | null;
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
 * encodes it into a file: URL. The legacy API: parse() answers a Url
 * object, format() serializes a Url-shaped object, a string, or a URL,
 * resolve() resolves one URL string against another, and the domain pair
 * converts a hostname to and from its Punycode form. */
declare module "url" {
  export type URL = globalThis.URL;
  export type URLSearchParams = globalThis.URLSearchParams;
  export const URL: typeof globalThis.URL;
  export const URLSearchParams: typeof globalThis.URLSearchParams;
  export function fileURLToPath(url: string | URL, options?: { windows?: boolean }): string;
  export function fileURLToPathBuffer(url: string | URL, options?: { windows?: boolean }): Buffer;
  export function pathToFileURL(path: string, options?: { windows?: boolean }): URL;
  export interface UrlObject {
    auth?: string | null | undefined;
    hash?: string | null | undefined;
    host?: string | null | undefined;
    hostname?: string | null | undefined;
    href?: string | null | undefined;
    pathname?: string | null | undefined;
    protocol?: string | null | undefined;
    search?: string | null | undefined;
    slashes?: boolean | null | undefined;
    port?: string | number | null | undefined;
    query?: string | null | import("querystring").ParsedUrlQueryInput | undefined;
  }
  export interface Url {
    auth: string | null;
    hash: string | null;
    host: string | null;
    hostname: string | null;
    href: string;
    path: string | null;
    pathname: string | null;
    protocol: string | null;
    search: string | null;
    slashes: boolean | null;
    port: string | null;
    query: string | null | import("querystring").ParsedUrlQuery;
  }
  export interface UrlWithParsedQuery extends Url {
    query: import("querystring").ParsedUrlQuery;
  }
  export interface UrlWithStringQuery extends Url {
    query: string | null;
  }
  export interface URLFormatOptions {
    auth?: boolean | undefined;
    fragment?: boolean | undefined;
    search?: boolean | undefined;
    unicode?: boolean | undefined;
  }
  export function parse(
    urlString: string,
    parseQueryString?: false,
    slashesDenoteHost?: boolean,
  ): UrlWithStringQuery;
  export function parse(
    urlString: string,
    parseQueryString: true,
    slashesDenoteHost?: boolean,
  ): UrlWithParsedQuery;
  export function parse(
    urlString: string,
    parseQueryString: boolean,
    slashesDenoteHost?: boolean,
  ): Url;
  export function format(urlObject: URL, options?: URLFormatOptions): string;
  export function format(urlObject: UrlObject | string): string;
  export function resolve(from: string, to: string): string;
  export function domainToASCII(domain: string): string;
  export function domainToUnicode(domain: string): string;
}
declare module "node:url" {
  export * from "url";
}

/* node:crypto: the static hashing/MAC/random/key-derivation utility slice. */
declare module "crypto" {
  import { Transform } from "stream";
  export type KeyObjectType = "secret" | "public" | "private";
  export interface JsonWebKey {
    crv?: string;
    d?: string;
    dp?: string;
    dq?: string;
    e?: string;
    k?: string;
    kty?: string;
    n?: string;
    p?: string;
    q?: string;
    qi?: string;
    x?: string;
    y?: string;
    [key: string]: unknown;
  }
  export interface JwkKeyExportOptions {
    format: "jwk";
  }
  export interface KeyExportOptions {
    format?: "buffer" | undefined;
  }
  export type KeyFormat = "pem" | "der" | "jwk";
  export interface AsymmetricKeyExportOptions<T extends KeyFormat> {
    type: "pkcs1" | "spki" | "pkcs8" | "sec1";
    format: T;
  }
  export interface AsymmetricKeyDetails {
    modulusLength?: number;
    publicExponent?: bigint;
    namedCurve?: string;
  }
  /* Secret keys, and RSA and EC private and public keys. */
  export class KeyObject {
    private constructor();
    type: KeyObjectType;
    symmetricKeySize?: number;
    asymmetricKeyType?: string;
    asymmetricKeyDetails?: AsymmetricKeyDetails;
    export(options: AsymmetricKeyExportOptions<"pem">): string | Buffer;
    export(options: AsymmetricKeyExportOptions<"der">): Buffer;
    export(options?: KeyExportOptions): Buffer;
    export(options: JwkKeyExportOptions): JsonWebKey;
    equals(otherKeyObject: KeyObject): boolean;
  }
  export interface PrivateKeyInput {
    key: string | Buffer;
    format?: "pem" | "der" | undefined;
    type?: "pkcs1" | "pkcs8" | "sec1" | undefined;
    encoding?: string | undefined;
  }
  export interface PublicKeyInput {
    key: string | Buffer;
    format?: "pem" | "der" | undefined;
    type?: "pkcs1" | "spki" | undefined;
    encoding?: string | undefined;
  }
  export interface JsonWebKeyInput {
    key: JsonWebKey;
    format: "jwk";
  }
  export function createPrivateKey(
    key: PrivateKeyInput | string | Buffer | JsonWebKeyInput,
  ): KeyObject;
  export function createPublicKey(
    key: PublicKeyInput | string | Buffer | KeyObject | JsonWebKeyInput,
  ): KeyObject;
  export interface KeyPairKeyObjectResult {
    publicKey: KeyObject;
    privateKey: KeyObject;
  }
  export interface KeyPairSyncResult<T1 extends string | Buffer, T2 extends string | Buffer> {
    publicKey: T1;
    privateKey: T2;
  }
  export interface RSAKeyPairKeyObjectOptions {
    modulusLength: number;
    publicExponent?: number | undefined;
  }
  export interface ECKeyPairKeyObjectOptions {
    namedCurve: string;
  }
  export interface RSAKeyPairOptions<PubF extends KeyFormat, PrivF extends KeyFormat> {
    modulusLength: number;
    publicExponent?: number | undefined;
    publicKeyEncoding: { type: "pkcs1" | "spki"; format: PubF };
    privateKeyEncoding: { type: "pkcs1" | "pkcs8"; format: PrivF };
  }
  export interface ECKeyPairOptions<PubF extends KeyFormat, PrivF extends KeyFormat> {
    namedCurve: string;
    publicKeyEncoding: { type: "pkcs1" | "spki"; format: PubF };
    privateKeyEncoding: { type: "sec1" | "pkcs8"; format: PrivF };
  }
  export function generateKeyPairSync(
    type: "rsa",
    options: RSAKeyPairOptions<"pem", "pem">,
  ): KeyPairSyncResult<string, string>;
  export function generateKeyPairSync(
    type: "rsa",
    options: RSAKeyPairOptions<"der", "der">,
  ): KeyPairSyncResult<Buffer, Buffer>;
  export function generateKeyPairSync(
    type: "rsa",
    options: RSAKeyPairKeyObjectOptions,
  ): KeyPairKeyObjectResult;
  export function generateKeyPairSync(
    type: "ec",
    options: ECKeyPairOptions<"pem", "pem">,
  ): KeyPairSyncResult<string, string>;
  export function generateKeyPairSync(
    type: "ec",
    options: ECKeyPairOptions<"der", "der">,
  ): KeyPairSyncResult<Buffer, Buffer>;
  export function generateKeyPairSync(
    type: "ec",
    options: ECKeyPairKeyObjectOptions,
  ): KeyPairKeyObjectResult;
  export interface ED25519KeyPairOptions<PubF extends KeyFormat, PrivF extends KeyFormat> {
    publicKeyEncoding: { type: "spki"; format: PubF };
    privateKeyEncoding: { type: "pkcs8"; format: PrivF };
  }
  export function generateKeyPairSync(
    type: "ed25519",
    options: ED25519KeyPairOptions<"pem", "pem">,
  ): KeyPairSyncResult<string, string>;
  export function generateKeyPairSync(
    type: "ed25519",
    options: ED25519KeyPairOptions<"der", "der">,
  ): KeyPairSyncResult<Buffer, Buffer>;
  export function generateKeyPairSync(type: "ed25519", options?: {}): KeyPairKeyObjectResult;
  export function generateKeyPair(
    type: "ed25519",
    options: {} | undefined,
    callback: (err: Error | null, publicKey: KeyObject, privateKey: KeyObject) => void,
  ): void;
  export function generateKeyPair(
    type: "rsa",
    options: RSAKeyPairKeyObjectOptions,
    callback: (err: Error | null, publicKey: KeyObject, privateKey: KeyObject) => void,
  ): void;
  export function generateKeyPair(
    type: "ec",
    options: ECKeyPairKeyObjectOptions,
    callback: (err: Error | null, publicKey: KeyObject, privateKey: KeyObject) => void,
  ): void;
  export interface SigningOptions {
    padding?: number | undefined;
    saltLength?: number | undefined;
    dsaEncoding?: "der" | "ieee-p1363" | undefined;
  }
  export interface SignPrivateKeyInput extends PrivateKeyInput, SigningOptions {}
  export interface SignKeyObjectInput extends SigningOptions {
    key: KeyObject;
  }
  export interface VerifyPublicKeyInput extends PublicKeyInput, SigningOptions {}
  export interface VerifyKeyObjectInput extends SigningOptions {
    key: KeyObject;
  }
  export function sign(
    algorithm: string | null | undefined,
    data: ArrayBufferView,
    key: KeyObject | string | Buffer | SignKeyObjectInput | SignPrivateKeyInput,
  ): Buffer;
  export function verify(
    algorithm: string | null | undefined,
    data: ArrayBufferView,
    key: KeyObject | string | Buffer | VerifyKeyObjectInput | VerifyPublicKeyInput,
    signature: ArrayBufferView,
  ): boolean;
  /* Sign and Verify accumulate update() data; they are not usable as
   * writable streams. */
  export class Sign {
    private constructor();
    update(data: string | ArrayBufferView): this;
    update(data: string, inputEncoding: Encoding): this;
    sign(
      privateKey: KeyObject | string | Buffer | SignKeyObjectInput | SignPrivateKeyInput,
    ): Buffer;
    sign(
      privateKey: KeyObject | string | Buffer | SignKeyObjectInput | SignPrivateKeyInput,
      outputFormat: BinaryToTextEncoding,
    ): string;
  }
  export class Verify {
    private constructor();
    update(data: string | ArrayBufferView): this;
    update(data: string, inputEncoding: Encoding): this;
    verify(
      object: KeyObject | string | Buffer | VerifyKeyObjectInput | VerifyPublicKeyInput,
      signature: ArrayBufferView,
    ): boolean;
    verify(
      object: KeyObject | string | Buffer | VerifyKeyObjectInput | VerifyPublicKeyInput,
      signature: string,
      signatureEncoding?: BinaryToTextEncoding,
    ): boolean;
  }
  export function createSign(algorithm: string): Sign;
  export function createVerify(algorithm: string): Verify;
  export function createSecretKey(key: ArrayBufferView | ArrayBufferLike): KeyObject;
  export function createSecretKey(key: string, encoding: BufferEncoding): KeyObject;
  export function generateKeySync(type: "hmac" | "aes", options: { length: number }): KeyObject;
  export function generateKey(
    type: "hmac" | "aes",
    options: { length: number },
    callback: (err: Error | null, key: KeyObject) => void,
  ): void;
  export interface RandomUUIDOptions {
    disableEntropyCache?: boolean | undefined;
  }
  export function randomUUID(options?: RandomUUIDOptions): string;
  export function randomUUIDv7(options?: RandomUUIDOptions): string;
  export function randomBytes(size: number): Buffer;
  export type BinaryToTextEncoding = "base64" | "base64url" | "hex" | "binary";
  export type CharacterEncoding = "utf8" | "utf-8" | "utf16le" | "utf-16le" | "latin1";
  export type LegacyCharacterEncoding = "ascii" | "binary" | "ucs2" | "ucs-2";
  export type Encoding = BinaryToTextEncoding | CharacterEncoding | LegacyCharacterEncoding;
  export interface HashOptions {
    outputLength?: number | undefined;
  }
  /* Hash and Hmac are Transforms: written chunks update the digest, which
   * the readable side delivers once the writable side ends. */
  export interface Hash extends Transform {
    copy(options?: HashOptions): Hash;
    update(data: string | ArrayBufferView): Hash;
    update(data: string, inputEncoding: Encoding): Hash;
    digest(): Buffer;
    digest(encoding: BinaryToTextEncoding): string;
  }
  export interface Hmac extends Transform {
    update(data: string | ArrayBufferView): Hmac;
    update(data: string, inputEncoding: Encoding): Hmac;
    digest(): Buffer;
    digest(encoding: BinaryToTextEncoding): string;
  }
  export function createHash(algorithm: string, options?: HashOptions): Hash;
  export function createHmac(
    algorithm: string,
    key: BinaryLike | KeyObject,
    options?: { encoding?: BufferEncoding | undefined },
  ): Hmac;
  export interface OneShotDigestOptions {
    outputEncoding?: BinaryToTextEncoding | "buffer" | undefined;
    outputLength?: number | undefined;
  }
  export interface OneShotDigestOptionsWithStringEncoding extends OneShotDigestOptions {
    outputEncoding?: BinaryToTextEncoding | undefined;
  }
  export interface OneShotDigestOptionsWithBufferEncoding extends OneShotDigestOptions {
    outputEncoding: "buffer";
  }
  export function hash(
    algorithm: string,
    data: string | ArrayBufferView,
    options?: OneShotDigestOptionsWithStringEncoding | BinaryToTextEncoding,
  ): string;
  export function hash(
    algorithm: string,
    data: string | ArrayBufferView,
    options: OneShotDigestOptionsWithBufferEncoding | "buffer",
  ): Buffer;
  export function hash(
    algorithm: string,
    data: string | ArrayBufferView,
    options: OneShotDigestOptions | BinaryToTextEncoding | "buffer",
  ): string | Buffer;
  export function timingSafeEqual(
    a: ArrayBufferView | ArrayBufferLike,
    b: ArrayBufferView | ArrayBufferLike,
  ): boolean;
  /* WebCrypto's getRandomValues (also the webcrypto object's): integer
   * typed arrays, filled in place and returned. */
  type RandomValuesArray =
    | Int8Array
    | Uint8Array
    | Uint8ClampedArray
    | Int16Array
    | Uint16Array
    | Int32Array
    | Uint32Array
    | BigInt64Array
    | BigUint64Array;
  export function getRandomValues<T extends RandomValuesArray>(typedArray: T): T;
  /* The WebCrypto global's object and its SubtleCrypto. */
  export const webcrypto: Crypto;
  export const subtle: SubtleCrypto;
  export function randomFillSync<T extends ArrayBufferView | ArrayBufferLike>(
    buffer: T,
    offset?: number,
    size?: number,
  ): T;
  export function randomFill<T extends ArrayBufferView | ArrayBufferLike>(
    buffer: T,
    callback: (err: Error | null, buf: T) => void,
  ): void;
  export function randomFill<T extends ArrayBufferView | ArrayBufferLike>(
    buffer: T,
    offset: number,
    callback: (err: Error | null, buf: T) => void,
  ): void;
  export function randomFill<T extends ArrayBufferView | ArrayBufferLike>(
    buffer: T,
    offset: number,
    size: number,
    callback: (err: Error | null, buf: T) => void,
  ): void;
  export function randomInt(max: number): number;
  export function randomInt(min: number, max: number): number;
  export function randomInt(
    max: number,
    callback: (err: Error | null, value: number) => void,
  ): void;
  export function randomInt(
    min: number,
    max: number,
    callback: (err: Error | null, value: number) => void,
  ): void;
  export function pbkdf2Sync(
    password: string | Uint8Array,
    salt: string | Uint8Array,
    iterations: number,
    keylen: number,
    digest: string,
  ): Buffer;
  export function pbkdf2(
    password: string | Uint8Array,
    salt: string | Uint8Array,
    iterations: number,
    keylen: number,
    digest: string,
    callback: (error: Error | null, derivedKey: Buffer) => void,
  ): void;
  export function randomBytes(
    size: number,
    callback: (error: Error | null, buffer: Buffer) => void,
  ): void;
  export type BinaryLike = string | ArrayBuffer | ArrayBufferView;
  /* Cipheriv/Decipheriv: aes-128/192/256 in cbc, ctr, gcm, ccm, ecb, cfb,
   * cfb8, cfb1, and ofb modes and their key wraps, des-ede3 and des-ede,
   * chacha20, and chacha20-poly1305. Both are Transforms: written chunks go
   * through update(), and the end pushes final(). */
  export type CipherCCMTypes = "aes-128-ccm" | "aes-192-ccm" | "aes-256-ccm";
  export type CipherGCMTypes = "aes-128-gcm" | "aes-192-gcm" | "aes-256-gcm";
  export type CipherChaCha20Poly1305Types = "chacha20-poly1305";
  export type CipherKey = BinaryLike | KeyObject;
  export interface CipherCCMOptions {
    authTagLength: number;
  }
  export interface CipherGCMOptions {
    authTagLength?: number;
  }
  export interface CipherChaCha20Poly1305Options {
    authTagLength?: number;
  }
  export interface Cipheriv extends Transform {
    update(data: string | ArrayBufferView): Buffer;
    update(data: string, inputEncoding: BufferEncoding): Buffer;
    update(data: ArrayBufferView, inputEncoding: undefined, outputEncoding: BufferEncoding): string;
    update(
      data: string,
      inputEncoding: BufferEncoding | undefined,
      outputEncoding: BufferEncoding,
    ): string;
    final(): Buffer;
    final(outputEncoding: BufferEncoding): string;
    setAutoPadding(autoPadding?: boolean): this;
  }
  export interface CipherCCM extends Cipheriv {
    setAAD(buffer: ArrayBufferView, options: { plaintextLength: number }): this;
    getAuthTag(): Buffer;
  }
  export interface CipherGCM extends Cipheriv {
    setAAD(buffer: ArrayBufferView, options?: { plaintextLength: number }): this;
    getAuthTag(): Buffer;
  }
  export interface CipherChaCha20Poly1305 extends Cipheriv {
    setAAD(buffer: ArrayBufferView, options?: { plaintextLength: number }): this;
    getAuthTag(): Buffer;
  }
  export interface Decipheriv extends Transform {
    update(data: ArrayBufferView): Buffer;
    update(data: string, inputEncoding: BufferEncoding): Buffer;
    update(data: ArrayBufferView, inputEncoding: undefined, outputEncoding: BufferEncoding): string;
    update(
      data: string,
      inputEncoding: BufferEncoding | undefined,
      outputEncoding: BufferEncoding,
    ): string;
    final(): Buffer;
    final(outputEncoding: BufferEncoding): string;
    setAutoPadding(autoPadding?: boolean): this;
  }
  export interface DecipherCCM extends Decipheriv {
    setAuthTag(buffer: ArrayBufferView): this;
    setAAD(buffer: ArrayBufferView, options: { plaintextLength: number }): this;
  }
  export interface DecipherGCM extends Decipheriv {
    setAuthTag(buffer: ArrayBufferView): this;
    setAAD(buffer: ArrayBufferView, options?: { plaintextLength: number }): this;
  }
  export interface DecipherChaCha20Poly1305 extends Decipheriv {
    setAuthTag(buffer: ArrayBufferView): this;
    setAAD(buffer: ArrayBufferView, options?: { plaintextLength: number }): this;
  }
  export function createCipheriv(
    algorithm: CipherCCMTypes,
    key: CipherKey,
    iv: BinaryLike,
    options: CipherCCMOptions,
  ): CipherCCM;
  export function createCipheriv(
    algorithm: CipherGCMTypes,
    key: CipherKey,
    iv: BinaryLike,
    options?: CipherGCMOptions,
  ): CipherGCM;
  export function createCipheriv(
    algorithm: CipherChaCha20Poly1305Types,
    key: CipherKey,
    iv: BinaryLike,
    options?: CipherChaCha20Poly1305Options,
  ): CipherChaCha20Poly1305;
  export function createCipheriv(
    algorithm: string,
    key: CipherKey,
    iv: BinaryLike | null,
    options?: { authTagLength?: number },
  ): Cipheriv;
  export function createDecipheriv(
    algorithm: CipherCCMTypes,
    key: CipherKey,
    iv: BinaryLike,
    options: CipherCCMOptions,
  ): DecipherCCM;
  export function createDecipheriv(
    algorithm: CipherGCMTypes,
    key: CipherKey,
    iv: BinaryLike,
    options?: CipherGCMOptions,
  ): DecipherGCM;
  export function createDecipheriv(
    algorithm: CipherChaCha20Poly1305Types,
    key: CipherKey,
    iv: BinaryLike,
    options?: CipherChaCha20Poly1305Options,
  ): DecipherChaCha20Poly1305;
  export function createDecipheriv(
    algorithm: string,
    key: CipherKey,
    iv: BinaryLike | null,
    options?: { authTagLength?: number },
  ): Decipheriv;
  export type ECDHKeyFormat = "compressed" | "uncompressed" | "hybrid";
  export class ECDH {
    private constructor();
    static convertKey(
      key: BinaryLike,
      curve: string,
      inputEncoding?: BinaryToTextEncoding,
      outputEncoding?: "latin1" | "hex" | "base64" | "base64url",
      format?: ECDHKeyFormat,
    ): Buffer | string;
    generateKeys(): Buffer;
    generateKeys(encoding: BinaryToTextEncoding, format?: ECDHKeyFormat): string;
    computeSecret(otherPublicKey: ArrayBufferView): Buffer;
    computeSecret(otherPublicKey: string, inputEncoding: BinaryToTextEncoding): Buffer;
    computeSecret(otherPublicKey: ArrayBufferView, outputEncoding: BinaryToTextEncoding): string;
    computeSecret(
      otherPublicKey: string,
      inputEncoding: BinaryToTextEncoding,
      outputEncoding: BinaryToTextEncoding,
    ): string;
    getPrivateKey(): Buffer;
    getPrivateKey(encoding: BinaryToTextEncoding): string;
    getPublicKey(encoding?: null, format?: ECDHKeyFormat): Buffer;
    getPublicKey(encoding: BinaryToTextEncoding, format?: ECDHKeyFormat): string;
    setPrivateKey(privateKey: ArrayBufferView): void;
    setPrivateKey(privateKey: string, encoding: BinaryToTextEncoding): void;
  }
  export function createECDH(curveName: string): ECDH;
  export class DiffieHellman {
    private constructor();
    generateKeys(): Buffer;
    generateKeys(encoding: BinaryToTextEncoding): string;
    computeSecret(
      otherPublicKey: ArrayBufferView,
      inputEncoding?: null,
      outputEncoding?: null,
    ): Buffer;
    computeSecret(
      otherPublicKey: string,
      inputEncoding: BinaryToTextEncoding,
      outputEncoding?: null,
    ): Buffer;
    computeSecret(
      otherPublicKey: ArrayBufferView,
      inputEncoding: null,
      outputEncoding: BinaryToTextEncoding,
    ): string;
    computeSecret(
      otherPublicKey: string,
      inputEncoding: BinaryToTextEncoding,
      outputEncoding: BinaryToTextEncoding,
    ): string;
    getPrime(): Buffer;
    getPrime(encoding: BinaryToTextEncoding): string;
    getGenerator(): Buffer;
    getGenerator(encoding: BinaryToTextEncoding): string;
    getPublicKey(): Buffer;
    getPublicKey(encoding: BinaryToTextEncoding): string;
    getPrivateKey(): Buffer;
    getPrivateKey(encoding: BinaryToTextEncoding): string;
    setPublicKey(publicKey: ArrayBufferView): void;
    setPublicKey(publicKey: string, encoding: BufferEncoding): void;
    setPrivateKey(privateKey: ArrayBufferView): void;
    setPrivateKey(privateKey: string, encoding: BufferEncoding): void;
    verifyError: number;
  }
  export type DiffieHellmanGroup = Omit<DiffieHellman, "setPublicKey" | "setPrivateKey">;
  export function createDiffieHellman(primeLength: number, generator?: number): DiffieHellman;
  export function createDiffieHellman(
    prime: ArrayBuffer | ArrayBufferView,
    generator?: number | ArrayBuffer | ArrayBufferView,
  ): DiffieHellman;
  export function createDiffieHellman(
    prime: ArrayBuffer | ArrayBufferView,
    generator: string,
    generatorEncoding: BinaryToTextEncoding,
  ): DiffieHellman;
  export function createDiffieHellman(
    prime: string,
    primeEncoding: BinaryToTextEncoding,
    generator?: number | ArrayBuffer | ArrayBufferView,
  ): DiffieHellman;
  export function createDiffieHellman(
    prime: string,
    primeEncoding: BinaryToTextEncoding,
    generator: string,
    generatorEncoding: BinaryToTextEncoding,
  ): DiffieHellman;
  export function getDiffieHellman(groupName: string): DiffieHellmanGroup;
  export function createDiffieHellmanGroup(name: string): DiffieHellmanGroup;
  export type LargeNumberLike = ArrayBufferView | SharedArrayBuffer | ArrayBuffer | bigint;
  export interface GeneratePrimeOptions {
    add?: LargeNumberLike | undefined;
    rem?: LargeNumberLike | undefined;
    safe?: boolean | undefined;
    bigint?: boolean | undefined;
  }
  export interface GeneratePrimeOptionsBigInt extends GeneratePrimeOptions {
    bigint: true;
  }
  export interface GeneratePrimeOptionsArrayBuffer extends GeneratePrimeOptions {
    bigint?: false | undefined;
  }
  export function generatePrime(
    size: number,
    callback: (err: Error | null, prime: ArrayBuffer) => void,
  ): void;
  export function generatePrime(
    size: number,
    options: GeneratePrimeOptionsBigInt,
    callback: (err: Error | null, prime: bigint) => void,
  ): void;
  export function generatePrime(
    size: number,
    options: GeneratePrimeOptionsArrayBuffer,
    callback: (err: Error | null, prime: ArrayBuffer) => void,
  ): void;
  export function generatePrime(
    size: number,
    options: GeneratePrimeOptions,
    callback: (err: Error | null, prime: ArrayBuffer | bigint) => void,
  ): void;
  export function generatePrimeSync(size: number): ArrayBuffer;
  export function generatePrimeSync(size: number, options: GeneratePrimeOptionsBigInt): bigint;
  export function generatePrimeSync(
    size: number,
    options: GeneratePrimeOptionsArrayBuffer,
  ): ArrayBuffer;
  export function generatePrimeSync(
    size: number,
    options: GeneratePrimeOptions,
  ): ArrayBuffer | bigint;
  export interface CheckPrimeOptions {
    checks?: number | undefined;
  }
  export function checkPrime(
    value: LargeNumberLike,
    callback: (err: Error | null, result: boolean) => void,
  ): void;
  export function checkPrime(
    value: LargeNumberLike,
    options: CheckPrimeOptions,
    callback: (err: Error | null, result: boolean) => void,
  ): void;
  export function checkPrimeSync(candidate: LargeNumberLike, options?: CheckPrimeOptions): boolean;
  export interface ScryptOptions {
    N?: number;
    r?: number;
    p?: number;
    cost?: number;
    blockSize?: number;
    parallelization?: number;
    maxmem?: number;
  }
  export function scryptSync(
    password: BinaryLike,
    salt: BinaryLike,
    keylen: number,
    options?: ScryptOptions,
  ): Buffer;
  export function scrypt(
    password: BinaryLike,
    salt: BinaryLike,
    keylen: number,
    callback: (error: Error | null, derivedKey: Buffer) => void,
  ): void;
  export function scrypt(
    password: BinaryLike,
    salt: BinaryLike,
    keylen: number,
    options: ScryptOptions,
    callback: (error: Error | null, derivedKey: Buffer) => void,
  ): void;
  export function hkdfSync(
    digest: string,
    ikm: BinaryLike | KeyObject,
    salt: BinaryLike,
    info: BinaryLike,
    keylen: number,
  ): ArrayBuffer;
  export function hkdf(
    digest: string,
    ikm: BinaryLike | KeyObject,
    salt: BinaryLike,
    info: BinaryLike,
    keylen: number,
    callback: (error: Error | null, derivedKey: ArrayBuffer) => void,
  ): void;
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
  export type CipherMode =
    | "cbc"
    | "ccm"
    | "cfb"
    | "ctr"
    | "ecb"
    | "gcm"
    | "ocb"
    | "ofb"
    | "stream"
    | "wrap"
    | "xts";
  export interface CipherInfoOptions {
    keyLength?: number | undefined;
    ivLength?: number | undefined;
  }
  export interface CipherInfo {
    name: string;
    nid: number;
    blockSize?: number | undefined;
    ivLength?: number | undefined;
    keyLength: number;
    mode: CipherMode;
  }
  export function getCipherInfo(
    nameOrNid: string | number,
    options?: CipherInfoOptions,
  ): CipherInfo | undefined;
  export function getHashes(): string[];
  export function getCurves(): string[];
  /* Node v24 crypto.constants, literal-typed (the Http2Constants
   * stance). Every ACCESS bakes as its literal at lowering; the object
   * itself never materializes (bare crypto.constants value uses fence). */
  export interface CryptoConstants {
    readonly OPENSSL_VERSION_NUMBER: 810549376;
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
    readonly RSA_SSLV23_PADDING: 2;
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
   * read "" for non-piped streams), env (replaces the child's
   * environment), and windowsHide (a POSIX no-op). */
  export function spawnSync(
    command: string,
    args?: string[],
    options?: {
      encoding?: "utf8" | "utf-8";
      timeout?: number;
      killSignal?: string;
      stdio?: "pipe" | "ignore" | "inherit" | ("pipe" | "ignore" | "inherit")[];
      env?: { [k: string]: string | undefined };
      windowsHide?: boolean;
    },
  ): SpawnSyncReturns;

  /* The asynchronous slice: spawn with stdio "ignore"/"inherit"/fd/"pipe"
   * tuples (piped stdin is writable through child.stdin; piped stdout/stderr
   * deliver through child.stdout/stderr) and the terminal events. "exit"
   * fires once with the exit code, or
   * null when the child died to a signal; "error" fires ONLY when the
   * child could not be spawned at all (Node's split: a spawn failure
   * emits "error" and never "exit"). "close" fires after exit/error and
   * every piped stdio handle reaches EOF. Exit/close listeners may take
   * Node's code and signal parameters. `on`/`once` return void here (Node
   * returns the child; chaining is fenced). The event loop keeps the process
   * alive until every spawned child is reaped, like Node — reaping polls at
   * loop quiescence (SEMANTICS.md documents the divergence). An "error"
   * event with no registered listener prints the error and exits 1,
   * exactly the unhandled-'error' EventEmitter behavior. */
  export interface ChildStdin {
    readonly writable: boolean;
    write(chunk: string | Uint8Array): boolean;
    end(): void;
    destroy(): void;
    on(event: "drain" | "finish", listener: () => void): void;
    on(event: "error", listener: (err: Error) => void): void;
    on(event: string, listener: (...args: any[]) => void): void;
    once(event: "drain" | "finish", listener: () => void): void;
    once(event: "error", listener: (err: Error) => void): void;
    once(event: string, listener: (...args: any[]) => void): void;
  }

  export interface ChildProcess extends Disposable {
    ref(): void;
    on(event: "spawn", listener: () => void): this;
    once(event: "spawn", listener: () => void): this;
    /* The exit listener may also take Node's second parameter — the
     * terminating signal's name, null for a normal exit. */
    on(event: "exit", listener: (code: number | null, signal: string | null) => void): this;
    on(event: "close", listener: (code: number | null, signal: string | null) => void): this;
    on(event: "error", listener: (err: Error) => void): this;
    once(event: "exit", listener: (code: number | null, signal: string | null) => void): this;
    once(event: "close", listener: (code: number | null, signal: string | null) => void): this;
    once(event: "error", listener: (err: Error) => void): this;
    on(event: "message", listener: (message: any) => void): this;
    on(event: "disconnect", listener: () => void): this;
    once(event: "message", listener: (message: any) => void): this;
    once(event: "disconnect", listener: () => void): this;
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
    readonly connected: boolean;
    send(message: object, callback?: (error: Error | null) => void): boolean;
    disconnect(): void;
    [Symbol.dispose](): void;
    /* The piped streams — non-null exactly when the matching stdio slot
     * was "pipe" (Node's shape). */
    readonly stdin: ChildStdin | null;
    readonly stdout: NodeJS.ReadableStream | null;
    readonly stderr: NodeJS.ReadableStream | null;
  }
  export interface SpawnOptions {
    /* The 3-tuple form admits number fds in the stdout/stderr slots —
     * openSync results dup2'd into the child (the daemon-log idiom
     * ["ignore", logFd, logFd]) — and "pipe" there too (child.stdout/
     * child.stderr streams); "pipe" in the stdin slot exposes
     * child.stdin. */
    stdio?: "ignore" | "inherit" | "pipe" | ("ignore" | "inherit" | "pipe" | number)[];
    /* detached gives the child its own session and process group
     * (POSIX_SPAWN_SETSID); env REPLACES the child environment; cwd
     * sets its working directory; windowsHide is a POSIX no-op; shell
     * runs the complete command string through /bin/sh or cmd.exe. */
    detached?: boolean;
    env?: { [k: string]: string | undefined };
    cwd?: string;
    windowsHide?: boolean;
    shell?: boolean;
  }
  export function spawn(command: string, args?: string[], options?: SpawnOptions): ChildProcess;
  export function spawn(command: string, options?: SpawnOptions): ChildProcess;

  export function fork(
    modulePath: string | URL,
    args?: string[],
    options?: {
      cwd?: string;
      env?: { [k: string]: string | undefined };
      execArgv?: string[];
      silent?: boolean;
      stdio?: "pipe" | "ignore" | "inherit" | ("pipe" | "ignore" | "inherit" | "ipc")[];
      serialization?: "json" | "advanced";
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
  export type ExecFileCallback = (error: Error | null, stdout: string, stderr: string) => void;
  /* The callback form starts an asynchronous child and captures utf8
   * stdout/stderr. The no-callback overload remains for util.promisify's
   * static target recognition; reached no-callback calls still fence. */
  export function execFile(file: string, callback: ExecFileCallback): ChildProcess;
  export function execFile(
    file: string,
    args: string[] | null,
    callback: ExecFileCallback,
  ): ChildProcess;
  export function execFile(
    file: string,
    args: string[] | null,
    options: ExecSyncOptions,
    callback: ExecFileCallback,
  ): ChildProcess;
  export function execFile(
    file: string,
    args?: string[] | null,
    options?: ExecSyncOptions,
  ): unknown;
  /* The async shell form. The callback forms lower like execFile's, with
   * the command line run by /bin/sh -c, and util.promisify recognizes it
   * statically, as it does execFile; reached calls without a callback
   * fence at their site. */
  export function exec(
    command: string,
    options?: ExecSyncOptions | ((error: Error | null, stdout: string, stderr: string) => void),
    callback?: (error: Error | null, stdout: string, stderr: string) => void,
  ): ChildProcess;
}
declare module "node:child_process" {
  export * from "child_process";
}

/* node:util — compile-time projections for child_process.execFile,
 * child_process.exec and fs.readFile. The first two retain Node's custom
 * { stdout, stderr } result; the last resolves the callback's data
 * argument. Other targets and bare
 * promisify values fence per site. */
declare module "util" {
  export * as types from "util/types";
  export function getSystemErrorName(err: number): string;
  export function getSystemErrorMessage(err: number): string;
  export function getSystemErrorMap(): Map<number, [string, string]>;
  export function stripVTControlCharacters(str: string): string;
  export function toUSVString(string: string): string;
  export function isDeepStrictEqual(val1: unknown, val2: unknown, skipPrototype?: boolean): boolean;
  export function styleText(
    format: string | readonly string[],
    text: string,
    options?: { validateStream?: boolean; stream?: unknown },
  ): string;
  export function parseEnv(content: string): { [key: string]: string | undefined };
  export function inherits(constructor: unknown, superConstructor: unknown): void;
  export interface DeprecateOptions {
    modifyPrototype?: boolean;
  }
  export function deprecate<T extends Function>(
    fn: T,
    msg: string,
    code?: string,
    options?: DeprecateOptions,
  ): T;
  /* The callback receives null on success and the rejection reason
   * otherwise (falsy reasons arrive as ERR_FALSY_VALUE_REJECTION). */
  export function callbackify(
    fn: () => Promise<void>,
  ): (callback: (err: NodeJS.ErrnoException | null) => void) => void;
  export function callbackify<TResult>(
    fn: () => Promise<TResult>,
  ): (callback: (err: NodeJS.ErrnoException | null, result: TResult) => void) => void;
  export function callbackify<T1>(
    fn: (arg1: T1) => Promise<void>,
  ): (arg1: T1, callback: (err: NodeJS.ErrnoException | null) => void) => void;
  export function callbackify<T1, TResult>(
    fn: (arg1: T1) => Promise<TResult>,
  ): (arg1: T1, callback: (err: NodeJS.ErrnoException | null, result: TResult) => void) => void;
  export function callbackify<T1, T2>(
    fn: (arg1: T1, arg2: T2) => Promise<void>,
  ): (arg1: T1, arg2: T2, callback: (err: NodeJS.ErrnoException | null) => void) => void;
  export function callbackify<T1, T2, TResult>(
    fn: (arg1: T1, arg2: T2) => Promise<TResult>,
  ): (
    arg1: T1,
    arg2: T2,
    callback: (err: NodeJS.ErrnoException | null, result: TResult) => void,
  ) => void;
  export function callbackify<T1, T2, T3>(
    fn: (arg1: T1, arg2: T2, arg3: T3) => Promise<void>,
  ): (arg1: T1, arg2: T2, arg3: T3, callback: (err: NodeJS.ErrnoException | null) => void) => void;
  export function callbackify<T1, T2, T3, TResult>(
    fn: (arg1: T1, arg2: T2, arg3: T3) => Promise<TResult>,
  ): (
    arg1: T1,
    arg2: T2,
    arg3: T3,
    callback: (err: NodeJS.ErrnoException | null, result: TResult) => void,
  ) => void;
  export type DebugLoggerFunction = (msg: string, ...param: unknown[]) => void;
  export interface DebugLogger extends DebugLoggerFunction {
    enabled: boolean;
  }
  export function debuglog(
    section: string,
    callback?: (fn: DebugLoggerFunction) => void,
  ): DebugLogger;
  export { debuglog as debug };
  export type TextEncoder = globalThis.TextEncoder;
  export type TextDecoder = globalThis.TextDecoder;
  export var TextEncoder: typeof globalThis.TextEncoder;
  export var TextDecoder: typeof globalThis.TextDecoder;
  /* stream.pipeline's overload comes first: its __promisify__ member keeps
   * every other target out of it. */
  export function promisify(
    fn: typeof import("node:stream").pipeline,
  ): typeof import("node:stream/promises").pipeline;
  export function promisify(
    fn: typeof import("node:fs").readFile,
  ): (path: string, encoding: "utf8" | "utf-8") => Promise<string>;
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
  export function promisify(
    fn: typeof globalThis.setTimeout,
  ): typeof import("node:timers/promises").setTimeout;
  export function promisify(
    fn: typeof globalThis.setImmediate,
  ): typeof import("node:timers/promises").setImmediate;
  export function promisify(fn: typeof import("node:child_process").exec): (
    command: string,
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
  /* The zlib callback one-shots (deflate, inflate, deflateRaw, inflateRaw,
   * gzip, gunzip, unzip) share one type. */
  export function promisify(
    fn: typeof import("node:zlib").gzip,
  ): (data: string | Uint8Array, options?: import("node:zlib").ZlibOptions) => Promise<Buffer>;
  export function promisify(
    fn: typeof import("node:stream").finished,
  ): typeof import("node:stream/promises").finished;
  /* The crypto callback functions: the promise settles with the callback's
   * value. */
  export function promisify(
    fn: typeof import("node:crypto").randomBytes,
  ): (size: number) => Promise<Buffer>;
  export function promisify(
    fn: typeof import("node:crypto").pbkdf2,
  ): (
    password: string | Uint8Array,
    salt: string | Uint8Array,
    iterations: number,
    keylen: number,
    digest: string,
  ) => Promise<Buffer>;
  export function promisify(
    fn: typeof import("node:crypto").scrypt,
  ): (
    password: import("node:crypto").BinaryLike,
    salt: import("node:crypto").BinaryLike,
    keylen: number,
    options?: import("node:crypto").ScryptOptions,
  ) => Promise<Buffer>;
  export function promisify(
    fn: typeof import("node:crypto").hkdf,
  ): (
    digest: string,
    ikm: import("node:crypto").BinaryLike | import("node:crypto").KeyObject,
    salt: import("node:crypto").BinaryLike,
    info: import("node:crypto").BinaryLike,
    keylen: number,
  ) => Promise<ArrayBuffer>;
  /* A callback-only function (`obj.close.bind(obj)`): before the targets
   * whose leading parameters would otherwise capture it. Builtins that take
   * arguments before their callback never match these. */
  export function promisify<TResult>(
    fn: (callback: (err: any, result: TResult) => void) => void,
  ): () => Promise<TResult>;
  export function promisify(fn: (callback: (err?: any) => void) => void): () => Promise<void>;
  export function promisify(
    fn: typeof import("node:crypto").randomFill,
  ): <T extends ArrayBufferView | ArrayBufferLike>(
    buffer: T,
    offset?: number,
    size?: number,
  ) => Promise<T>;
  export function promisify(fn: typeof import("node:crypto").randomInt): {
    (max: number): Promise<number>;
    (min: number, max: number): Promise<number>;
  };
  export function promisify(
    fn: typeof import("node:crypto").generateKey,
  ): (
    type: "hmac" | "aes",
    options: { length: number },
  ) => Promise<import("node:crypto").KeyObject>;
  /* dns.lookup's promise settles with { address, family } (the address
   * array with options.all), and lookupService's with { hostname, service }. */
  export function promisify(fn: typeof import("node:dns").lookup): {
    (
      hostname: string,
      options: import("node:dns").LookupAllOptions,
    ): Promise<import("node:dns").LookupAddress[]>;
    (
      hostname: string,
      options?: number | import("node:dns").LookupOneOptions,
    ): Promise<import("node:dns").LookupAddress>;
  };
  export function promisify(
    fn: typeof import("node:dns").lookupService,
  ): (address: string, port: number) => Promise<{ hostname: string; service: string }>;
  /* Error-first callback functions in general: lowered for Node island
   * functions (Node's own promisify runs in the island); other targets
   * fence at the call. Only functions that return nothing: a builtin that
   * returns a handle (execFile's ChildProcess) keeps its overload above,
   * which the subtype pass would otherwise skip for these. */
  export function promisify<T1, TResult, F>(
    fn: F &
      ((arg1: T1, callback: (err: any, result: TResult) => void) => void) &
      (F extends (...args: any[]) => infer R ? (R extends void ? unknown : never) : never),
  ): (arg1: T1) => Promise<TResult>;
  export function promisify<T1, T2, TResult, F>(
    fn: F &
      ((arg1: T1, arg2: T2, callback: (err: any, result: TResult) => void) => void) &
      (F extends (...args: any[]) => infer R ? (R extends void ? unknown : never) : never),
  ): (arg1: T1, arg2: T2) => Promise<TResult>;
  export function promisify<T1, T2, T3, TResult, F>(
    fn: F &
      ((arg1: T1, arg2: T2, arg3: T3, callback: (err: any, result: TResult) => void) => void) &
      (F extends (...args: any[]) => infer R ? (R extends void ? unknown : never) : never),
  ): (arg1: T1, arg2: T2, arg3: T3) => Promise<TResult>;
  /* Declared surface without full lowering (the type-level tolerance
   * story: guarded/diagnostic-path code must TYPECHECK; a reached use
   * without a lowering fences at its site). inspect's options carry the
   * documented knobs through an index signature. */
  export function inspect(
    object: unknown,
    options?: { depth?: number | null; colors?: boolean; [k: string]: unknown },
  ): string;
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

/* node:util/types — native runtime brands. Other forms retain their
 * per-member lowering boundaries. */
declare module "util/types" {
  export function isAnyArrayBuffer(value: unknown): boolean;
  export function isArrayBuffer(value: unknown): value is ArrayBuffer;
  export function isArrayBufferView(value: unknown): value is ArrayBufferView;
  export function isDataView(value: unknown): value is DataView;
  export function isTypedArray(value: unknown): boolean;
  export function isUint8Array(value: unknown): value is Uint8Array;
  export function isUint8ClampedArray(value: unknown): value is Uint8ClampedArray;
  export function isUint16Array(value: unknown): value is Uint16Array;
  export function isUint32Array(value: unknown): value is Uint32Array;
  export function isInt8Array(value: unknown): value is Int8Array;
  export function isInt16Array(value: unknown): value is Int16Array;
  export function isInt32Array(value: unknown): value is Int32Array;
  export function isFloat16Array(value: unknown): value is Float16Array;
  export function isFloat32Array(value: unknown): value is Float32Array;
  export function isFloat64Array(value: unknown): value is Float64Array;
  export function isMap(value: unknown): value is Map<unknown, unknown>;
  export function isSet(value: unknown): value is Set<unknown>;
  export function isWeakMap(value: unknown): value is WeakMap<object, unknown>;
  export function isWeakSet(value: unknown): value is WeakSet<object>;
  export function isRegExp(value: unknown): value is RegExp;
  export function isNativeError(value: unknown): value is Error;
  export function isPromise(value: unknown): value is Promise<unknown>;
  export function isProxy(value: unknown): boolean;
  export function isAsyncFunction(value: unknown): boolean;
  export function isGeneratorFunction(value: unknown): boolean;
  export function isGeneratorObject(value: unknown): boolean;
  export function isModuleNamespaceObject(value: unknown): boolean;
  export function isDate(value: unknown): value is Date;
  export function isSharedArrayBuffer(value: unknown): value is SharedArrayBuffer;
  export function isMapIterator(value: unknown): boolean;
  export function isSetIterator(value: unknown): boolean;
  export function isKeyObject(value: unknown): boolean;
  export function isNumberObject(value: unknown): boolean;
  export function isStringObject(value: unknown): boolean;
  export function isBooleanObject(value: unknown): boolean;
  export function isBigIntObject(value: unknown): boolean;
  export function isSymbolObject(value: unknown): boolean;
  export function isBoxedPrimitive(value: unknown): boolean;
  export function isBigInt64Array(value: unknown): value is BigInt64Array;
  export function isBigUint64Array(value: unknown): value is BigUint64Array;
  export function isCryptoKey(value: unknown): boolean;
  export function isExternal(value: unknown): boolean;
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
 * shallow legacy pair (equal/notEqual) follows Node's == coercions for
 * primitive and primitive-union operands, including Node v24's NaN
 * exception. deepEqual/notDeepEqual remain declared-but-fenced;
 * assert/strict's loose names alias the strict forms and lower. */
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
  type SuiteFn = (s: SuiteContext) => void;
  type HookFn = (c: TestContext | SuiteContext) => void | Promise<void>;
  /* The describe/suite callback's context, and the before/after hook
   * context of a suite. */
  interface SuiteContext {
    readonly name: string;
    readonly fullName: string;
    readonly filePath: string | undefined;
    readonly attempt: number;
    readonly passed: boolean;
    diagnostic(message: string): void;
  }
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
    readonly fullName: string;
    readonly filePath: string | undefined;
    readonly attempt: number;
    readonly passed: boolean;
    readonly workerId: number | undefined;
    readonly tags: readonly string[];
    readonly assert: TestContextAssert;
    readonly mock: MockTracker;
    test(name?: string, fn?: TestFn): Promise<void>;
    test(name?: string, options?: TestOptions, fn?: TestFn): Promise<void>;
    test(options?: TestOptions, fn?: TestFn): Promise<void>;
    test(fn?: TestFn): Promise<void>;
    skip(message?: string): void;
    todo(message?: string): void;
    diagnostic(message: string): void;
    plan(count: number): void;
    after(fn: HookFn): void;
    before(fn: HookFn): void;
    beforeEach(fn: HookFn): void;
    afterEach(fn: HookFn): void;
  }
  interface AssertSnapshotOptions {
    readonly serializers?: ReadonlyArray<(value: any) => any> | undefined;
  }
  interface TestContextAssert {
    snapshot(value: any, options?: AssertSnapshotOptions): void;
    fileSnapshot(value: any, path: string, options?: AssertSnapshotOptions): void;
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
  /* The name, options and function are each optional, as in Node: a test
   * without a name takes the function's name, or "<anonymous>". */
  function test(name?: string, fn?: TestFn): Promise<void>;
  function test(name?: string, options?: TestOptions, fn?: TestFn): Promise<void>;
  function test(options?: TestOptions, fn?: TestFn): Promise<void>;
  function test(fn?: TestFn): Promise<void>;
  namespace test {
    function skip(name?: string, fn?: TestFn): Promise<void>;
    function skip(name?: string, options?: TestOptions, fn?: TestFn): Promise<void>;
    function skip(options?: TestOptions, fn?: TestFn): Promise<void>;
    function skip(fn?: TestFn): Promise<void>;
    function todo(name?: string, fn?: TestFn): Promise<void>;
    function todo(name?: string, options?: TestOptions, fn?: TestFn): Promise<void>;
    function todo(options?: TestOptions, fn?: TestFn): Promise<void>;
    function todo(fn?: TestFn): Promise<void>;
    function only(name?: string, fn?: TestFn): Promise<void>;
    function only(name?: string, options?: TestOptions, fn?: TestFn): Promise<void>;
    function only(options?: TestOptions, fn?: TestFn): Promise<void>;
    function only(fn?: TestFn): Promise<void>;
  }
  const it: typeof test;
  function describe(name?: string, fn?: SuiteFn): void;
  function describe(name?: string, options?: TestOptions, fn?: SuiteFn): void;
  function describe(options?: TestOptions, fn?: SuiteFn): void;
  function describe(fn?: SuiteFn): void;
  namespace describe {
    function skip(name?: string, fn?: SuiteFn): void;
    function skip(name?: string, options?: TestOptions, fn?: SuiteFn): void;
    function skip(options?: TestOptions, fn?: SuiteFn): void;
    function skip(fn?: SuiteFn): void;
    function todo(name?: string, fn?: SuiteFn): void;
    function todo(name?: string, options?: TestOptions, fn?: SuiteFn): void;
    function todo(options?: TestOptions, fn?: SuiteFn): void;
    function todo(fn?: SuiteFn): void;
    function only(name?: string, fn?: SuiteFn): void;
    function only(name?: string, options?: TestOptions, fn?: SuiteFn): void;
    function only(options?: TestOptions, fn?: SuiteFn): void;
    function only(fn?: SuiteFn): void;
  }
  const suite: typeof describe;
  function before(fn: HookFn): void;
  function after(fn: HookFn): void;
  function beforeEach(fn: HookFn): void;
  function afterEach(fn: HookFn): void;
  /* The mock function surface: mock.fn, mock.method and their t.mock
   * twins, the tracker's restoreAll and reset, and the calls log and the
   * implementation controls on fn.mock. */
  interface MockFunctionCall<
    F extends Function,
    ReturnType = F extends (...args: any) => infer T ? T : unknown,
    Args = F extends (...args: infer Y) => any ? Y : unknown[],
  > {
    arguments: Args;
    error: unknown | undefined;
    result: ReturnType | undefined;
    this: unknown;
  }
  interface MockFunctionContext<F extends Function> {
    readonly calls: MockFunctionCall<F>[];
    callCount(): number;
    mockImplementation(implementation: F): void;
    mockImplementationOnce(implementation: F, onCall?: number): void;
    resetCalls(): void;
    restore(): void;
  }
  type Mock<F extends Function> = F & { mock: MockFunctionContext<F> };
  interface MockFunctionOptions {
    times?: number;
  }
  type FunctionPropertyNames<T> = {
    [K in keyof T]: T[K] extends Function ? K : never;
  }[keyof T];
  interface MockTracker {
    fn<F extends Function = (...args: any[]) => undefined>(original?: F): Mock<F>;
    fn<F extends Function = (...args: any[]) => undefined, Implementation extends Function = F>(
      original?: F,
      implementation?: Implementation,
    ): Mock<F | Implementation>;
    method<MockedObject extends object, MethodName extends FunctionPropertyNames<MockedObject>>(
      object: MockedObject,
      methodName: MethodName,
      options?: MockFunctionOptions,
    ): MockedObject[MethodName] extends Function ? Mock<MockedObject[MethodName]> : never;
    method<
      MockedObject extends object,
      MethodName extends FunctionPropertyNames<MockedObject>,
      Implementation extends Function,
    >(
      object: MockedObject,
      methodName: MethodName,
      implementation: Implementation,
      options?: MockFunctionOptions,
    ): MockedObject[MethodName] extends Function
      ? Mock<MockedObject[MethodName] | Implementation>
      : never;
    reset(): void;
    restoreAll(): void;
    readonly timers: MockTimers;
  }
  interface MockTimersOptions {
    apis: ReadonlyArray<"setInterval" | "setTimeout" | "setImmediate" | "Date">;
    now?: number | Date | undefined;
  }
  interface MockTimers {
    enable(options?: MockTimersOptions): void;
    setTime(milliseconds?: number): void;
    reset(): void;
    tick(milliseconds?: number): void;
    runAll(): void;
    [Symbol.dispose](): void;
  }
  const mock: MockTracker;
  /* The context of the test, suite or hook running in the current async
   * context; undefined outside one. */
  function getTestContext(): TestContext | SuiteContext | undefined;
  /* Declared for typechecking only — every use fences (no lowering).
   * `assert` is the module-level custom-assertion registry (v24's
   * `const { assert } = require('node:test')`), not TestContext.assert. */
  const assert: { register(name: string, fn: (...args: unknown[]) => unknown): void };
  function run(options?: unknown): unknown;
  function snapshot(...args: unknown[]): unknown;
  export {
    test,
    it,
    describe,
    suite,
    before,
    after,
    beforeEach,
    afterEach,
    mock,
    assert,
    getTestContext,
    run,
    snapshot,
    TestContext,
    SuiteContext,
    TestOptions,
    Mock,
    MockFunctionContext,
    MockFunctionCall,
    MockTracker,
    MockTimers,
    MockTimersOptions,
  };
  export default test;
}

declare module "assert" {
  function assert(value: unknown, message?: string): void;
  namespace assert {
    interface AssertionErrorOptions {
      message?: string | undefined;
      actual?: unknown;
      expected?: unknown;
      operator?: string | undefined;
      stackStartFn?: Function | undefined;
      diff?: "simple" | "full" | undefined;
    }
    class AssertionError extends Error {
      constructor(options: AssertionErrorOptions);
      actual: unknown;
      expected: unknown;
      generatedMessage: boolean;
      code: "ERR_ASSERTION";
      operator: string;
    }
    function ok(value: unknown, message?: string): void;
    function strictEqual(actual: unknown, expected: unknown, message?: string): void;
    function notStrictEqual(actual: unknown, expected: unknown, message?: string): void;
    function deepStrictEqual(actual: unknown, expected: unknown, message?: string): void;
    function notDeepStrictEqual(actual: unknown, expected: unknown, message?: string): void;
    function partialDeepStrictEqual(actual: unknown, expected: unknown, message?: string): void;
    function equal(actual: unknown, expected: unknown, message?: string): void;
    function notEqual(actual: unknown, expected: unknown, message?: string): void;
    function deepEqual(actual: unknown, expected: unknown, message?: string): void;
    function notDeepEqual(actual: unknown, expected: unknown, message?: string): void;
    function fail(message?: string): never;
    function throws(fn: () => unknown, expected?: unknown, message?: string): void;
    function doesNotThrow(fn: () => unknown, expected?: unknown, message?: string): void;
    function rejects(
      fn: (() => Promise<unknown>) | Promise<unknown>,
      expected?: unknown,
      message?: string,
    ): Promise<void>;
    function doesNotReject(
      fn: (() => Promise<unknown>) | Promise<unknown>,
      expected?: unknown,
      message?: string,
    ): Promise<void>;
    function match(value: string, regExp: RegExp, message?: string): void;
    function doesNotMatch(value: string, regExp: RegExp, message?: string): void;
    function ifError(value: unknown): void;
    const strict: typeof import("assert/strict");
    interface AssertOptions {
      diff?: "simple" | "full" | undefined;
      strict?: boolean | undefined;
      skipPrototype?: boolean | undefined;
    }
    type AssertMethodNames =
      | "deepEqual"
      | "deepStrictEqual"
      | "doesNotMatch"
      | "doesNotReject"
      | "doesNotThrow"
      | "equal"
      | "fail"
      | "ifError"
      | "match"
      | "notDeepEqual"
      | "notDeepStrictEqual"
      | "notEqual"
      | "notStrictEqual"
      | "ok"
      | "partialDeepStrictEqual"
      | "rejects"
      | "strictEqual"
      | "throws";
    interface Assert extends Pick<typeof assert, AssertMethodNames> {}
    interface AssertStrict extends Pick<typeof strict, AssertMethodNames> {}
    const Assert: {
      new (options?: AssertOptions & { strict?: true | undefined }): AssertStrict;
      new (options: AssertOptions): Assert;
    };
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
    function partialDeepStrictEqual(actual: unknown, expected: unknown, message?: string): void;
    function fail(message?: string): never;
    function throws(fn: () => unknown, expected?: unknown, message?: string): void;
    function doesNotThrow(fn: () => unknown, expected?: unknown, message?: string): void;
    function rejects(
      fn: (() => Promise<unknown>) | Promise<unknown>,
      expected?: unknown,
      message?: string,
    ): Promise<void>;
    function doesNotReject(
      fn: (() => Promise<unknown>) | Promise<unknown>,
      expected?: unknown,
      message?: string,
    ): Promise<void>;
    function match(value: string, regExp: RegExp, message?: string): void;
    function doesNotMatch(value: string, regExp: RegExp, message?: string): void;
    function ifError(value: unknown): void;
    const strict: typeof import("assert/strict");
    type AssertOptions = import("assert").AssertOptions;
    type Assert = import("assert").Assert;
    type AssertStrict = import("assert").AssertStrict;
    const Assert: typeof import("assert").Assert;
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
      | bigint
      | ReadonlyArray<string | number | boolean | bigint>
      | null
      | undefined;
  }
  export function parse(
    str: string,
    sep?: string | null,
    eq?: string | null,
    options?: ParseOptions,
  ): ParsedUrlQuery;
  export function stringify(
    obj?: ParsedUrlQueryInput,
    sep?: string | null,
    eq?: string | null,
    options?: StringifyOptions,
  ): string;
  export const decode: typeof parse;
  export const encode: typeof stringify;
  export function escape(str: string): string;
  export function unescape(str: string): string;
}
declare module "node:querystring" {
  export * from "querystring";
}

/* node:punycode (deprecated, DEP0040) — punycode.js 2.1.0: decode and
 * toUnicode throw its RangeErrors on malformed input; ucs2 converts
 * between strings and UTF-16 code point arrays. */
declare module "punycode" {
  export function decode(string: string): string;
  export function encode(string: string): string;
  export function toUnicode(domain: string): string;
  export function toASCII(domain: string): string;
  export namespace ucs2 {
    function decode(string: string): number[];
    function encode(codePoints: readonly number[]): string;
  }
  export const version: string;
}
declare module "node:punycode" {
  export * from "punycode";
}

/* node:constants (deprecated, DEP0008) — one frozen object: os.constants'
 * dlopen, errno, priority and signals groups, fs.constants, and
 * crypto.constants. A platform's missing constant reads as undefined. */
declare module "constants" {
  const constants: { readonly [name: string]: number } & {
    readonly defaultCoreCipherList: string;
    readonly defaultCipherList: string;
  };
  export = constants;
}
declare module "node:constants" {
  import constants = require("constants");
  export = constants;
}

/* node:readline — the question/close slice: createInterface over exactly
 * { input: process.stdin, output: process.stdout }, question(query, cb)
 * (the query writes to stdout, the callback gets the next line's text),
 * close() (fires 'close' synchronously, like Node's inline emit), and
 * on("close", cb). An open interface keeps the process alive until
 * close()/EOF, Node's semantics; lines split on \n and \r\n. */
declare module "readline" {
  /* The Interface over process.stdin or a stream input (scr_readline.c;
   * terminal mode in scr_readline_tty.c). Listener registrations are
   * statements: chaining on()/once() results has no lowering. */
  export interface Key {
    sequence?: string;
    name?: string;
    ctrl?: boolean;
    meta?: boolean;
    shift?: boolean;
  }
  export class Interface implements Disposable {
    /* createInterface creates interfaces; instanceof tells the two
     * modules' classes apart. */
    protected constructor();
    /* terminal says whether the interface edits lines as a terminal;
     * line and cursor are the terminal's (line is '' otherwise). history
     * is the history option itself (or the interface's own empty array);
     * a terminal records the lines it reads. */
    readonly terminal: boolean;
    readonly line: string;
    readonly cursor: number;
    getCursorPos(): CursorPos;
    history: string[];
    readonly historySize: number;
    readonly historyIndex: number;
    readonly crlfDelay: number;
    readonly tabSize: number;
    readonly escapeCodeTimeout: number;
    question(query: string, callback: (answer: string) => void): void;
    close(): void;
    pause(): this;
    resume(): this;
    prompt(preserveCursor?: boolean): void;
    setPrompt(prompt: string): void;
    getPrompt(): string;
    write(data: string | null | undefined, key?: Key): void;
    on(event: "line", listener: (input: string) => void): this;
    on(
      event: "close" | "pause" | "resume" | "SIGINT" | "SIGTSTP" | "SIGCONT",
      listener: () => void,
    ): this;
    on(event: "error", listener: (err: Error) => void): this;
    on(event: "history", listener: (history: string[]) => void): this;
    once(event: "line", listener: (input: string) => void): this;
    once(
      event: "close" | "pause" | "resume" | "SIGINT" | "SIGTSTP" | "SIGCONT",
      listener: () => void,
    ): this;
    once(event: "error", listener: (err: Error) => void): this;
    once(event: "history", listener: (history: string[]) => void): this;
    addListener(event: "line", listener: (input: string) => void): this;
    addListener(
      event: "close" | "pause" | "resume" | "SIGINT" | "SIGTSTP" | "SIGCONT",
      listener: () => void,
    ): this;
    addListener(event: "error", listener: (err: Error) => void): this;
    addListener(event: "history", listener: (history: string[]) => void): this;
    [Symbol.asyncIterator](): AsyncIterableIterator<string>;
    [Symbol.dispose](): void;
  }
  export interface ReadLineOptions {
    input: unknown;
    output?: unknown;
    terminal?: boolean;
    /* Node's crlfDelay: a \n arriving within this many ms (at least 100)
     * after a line ended by \r is dropped. completer and the history
     * options are validated and kept; a terminal interface uses them.
     * The options-record
     * stance (see http.RequestOptions) admits every key; the walk
     * decides. */
    crlfDelay?: number;
    completer?: unknown;
    signal?: AbortSignal;
    history?: string[];
    historySize?: number;
    removeHistoryDuplicates?: boolean;
    tabSize?: number;
    escapeCodeTimeout?: number;
    [option: string]: unknown;
  }
  export function createInterface(options: ReadLineOptions): Interface;
  export function createInterface(
    input: unknown,
    output?: unknown,
    completer?: unknown,
    terminal?: boolean,
  ): Interface;
  export interface CursorPos {
    rows: number;
    cols: number;
  }
  /* The escape-sequence helpers over process.stdout, process.stderr, a
   * writable stream, or null/undefined (nothing is written). */
  export function cursorTo(stream: unknown, x: number, y?: number, callback?: () => void): boolean;
  export function cursorTo(stream: unknown, x: number, callback: () => void): boolean;
  export function moveCursor(
    stream: unknown,
    dx: number,
    dy: number,
    callback?: () => void,
  ): boolean;
  export function clearLine(stream: unknown, dir: -1 | 0 | 1, callback?: () => void): boolean;
  export function clearScreenDown(stream: unknown, callback?: () => void): boolean;
  /* 'keypress' events (str, key) on process.stdin or a readable stream */
  export function emitKeypressEvents(stream: unknown, readlineInterface?: unknown): void;
  /* the same object as node:readline/promises */
  export const promises: typeof import("node:readline/promises");
}
declare module "node:readline" {
  export * from "readline";
}
declare module "readline/promises" {
  import { CursorPos, Key, ReadLineOptions } from "readline";
  /* The escape-sequence builder over process.stdout, process.stderr or a
   * writable stream: actions queue until commit(), or are written on the
   * next tick with autoCommit. */
  export class Readline {
    constructor(stream: unknown, options?: { autoCommit?: boolean });
    clearLine(dir: -1 | 0 | 1): this;
    clearScreenDown(): this;
    commit(): Promise<void>;
    cursorTo(x: number, y?: number): this;
    moveCursor(dx: number, dy: number): this;
    rollback(): this;
  }
  /* The readline Interface with the promise question: it resolves with
   * the next line, rejects with an AbortError when options.signal aborts,
   * and with ERR_USE_AFTER_CLOSE after close(). */
  export class Interface implements Disposable {
    /* createInterface creates interfaces; instanceof tells the two
     * modules' classes apart. */
    protected constructor();
    /* terminal says whether the interface edits lines as a terminal;
     * line and cursor are the terminal's (line is '' otherwise). history
     * is the history option itself (or the interface's own empty array);
     * a terminal records the lines it reads. */
    readonly terminal: boolean;
    readonly line: string;
    readonly cursor: number;
    getCursorPos(): CursorPos;
    history: string[];
    readonly historySize: number;
    readonly historyIndex: number;
    readonly crlfDelay: number;
    readonly tabSize: number;
    readonly escapeCodeTimeout: number;
    question(query: string, options?: { signal?: AbortSignal }): Promise<string>;
    close(): void;
    pause(): this;
    resume(): this;
    prompt(preserveCursor?: boolean): void;
    setPrompt(prompt: string): void;
    getPrompt(): string;
    write(data: string | null | undefined, key?: Key): void;
    on(event: "line", listener: (input: string) => void): this;
    on(
      event: "close" | "pause" | "resume" | "SIGINT" | "SIGTSTP" | "SIGCONT",
      listener: () => void,
    ): this;
    on(event: "error", listener: (err: Error) => void): this;
    on(event: "history", listener: (history: string[]) => void): this;
    once(event: "line", listener: (input: string) => void): this;
    once(
      event: "close" | "pause" | "resume" | "SIGINT" | "SIGTSTP" | "SIGCONT",
      listener: () => void,
    ): this;
    once(event: "error", listener: (err: Error) => void): this;
    once(event: "history", listener: (history: string[]) => void): this;
    addListener(event: "line", listener: (input: string) => void): this;
    addListener(
      event: "close" | "pause" | "resume" | "SIGINT" | "SIGTSTP" | "SIGCONT",
      listener: () => void,
    ): this;
    addListener(event: "error", listener: (err: Error) => void): this;
    addListener(event: "history", listener: (history: string[]) => void): this;
    [Symbol.asyncIterator](): AsyncIterableIterator<string>;
    [Symbol.dispose](): void;
  }
  export function createInterface(options: ReadLineOptions): Interface;
  export function createInterface(
    input: unknown,
    output?: unknown,
    completer?: unknown,
    terminal?: boolean,
  ): Interface;
}
declare module "node:readline/promises" {
  export * from "readline/promises";
}

/* node:zlib — the one-shot zlib/raw/gzip codecs lower for string/Buffer
 * inputs with Node's default options; libz links only into zlib-using
 * binaries. Callback forms use the executable worker pool. Options stay
 * declared so reached uses receive a named SC2020 refusal. The Deflate,
 * Inflate, Gzip, Gunzip, DeflateRaw, InflateRaw and Unzip streams are
 * runtime Transform streams; Brotli and Zstd remain outside the lowered
 * surface. */
declare module "zlib" {
  import { Transform } from "stream";
  export interface ZlibOptions {
    [option: string]: unknown;
  }
  export type ZlibCallback = (error: NodeJS.ErrnoException | null, result: Buffer) => void;
  export function deflate(data: string | Uint8Array, callback: ZlibCallback): void;
  export function deflate(
    data: string | Uint8Array,
    options: ZlibOptions,
    callback: ZlibCallback,
  ): void;
  export function deflateSync(data: string | Uint8Array, options?: ZlibOptions): Buffer;
  export function inflate(data: string | Uint8Array, callback: ZlibCallback): void;
  export function inflate(
    data: string | Uint8Array,
    options: ZlibOptions,
    callback: ZlibCallback,
  ): void;
  export function inflateSync(data: string | Uint8Array, options?: ZlibOptions): Buffer;
  export function deflateRaw(data: string | Uint8Array, callback: ZlibCallback): void;
  export function deflateRaw(
    data: string | Uint8Array,
    options: ZlibOptions,
    callback: ZlibCallback,
  ): void;
  export function deflateRawSync(data: string | Uint8Array, options?: ZlibOptions): Buffer;
  export function inflateRaw(data: string | Uint8Array, callback: ZlibCallback): void;
  export function inflateRaw(
    data: string | Uint8Array,
    options: ZlibOptions,
    callback: ZlibCallback,
  ): void;
  export function inflateRawSync(data: string | Uint8Array, options?: ZlibOptions): Buffer;
  export function gzip(data: string | Uint8Array, callback: ZlibCallback): void;
  export function gzip(
    data: string | Uint8Array,
    options: ZlibOptions,
    callback: ZlibCallback,
  ): void;
  export function gzipSync(data: string | Uint8Array, options?: ZlibOptions): Buffer;
  export function gunzip(data: string | Uint8Array, callback: ZlibCallback): void;
  export function gunzip(
    data: string | Uint8Array,
    options: ZlibOptions,
    callback: ZlibCallback,
  ): void;
  export function gunzipSync(data: string | Uint8Array, options?: ZlibOptions): Buffer;
  export function unzip(data: string | Uint8Array, callback: ZlibCallback): void;
  export function unzip(
    data: string | Uint8Array,
    options: ZlibOptions,
    callback: ZlibCallback,
  ): void;
  export function unzipSync(data: string | Uint8Array, options?: ZlibOptions): Buffer;
  export function crc32(data: string | Uint8Array, value?: number): number;
  export function brotliCompressSync(data: string | Uint8Array): Buffer;
  export function brotliDecompressSync(data: Uint8Array): Buffer;
  /* Brotli needs a codec the static runtime does not vendor: these are
   * declared so their uses receive the named refusal. */
  export function brotliCompress(data: string | Uint8Array, callback: ZlibCallback): void;
  export function brotliDecompress(data: Uint8Array, callback: ZlibCallback): void;
  export function createBrotliCompress(options?: ZlibOptions): Transform;
  export function createBrotliDecompress(options?: ZlibOptions): Transform;
  export class BrotliCompress extends Transform {
    constructor(options?: ZlibOptions);
  }
  export class BrotliDecompress extends Transform {
    constructor(options?: ZlibOptions);
  }
  /* The stream classes: runtime Transform streams over the zlib engine
   * (scr_zlib_stream.c). createGzip(options) and new Gzip(options) build
   * the same stream; options are validated at runtime with Node's rules. */
  class ZlibBase extends Transform {
    readonly bytesWritten: number;
    flush(kind?: number, callback?: () => void): void;
    flush(callback: () => void): void;
    params(level: number, strategy: number, callback?: () => void): void;
    close(callback?: () => void): void;
    reset(): void;
  }
  export class Deflate extends ZlibBase {
    constructor(options?: ZlibOptions);
  }
  export class Inflate extends ZlibBase {
    constructor(options?: ZlibOptions);
  }
  export class Gzip extends ZlibBase {
    constructor(options?: ZlibOptions);
  }
  export class Gunzip extends ZlibBase {
    constructor(options?: ZlibOptions);
  }
  export class DeflateRaw extends ZlibBase {
    constructor(options?: ZlibOptions);
  }
  export class InflateRaw extends ZlibBase {
    constructor(options?: ZlibOptions);
  }
  export class Unzip extends ZlibBase {
    constructor(options?: ZlibOptions);
  }
  export function createDeflate(options?: ZlibOptions): Deflate;
  export function createInflate(options?: ZlibOptions): Inflate;
  export function createGzip(options?: ZlibOptions): Gzip;
  export function createGunzip(options?: ZlibOptions): Gunzip;
  export function createDeflateRaw(options?: ZlibOptions): DeflateRaw;
  export function createInflateRaw(options?: ZlibOptions): InflateRaw;
  export function createUnzip(options?: ZlibOptions): Unzip;
  /* Node v24 zlib.constants, literal-typed (the CryptoConstants stance):
   * every access bakes as its literal; the object never materializes. The
   * members outside BROTLI_* are also module properties (zlib.Z_SYNC_FLUSH). */
  export interface ZlibConstants {
    readonly Z_NO_FLUSH: 0;
    readonly Z_PARTIAL_FLUSH: 1;
    readonly Z_SYNC_FLUSH: 2;
    readonly Z_FULL_FLUSH: 3;
    readonly Z_FINISH: 4;
    readonly Z_BLOCK: 5;
    readonly Z_OK: 0;
    readonly Z_STREAM_END: 1;
    readonly Z_NEED_DICT: 2;
    readonly Z_ERRNO: -1;
    readonly Z_STREAM_ERROR: -2;
    readonly Z_DATA_ERROR: -3;
    readonly Z_MEM_ERROR: -4;
    readonly Z_BUF_ERROR: -5;
    readonly Z_VERSION_ERROR: -6;
    readonly Z_NO_COMPRESSION: 0;
    readonly Z_BEST_SPEED: 1;
    readonly Z_BEST_COMPRESSION: 9;
    readonly Z_DEFAULT_COMPRESSION: -1;
    readonly Z_FILTERED: 1;
    readonly Z_HUFFMAN_ONLY: 2;
    readonly Z_RLE: 3;
    readonly Z_FIXED: 4;
    readonly Z_DEFAULT_STRATEGY: 0;
    readonly ZLIB_VERNUM: 4897;
    readonly DEFLATE: 1;
    readonly INFLATE: 2;
    readonly GZIP: 3;
    readonly GUNZIP: 4;
    readonly DEFLATERAW: 5;
    readonly INFLATERAW: 6;
    readonly UNZIP: 7;
    readonly BROTLI_DECODE: 8;
    readonly BROTLI_ENCODE: 9;
    readonly ZSTD_DECOMPRESS: 11;
    readonly ZSTD_COMPRESS: 10;
    readonly Z_MIN_WINDOWBITS: 8;
    readonly Z_MAX_WINDOWBITS: 15;
    readonly Z_DEFAULT_WINDOWBITS: 15;
    readonly Z_MIN_CHUNK: 64;
    readonly Z_MAX_CHUNK: number;
    readonly Z_DEFAULT_CHUNK: 16384;
    readonly Z_MIN_MEMLEVEL: 1;
    readonly Z_MAX_MEMLEVEL: 9;
    readonly Z_DEFAULT_MEMLEVEL: 8;
    readonly Z_MIN_LEVEL: -1;
    readonly Z_MAX_LEVEL: 9;
    readonly Z_DEFAULT_LEVEL: -1;
    readonly BROTLI_OPERATION_PROCESS: 0;
    readonly BROTLI_OPERATION_FLUSH: 1;
    readonly BROTLI_OPERATION_FINISH: 2;
    readonly BROTLI_OPERATION_EMIT_METADATA: 3;
    readonly BROTLI_PARAM_MODE: 0;
    readonly BROTLI_MODE_GENERIC: 0;
    readonly BROTLI_MODE_TEXT: 1;
    readonly BROTLI_MODE_FONT: 2;
    readonly BROTLI_DEFAULT_MODE: 0;
    readonly BROTLI_PARAM_QUALITY: 1;
    readonly BROTLI_MIN_QUALITY: 0;
    readonly BROTLI_MAX_QUALITY: 11;
    readonly BROTLI_DEFAULT_QUALITY: 11;
    readonly BROTLI_PARAM_LGWIN: 2;
    readonly BROTLI_MIN_WINDOW_BITS: 10;
    readonly BROTLI_MAX_WINDOW_BITS: 24;
    readonly BROTLI_LARGE_MAX_WINDOW_BITS: 30;
    readonly BROTLI_DEFAULT_WINDOW: 22;
    readonly BROTLI_PARAM_LGBLOCK: 3;
    readonly BROTLI_MIN_INPUT_BLOCK_BITS: 16;
    readonly BROTLI_MAX_INPUT_BLOCK_BITS: 24;
    readonly BROTLI_PARAM_DISABLE_LITERAL_CONTEXT_MODELING: 4;
    readonly BROTLI_PARAM_SIZE_HINT: 5;
    readonly BROTLI_PARAM_LARGE_WINDOW: 6;
    readonly BROTLI_PARAM_NPOSTFIX: 7;
    readonly BROTLI_PARAM_NDIRECT: 8;
    readonly BROTLI_DECODER_RESULT_ERROR: 0;
    readonly BROTLI_DECODER_RESULT_SUCCESS: 1;
    readonly BROTLI_DECODER_RESULT_NEEDS_MORE_INPUT: 2;
    readonly BROTLI_DECODER_RESULT_NEEDS_MORE_OUTPUT: 3;
    readonly BROTLI_DECODER_PARAM_DISABLE_RING_BUFFER_REALLOCATION: 0;
    readonly BROTLI_DECODER_PARAM_LARGE_WINDOW: 1;
    readonly BROTLI_DECODER_NO_ERROR: 0;
    readonly BROTLI_DECODER_SUCCESS: 1;
    readonly BROTLI_DECODER_NEEDS_MORE_INPUT: 2;
    readonly BROTLI_DECODER_NEEDS_MORE_OUTPUT: 3;
    readonly BROTLI_DECODER_ERROR_FORMAT_EXUBERANT_NIBBLE: -1;
    readonly BROTLI_DECODER_ERROR_FORMAT_RESERVED: -2;
    readonly BROTLI_DECODER_ERROR_FORMAT_EXUBERANT_META_NIBBLE: -3;
    readonly BROTLI_DECODER_ERROR_FORMAT_SIMPLE_HUFFMAN_ALPHABET: -4;
    readonly BROTLI_DECODER_ERROR_FORMAT_SIMPLE_HUFFMAN_SAME: -5;
    readonly BROTLI_DECODER_ERROR_FORMAT_CL_SPACE: -6;
    readonly BROTLI_DECODER_ERROR_FORMAT_HUFFMAN_SPACE: -7;
    readonly BROTLI_DECODER_ERROR_FORMAT_CONTEXT_MAP_REPEAT: -8;
    readonly BROTLI_DECODER_ERROR_FORMAT_BLOCK_LENGTH_1: -9;
    readonly BROTLI_DECODER_ERROR_FORMAT_BLOCK_LENGTH_2: -10;
    readonly BROTLI_DECODER_ERROR_FORMAT_TRANSFORM: -11;
    readonly BROTLI_DECODER_ERROR_FORMAT_DICTIONARY: -12;
    readonly BROTLI_DECODER_ERROR_FORMAT_WINDOW_BITS: -13;
    readonly BROTLI_DECODER_ERROR_FORMAT_PADDING_1: -14;
    readonly BROTLI_DECODER_ERROR_FORMAT_PADDING_2: -15;
    readonly BROTLI_DECODER_ERROR_FORMAT_DISTANCE: -16;
    readonly BROTLI_DECODER_ERROR_DICTIONARY_NOT_SET: -19;
    readonly BROTLI_DECODER_ERROR_INVALID_ARGUMENTS: -20;
    readonly BROTLI_DECODER_ERROR_ALLOC_CONTEXT_MODES: -21;
    readonly BROTLI_DECODER_ERROR_ALLOC_TREE_GROUPS: -22;
    readonly BROTLI_DECODER_ERROR_ALLOC_CONTEXT_MAP: -25;
    readonly BROTLI_DECODER_ERROR_ALLOC_RING_BUFFER_1: -26;
    readonly BROTLI_DECODER_ERROR_ALLOC_RING_BUFFER_2: -27;
    readonly BROTLI_DECODER_ERROR_ALLOC_BLOCK_TYPE_TREES: -30;
    readonly BROTLI_DECODER_ERROR_UNREACHABLE: -31;
    readonly ZSTD_e_continue: 0;
    readonly ZSTD_e_flush: 1;
    readonly ZSTD_e_end: 2;
    readonly ZSTD_fast: 1;
    readonly ZSTD_dfast: 2;
    readonly ZSTD_greedy: 3;
    readonly ZSTD_lazy: 4;
    readonly ZSTD_lazy2: 5;
    readonly ZSTD_btlazy2: 6;
    readonly ZSTD_btopt: 7;
    readonly ZSTD_btultra: 8;
    readonly ZSTD_btultra2: 9;
    readonly ZSTD_c_compressionLevel: 100;
    readonly ZSTD_c_windowLog: 101;
    readonly ZSTD_c_hashLog: 102;
    readonly ZSTD_c_chainLog: 103;
    readonly ZSTD_c_searchLog: 104;
    readonly ZSTD_c_minMatch: 105;
    readonly ZSTD_c_targetLength: 106;
    readonly ZSTD_c_strategy: 107;
    readonly ZSTD_c_enableLongDistanceMatching: 160;
    readonly ZSTD_c_ldmHashLog: 161;
    readonly ZSTD_c_ldmMinMatch: 162;
    readonly ZSTD_c_ldmBucketSizeLog: 163;
    readonly ZSTD_c_ldmHashRateLog: 164;
    readonly ZSTD_c_contentSizeFlag: 200;
    readonly ZSTD_c_checksumFlag: 201;
    readonly ZSTD_c_dictIDFlag: 202;
    readonly ZSTD_c_nbWorkers: 400;
    readonly ZSTD_c_jobSize: 401;
    readonly ZSTD_c_overlapLog: 402;
    readonly ZSTD_d_windowLogMax: 100;
    readonly ZSTD_CLEVEL_DEFAULT: 3;
    readonly ZSTD_error_no_error: 0;
    readonly ZSTD_error_GENERIC: 1;
    readonly ZSTD_error_prefix_unknown: 10;
    readonly ZSTD_error_version_unsupported: 12;
    readonly ZSTD_error_frameParameter_unsupported: 14;
    readonly ZSTD_error_frameParameter_windowTooLarge: 16;
    readonly ZSTD_error_corruption_detected: 20;
    readonly ZSTD_error_checksum_wrong: 22;
    readonly ZSTD_error_literals_headerWrong: 24;
    readonly ZSTD_error_dictionary_corrupted: 30;
    readonly ZSTD_error_dictionary_wrong: 32;
    readonly ZSTD_error_dictionaryCreation_failed: 34;
    readonly ZSTD_error_parameter_unsupported: 40;
    readonly ZSTD_error_parameter_combination_unsupported: 41;
    readonly ZSTD_error_parameter_outOfBound: 42;
    readonly ZSTD_error_tableLog_tooLarge: 44;
    readonly ZSTD_error_maxSymbolValue_tooLarge: 46;
    readonly ZSTD_error_maxSymbolValue_tooSmall: 48;
    readonly ZSTD_error_stabilityCondition_notRespected: 50;
    readonly ZSTD_error_stage_wrong: 60;
    readonly ZSTD_error_init_missing: 62;
    readonly ZSTD_error_memory_allocation: 64;
    readonly ZSTD_error_workSpace_tooSmall: 66;
    readonly ZSTD_error_dstSize_tooSmall: 70;
    readonly ZSTD_error_srcSize_wrong: 72;
    readonly ZSTD_error_dstBuffer_null: 74;
    readonly ZSTD_error_noForwardProgress_destFull: 80;
    readonly ZSTD_error_noForwardProgress_inputEmpty: 82;
  }
  export const constants: ZlibConstants;
  export const Z_NO_FLUSH: 0;
  export const Z_PARTIAL_FLUSH: 1;
  export const Z_SYNC_FLUSH: 2;
  export const Z_FULL_FLUSH: 3;
  export const Z_FINISH: 4;
  export const Z_BLOCK: 5;
  export const Z_OK: 0;
  export const Z_STREAM_END: 1;
  export const Z_NEED_DICT: 2;
  export const Z_ERRNO: -1;
  export const Z_STREAM_ERROR: -2;
  export const Z_DATA_ERROR: -3;
  export const Z_MEM_ERROR: -4;
  export const Z_BUF_ERROR: -5;
  export const Z_VERSION_ERROR: -6;
  export const Z_NO_COMPRESSION: 0;
  export const Z_BEST_SPEED: 1;
  export const Z_BEST_COMPRESSION: 9;
  export const Z_DEFAULT_COMPRESSION: -1;
  export const Z_FILTERED: 1;
  export const Z_HUFFMAN_ONLY: 2;
  export const Z_RLE: 3;
  export const Z_FIXED: 4;
  export const Z_DEFAULT_STRATEGY: 0;
  export const ZLIB_VERNUM: 4897;
  export const DEFLATE: 1;
  export const INFLATE: 2;
  export const GZIP: 3;
  export const GUNZIP: 4;
  export const DEFLATERAW: 5;
  export const INFLATERAW: 6;
  export const UNZIP: 7;
  export const ZSTD_DECOMPRESS: 11;
  export const ZSTD_COMPRESS: 10;
  export const Z_MIN_WINDOWBITS: 8;
  export const Z_MAX_WINDOWBITS: 15;
  export const Z_DEFAULT_WINDOWBITS: 15;
  export const Z_MIN_CHUNK: 64;
  export const Z_MAX_CHUNK: number;
  export const Z_DEFAULT_CHUNK: 16384;
  export const Z_MIN_MEMLEVEL: 1;
  export const Z_MAX_MEMLEVEL: 9;
  export const Z_DEFAULT_MEMLEVEL: 8;
  export const Z_MIN_LEVEL: -1;
  export const Z_MAX_LEVEL: 9;
  export const Z_DEFAULT_LEVEL: -1;
  export const ZSTD_e_continue: 0;
  export const ZSTD_e_flush: 1;
  export const ZSTD_e_end: 2;
  export const ZSTD_fast: 1;
  export const ZSTD_dfast: 2;
  export const ZSTD_greedy: 3;
  export const ZSTD_lazy: 4;
  export const ZSTD_lazy2: 5;
  export const ZSTD_btlazy2: 6;
  export const ZSTD_btopt: 7;
  export const ZSTD_btultra: 8;
  export const ZSTD_btultra2: 9;
  export const ZSTD_c_compressionLevel: 100;
  export const ZSTD_c_windowLog: 101;
  export const ZSTD_c_hashLog: 102;
  export const ZSTD_c_chainLog: 103;
  export const ZSTD_c_searchLog: 104;
  export const ZSTD_c_minMatch: 105;
  export const ZSTD_c_targetLength: 106;
  export const ZSTD_c_strategy: 107;
  export const ZSTD_c_enableLongDistanceMatching: 160;
  export const ZSTD_c_ldmHashLog: 161;
  export const ZSTD_c_ldmMinMatch: 162;
  export const ZSTD_c_ldmBucketSizeLog: 163;
  export const ZSTD_c_ldmHashRateLog: 164;
  export const ZSTD_c_contentSizeFlag: 200;
  export const ZSTD_c_checksumFlag: 201;
  export const ZSTD_c_dictIDFlag: 202;
  export const ZSTD_c_nbWorkers: 400;
  export const ZSTD_c_jobSize: 401;
  export const ZSTD_c_overlapLog: 402;
  export const ZSTD_d_windowLogMax: 100;
  export const ZSTD_CLEVEL_DEFAULT: 3;
  export const ZSTD_error_no_error: 0;
  export const ZSTD_error_GENERIC: 1;
  export const ZSTD_error_prefix_unknown: 10;
  export const ZSTD_error_version_unsupported: 12;
  export const ZSTD_error_frameParameter_unsupported: 14;
  export const ZSTD_error_frameParameter_windowTooLarge: 16;
  export const ZSTD_error_corruption_detected: 20;
  export const ZSTD_error_checksum_wrong: 22;
  export const ZSTD_error_literals_headerWrong: 24;
  export const ZSTD_error_dictionary_corrupted: 30;
  export const ZSTD_error_dictionary_wrong: 32;
  export const ZSTD_error_dictionaryCreation_failed: 34;
  export const ZSTD_error_parameter_unsupported: 40;
  export const ZSTD_error_parameter_combination_unsupported: 41;
  export const ZSTD_error_parameter_outOfBound: 42;
  export const ZSTD_error_tableLog_tooLarge: 44;
  export const ZSTD_error_maxSymbolValue_tooLarge: 46;
  export const ZSTD_error_maxSymbolValue_tooSmall: 48;
  export const ZSTD_error_stabilityCondition_notRespected: 50;
  export const ZSTD_error_stage_wrong: 60;
  export const ZSTD_error_init_missing: 62;
  export const ZSTD_error_memory_allocation: 64;
  export const ZSTD_error_workSpace_tooSmall: 66;
  export const ZSTD_error_dstSize_tooSmall: 70;
  export const ZSTD_error_srcSize_wrong: 72;
  export const ZSTD_error_dstBuffer_null: 74;
  export const ZSTD_error_noForwardProgress_destFull: 80;
  export const ZSTD_error_noForwardProgress_inputEmpty: 82;
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
    /* Whether the socket keeps the event loop alive (ref'd by default). */
    ref(): void;
    unref(): void;
    readonly remoteAddress: string | undefined;
    /* The peer's fields are cached at first read, like remoteAddress; the
     * local ones are undefined while connecting and after close. */
    readonly remotePort: number | undefined;
    readonly remoteFamily: string | undefined;
    readonly localAddress: string | undefined;
    readonly localPort: number | undefined;
    readonly localFamily: string | undefined;
    readonly bytesRead: number;
    readonly connecting: boolean;
    readonly pending: boolean;
    readonly readyState: "opening" | "open" | "readOnly" | "writeOnly" | "closed";
    /* true once the fd is gone (destroy() or full close) — Node's flag. */
    readonly destroyed: boolean;
    /* the write half is open: no end() yet, no FIN sent, fd alive. */
    readonly writable: boolean;
    /* true until the read half is done (peer FIN / destroy). */
    readonly readable: boolean;
    /* every byte the write paths accepted (buffered included — Node
     * counts those too; plaintext on TLS sockets). */
    readonly bytesWritten: number;
    /* write's callback runs once the data is flushed, with null; end's
     * once the socket finishes. */
    write(data: string | Uint8Array, callback?: (err?: Error | null) => void): void;
    end(callback?: () => void): void;
    end(data: string | Uint8Array, callback?: () => void): void;
    destroy(): void;
    /* Flow control: pause holds reads off (kernel/TCP backpressure is
     * the buffer); resume flows — and discards without listeners, so
     * 'end' stays reachable. Both chain, Node's shape. */
    pause(): Socket;
    resume(): Socket;
    /* TCP_NODELAY on the live fd; missing means true. Chains. */
    setNoDelay(noDelay?: boolean): Socket;
    /* SO_KEEPALIVE with the initial delay in ms. Chains. */
    setKeepAlive(enable?: boolean, initialDelay?: number): Socket;
    /* end() now, destroy once the FIN actually flushed. */
    destroySoon(): void;
    /* An RST instead of a FIN; a connecting socket resets once it
     * connects. Throws ERR_INVALID_HANDLE_TYPE on a TLS socket. */
    resetAndDestroy(): Socket;
    /* The local address, or {} while connecting and once destroyed. */
    address(): AddressInfo | {};
    /* setEncoding('utf8'): 'data' delivers strings — the IncomingMessage
     * twin's contract. */
    setEncoding(encoding: string): void;
    /* socket→socket, and socket→response (the extended-CONNECT bridge
     * leg: raw chunks become response body writes; EOF ends it). */
    pipe(
      destination: Socket | import("http").ServerResponse | import("http2").Http2ServerResponse,
    ): void;
    /* The callback is a once('timeout') listener (removed again by 0). */
    setTimeout(ms: number, callback?: () => void): void;
    /* The paused-mode demux surface: once('readable') + read(1) +
     * unshift — read answers exactly n buffered bytes or null. */
    read(size?: number): Buffer | null;
    unshift(chunk: Uint8Array): void;
    /* secureConnect/secure/session are TLS-socket events declared on the
     * shared socket surface (the lowering collapses TLSSocket onto this kind):
     * the runtime gates on the transport, so a plain socket's
     * registration never fires — Node's exact split. 'session' fires
     * once with the serialized session (the received-ticket event). */
    on(event: "data", listener: (chunk: Buffer) => void): void;
    /* After setEncoding the chunk is a string. */
    on(event: "data", listener: (chunk: string) => void): void;
    on(
      event:
        | "end"
        | "connect"
        | "ready"
        | "timeout"
        | "readable"
        | "finish"
        | "secureConnect"
        | "secure",
      listener: () => void,
    ): void;
    on(event: "close", listener: (hadError: boolean) => void): void;
    on(event: "error", listener: (err: Error) => void): void;
    on(event: "session", listener: (session: Buffer) => void): void;
    /* The host name's resolution, before the connect. */
    on(
      event: "lookup",
      listener: (err: Error | null, address: string, family: number, host: string) => void,
    ): void;
    /* addListener IS on (Node aliases them) — the suite spells both. */
    addListener(event: "data", listener: (chunk: Buffer) => void): void;
    /* After setEncoding the chunk is a string. */
    addListener(event: "data", listener: (chunk: string) => void): void;
    addListener(
      event:
        | "end"
        | "connect"
        | "ready"
        | "timeout"
        | "readable"
        | "finish"
        | "secureConnect"
        | "secure",
      listener: () => void,
    ): void;
    addListener(event: "close", listener: (hadError: boolean) => void): void;
    addListener(event: "error", listener: (err: Error) => void): void;
    addListener(event: "session", listener: (session: Buffer) => void): void;
    /* The host name's resolution, before the connect. */
    addListener(
      event: "lookup",
      listener: (err: Error | null, address: string, family: number, host: string) => void,
    ): void;
    once(event: "data", listener: (chunk: Buffer) => void): void;
    /* After setEncoding the chunk is a string. */
    once(event: "data", listener: (chunk: string) => void): void;
    once(
      event:
        | "end"
        | "connect"
        | "ready"
        | "timeout"
        | "readable"
        | "finish"
        | "secureConnect"
        | "secure",
      listener: () => void,
    ): void;
    once(event: "close", listener: (hadError: boolean) => void): void;
    once(event: "error", listener: (err: Error) => void): void;
    once(event: "session", listener: (session: Buffer) => void): void;
    /* The host name's resolution, before the connect. */
    once(
      event: "lookup",
      listener: (err: Error | null, address: string, family: number, host: string) => void,
    ): void;
  }
  export interface Server {
    /* Whether the server keeps the event loop alive (ref'd by default). */
    ref(): void;
    unref(): void;
    readonly listening: boolean;
    /* Connections past this many are closed with a 'drop' event;
     * undefined (the default) or null lifts the cap. */
    maxConnections: number | undefined;
    /* Node reads it only in cluster mode: a stored value here. */
    dropMaxConnection: boolean | undefined;
    /* cb(null, count) on the next tick. */
    getConnections(callback: (error: Error | null, count: number) => void): Server;
    /* Node answers the server itself (`return this` chaining). */
    listen(port: number, callback?: () => void): Server;
    /* The positional bind address (the options form's host in argument
     * spelling). */
    listen(port: number, host: string, callback?: () => void): Server;
    /* A Unix-socket server; the socket file is removed when it closes. */
    listen(path: string, callback?: () => void): Server;
    /* The explicit-interface bind: host is an IP literal (absent = the
     * host-less dual-stack any); ipv6Only sets IPV6_V6ONLY and reusePort
     * requests kernel connection distribution where Node supports it. */
    listen(
      options: { port: number; host?: string; ipv6Only?: boolean; reusePort?: boolean },
      callback?: () => void,
    ): Server;
    close(callback?: () => void): void;
    /* The bound AddressInfo (Node answers null before listen — this
     * surface answers the record with port 0 there, the serverPort
     * stance). */
    address(): import("node:dgram").AddressInfo;
    /* The demux route: hand an accepted socket to another server. */
    emit(event: "connection", socket: Socket): boolean;
    on(event: "connection" | "secureConnection", listener: (socket: Socket) => void): void;
    on(event: "close" | "listening", listener: () => void): void;
    on(event: "drop", listener: (data?: DropArgument) => void): void;
    on(event: "timeout", listener: (socket: Socket) => void): void;
    on(event: "error", listener: (err: Error) => void): void;
    /* The WebSocket handover: fires INSTEAD of 'request' for
     * Connection: upgrade requests, with the raw socket + head bytes;
     * 'connect' is its twin for CONNECT requests (HTTP tunneling). */
    on(
      event: "upgrade" | "connect",
      listener: (req: import("http").IncomingMessage, socket: Socket, head: Buffer) => void,
    ): void;
    /* http.createServer(handler)'s event twin (a no-parser net server
     * never fires it, like Node). */
    on(
      event: "request" | "checkContinue" | "checkExpectation",
      listener: (req: import("http").IncomingMessage, res: import("http").ServerResponse) => void,
    ): void;
    /* addListener IS on (Node aliases them) — the suite spells both. */
    addListener(event: "connection" | "secureConnection", listener: (socket: Socket) => void): void;
    addListener(event: "close" | "listening", listener: () => void): void;
    addListener(event: "drop", listener: (data?: DropArgument) => void): void;
    addListener(event: "timeout", listener: (socket: Socket) => void): void;
    addListener(event: "error", listener: (err: Error) => void): void;
    addListener(
      event: "upgrade" | "connect",
      listener: (req: import("http").IncomingMessage, socket: Socket, head: Buffer) => void,
    ): void;
    addListener(
      event: "request" | "checkContinue" | "checkExpectation",
      listener: (req: import("http").IncomingMessage, res: import("http").ServerResponse) => void,
    ): void;
    once(event: "connection" | "secureConnection", listener: (socket: Socket) => void): void;
    once(event: "close" | "listening", listener: () => void): void;
    once(event: "drop", listener: (data?: DropArgument) => void): void;
    once(event: "timeout", listener: (socket: Socket) => void): void;
    once(event: "error", listener: (err: Error) => void): void;
    once(
      event: "upgrade" | "connect",
      listener: (req: import("http").IncomingMessage, socket: Socket, head: Buffer) => void,
    ): void;
    once(
      event: "request" | "checkContinue" | "checkExpectation",
      listener: (req: import("http").IncomingMessage, res: import("http").ServerResponse) => void,
    ): void;
  }
  /* The 'drop' payload: the turned-away connection's addresses. */
  export interface DropArgument {
    localAddress?: string;
    localPort?: number;
    localFamily?: string;
    remoteAddress?: string;
    remotePort?: number;
    remoteFamily?: string;
  }
  export type AddressInfo = import("node:dgram").AddressInfo;
  export type IPVersion = "ipv4" | "ipv6";
  export interface SocketAddressInitOptions {
    address?: string;
    family?: IPVersion;
    flowlabel?: number;
    port?: number;
  }
  /* A native handle (scr_net.c); the getters read its parsed address. */
  export class SocketAddress {
    constructor(options?: SocketAddressInitOptions);
    readonly address: string;
    readonly family: IPVersion;
    readonly port: number;
    readonly flowlabel: number;
    toJSON(): { address: string; port: number; family: IPVersion; flowlabel: number };
    /* undefined when the input is not "<ip>[:<port>]" */
    static parse(input: string): SocketAddress | undefined;
    static isSocketAddress(value: unknown): value is SocketAddress;
  }
  /* Address, range and subnet rules; check() matches IPv4 addresses
   * against IPv6 rules through their IPv4-mapped form, as Node does. */
  export class BlockList {
    constructor();
    readonly rules: readonly string[];
    readonly size: number;
    addAddress(address: string | SocketAddress, type?: IPVersion): void;
    addAddresses(addresses: readonly (string | SocketAddress)[], type?: IPVersion): void;
    addRange(start: string | SocketAddress, end: string | SocketAddress, type?: IPVersion): void;
    addSubnet(net: string | SocketAddress, prefix: number, type?: IPVersion): void;
    addCIDR(cidr: string): void;
    addCIDRs(cidrs: readonly string[]): void;
    removeAddress(address: string | SocketAddress, type?: IPVersion): void;
    removeRange(start: string | SocketAddress, end: string | SocketAddress, type?: IPVersion): void;
    removeSubnet(net: string | SocketAddress, prefix: number, type?: IPVersion): void;
    removeCIDR(cidr: string): void;
    clear(): void;
    check(address: string | SocketAddress, type?: IPVersion): boolean;
    toJSON(): string[];
    fromJSON(data: string | readonly string[]): void;
    static isBlockList(value: unknown): value is BlockList;
    static readonly PRIVATE_RANGES: readonly string[];
  }
  /* Node's IPv4Reg and IPv6Reg tests: 4, 6, or 0 for isIP. */
  export function isIP(input: string): number;
  export function isIPv4(input: string): boolean;
  export function isIPv6(input: string): boolean;
  /* The Socket VALUE — the `x instanceof net.Socket` narrowing target
   * (the h2 compat 'connect' listener's test). Constructing bare sockets
   * has no lowering; the construct signature exists for instanceof. */
  export const Socket: abstract new () => Socket;
  export function createServer(connectionListener?: (socket: Socket) => void): Server;
  export function connect(port: number, host?: string, connectListener?: () => void): Socket;
  export function createConnection(
    port: number,
    host?: string,
    connectListener?: () => void,
  ): Socket;
  /* The caller-resolver dial (@types/node's net.LookupFunction): the
   * runtime invokes it as Node's autoSelectFamily dial does (options
   * { hints, all: true }, so the callback answers an address list) and
   * dials the answered addresses in order. */
  export type LookupFunction = (
    hostname: string,
    options: import("node:dns").LookupOptions,
    callback: (
      err: NodeJS.ErrnoException | null,
      address: string | import("node:dns").LookupAddress[],
      family?: number,
    ) => void,
  ) => void;
  export function connect(
    options: {
      port: number;
      host?: string;
      autoSelectFamily?: boolean;
      lookup?: LookupFunction;
    },
    connectListener?: () => void,
  ): Socket;
  export function createConnection(
    options: {
      port: number;
      host?: string;
      autoSelectFamily?: boolean;
      lookup?: LookupFunction;
    },
    connectListener?: () => void,
  ): Socket;
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
  export const METHODS: string[];
  export const STATUS_CODES: { [status: number]: string | undefined };
  export const maxHeaderSize: number;
  export interface Server extends NetServer {
    timeout: number;
    setTimeout(msecs: number, callback?: (socket: Socket) => void): this;
    closeAllConnections(): void;
    closeIdleConnections(): void;
    keepAliveTimeout: number;
    keepAliveTimeoutBuffer: number;
    headersTimeout: number;
    requestTimeout: number;
  }
  export type RequestListener = (req: IncomingMessage, res: ServerResponse) => void;
  /* The Server VALUE — Node's constructor works with and without `new`
   * (test/parallel's http.Server(fn) spelling); both route to the
   * createServer lowering. */
  export const Server: {
    new (requestListener?: (req: IncomingMessage, res: ServerResponse) => void): Server;
    new (
      options: ServerOptions,
      requestListener?: (req: IncomingMessage, res: ServerResponse) => void,
    ): Server;
    (requestListener?: (req: IncomingMessage, res: ServerResponse) => void): Server;
    (
      options: ServerOptions,
      requestListener?: (req: IncomingMessage, res: ServerResponse) => void,
    ): Server;
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
    maxHeaderSize?: number;
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
    readonly httpVersion: string;
    readonly complete: boolean;
    readonly aborted: boolean;
    readonly statusCode: number | undefined;
    readonly statusMessage: string | undefined;
    readonly socket: Socket;
    readonly connection: Socket;
    readonly headers: { [name: string]: string | undefined };
    readonly headersDistinct: { [name: string]: string[] | undefined };
    readonly rawHeaders: string[];
    readonly trailers: { [name: string]: string | undefined };
    readonly trailersDistinct: { [name: string]: string[] | undefined };
    readonly rawTrailers: string[];
    resume(): void;
    pause(): void;
    destroy(): void;
    setTimeout(msecs: number, callback?: () => void): this;
    /* setEncoding('utf8'): 'data' delivers strings (other real encodings
     * throw a "not supported yet" Error at runtime; unknown names throw
     * ERR_UNKNOWN_ENCODING). */
    setEncoding(encoding: string): void;
    /* The proxy legs: the body streams into a ServerResponse, a
     * ClientRequest, or a raw Socket; natural end ends the destination. */
    pipe(
      destination: ServerResponse | import("http2").Http2ServerResponse | ClientRequest | Socket,
    ): void;
    on(event: "data", listener: (chunk: any) => void): void;
    on(event: "end" | "close" | "aborted", listener: () => void): void;
    on(event: "error", listener: (err: Error) => void): void;
    /* addListener IS on (Node aliases them) — the suite spells both. */
    addListener(event: "data", listener: (chunk: any) => void): void;
    addListener(event: "end" | "close" | "aborted", listener: () => void): void;
    addListener(event: "error", listener: (err: Error) => void): void;
    once(event: "data", listener: (chunk: any) => void): void;
    once(event: "end" | "close" | "aborted", listener: () => void): void;
    once(event: "error", listener: (err: Error) => void): void;
  }
  export interface ServerResponse {
    readonly headersSent: boolean;
    readonly writableEnded: boolean;
    readonly finished: boolean;
    readonly writableFinished: boolean;
    readonly writableCorked: number;
    readonly req: IncomingMessage;
    readonly socket: Socket | null;
    readonly connection: Socket | null;
    sendDate: boolean;
    strictContentLength: boolean;
    /* Node's writable head properties: the implicit head reads them. */
    statusCode: number;
    statusMessage: string | undefined;
    /* The value keeps its type: getHeader answers the number, string or
     * array that was set. */
    setHeader(name: string, value: number | string | readonly string[]): void;
    appendHeader(name: string, value: string | readonly string[]): void;
    getHeader(name: string): number | string | string[] | undefined;
    getHeaderNames(): string[];
    getRawHeaderNames(): string[];
    getHeaders(): OutgoingHttpHeaders;
    hasHeader(name: string): boolean;
    removeHeader(name: string): void;
    /* Both overloads answer the response (`return this` chaining); the
     * headers argument also takes Node's flat [name, value, ...] array. */
    writeHead(statusCode: number, headers?: OutgoingHttpHeaders | string[]): ServerResponse;
    writeHead(
      statusCode: number,
      statusMessage: string,
      headers?: OutgoingHttpHeaders | string[],
    ): ServerResponse;
    writeContinue(callback?: () => void): void;
    writeProcessing(callback?: () => void): void;
    writeEarlyHints(hints: Record<string, string | string[]>, callback?: () => void): void;
    write(data: string | Uint8Array): void;
    flushHeaders(): void;
    cork(): void;
    uncork(): void;
    addTrailers(headers: OutgoingHttpHeaders | ReadonlyArray<[string, string]>): void;
    setTimeout(msecs: number, callback?: () => void): this;
    /* end's callback forms fire once the body went out (the 'finish'
     * emit, deferred past the handler's synchronous tail). */
    end(data?: string | Uint8Array, callback?: () => void): void;
    end(callback: () => void): void;
    destroy(): void;
    on(event: "close" | "finish", listener: () => void): void;
    /* addListener IS on (Node aliases them) — the suite spells both. */
    addListener(event: "close" | "finish", listener: () => void): void;
    once(event: "close" | "finish", listener: () => void): void;
  }
  /* The CLIENT slice (http.request/http.get): the options-object form
   * with hostname/host, port, path, method, timeout, and headers; the
   * callback receives the response as an IncomingMessage (statusCode,
   * headers, body via on("data"/"end")). */
  export interface RequestOptions {
    hostname?: string | null;
    host?: string | null;
    /* A string port (a URL's .port) is accepted, as by Node. */
    port?: number | string | null;
    path?: string | null;
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
    /* Aborting destroys the request with an AbortError. */
    signal?: AbortSignal;
    /* HTTP over the Unix socket at this path instead of host:port. */
    socketPath?: string;
    /* The options-record stance: Node ignores an options record's
     * unknown keys, so every key typechecks here — the option WALK in
     * the lowering decides per key (lower, fence by name, or drop
     * undocumented keys exactly like Node). */
    [option: string]: unknown;
  }
  /* The Agent lowers to a checked-dynamic HANDLE: option parsing at the
   * literal construction site, getName, destroy, the sockets/requests/
   * freeSockets snapshots, and REAL maxSockets accounting (over-limit
   * requests defer their dial and queue). keepAlive: true keeps finished
   * connections in freeSockets for the next request to the same name,
   * taken in `scheduling` order. */
  export interface AgentOptions {
    keepAlive?: boolean;
    keepAliveMsecs?: number;
    maxSockets?: number;
    maxFreeSockets?: number;
    maxTotalSockets?: number;
    scheduling?: "fifo" | "lifo";
    timeout?: number;
    port?: number;
    [option: string]: unknown;
  }
  export class Agent {
    constructor(options?: AgentOptions);
    destroy(): void;
    /* Node's exact key shape: host:port:localAddress[:family][:socketPath]. */
    getName(options?: {
      host?: string;
      port?: number;
      localAddress?: string;
      family?: number;
      socketPath?: string;
      [option: string]: unknown;
    }): string;
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
  /* Node's keepAlive global agent for requests without an agent option. */
  export const globalAgent: Agent;
  export interface ClientRequest {
    readonly destroyed: boolean;
    readonly aborted: boolean;
    readonly socket: Socket;
    readonly connection: Socket;
    readonly writableCorked: number;
    readonly method: string;
    readonly path: string;
    readonly host: string;
    readonly protocol: string;
    readonly headersSent: boolean;
    readonly writableEnded: boolean;
    readonly writableFinished: boolean;
    readonly finished: boolean;
    readonly reusedSocket: boolean;
    setHeader(name: string, value: string): void;
    getHeader(name: string): string | undefined;
    hasHeader(name: string): boolean;
    removeHeader(name: string): void;
    getHeaderNames(): string[];
    getRawHeaderNames(): string[];
    getHeaders(): OutgoingHttpHeaders;
    flushHeaders(): void;
    addTrailers(headers: OutgoingHttpHeaders | ReadonlyArray<[string, string]>): void;
    cork(): void;
    uncork(): void;
    setNoDelay(noDelay?: boolean): void;
    setSocketKeepAlive(enable?: boolean, initialDelay?: number): void;
    setTimeout(timeout: number, callback?: () => void): this;
    write(data: string | Uint8Array): void;
    end(data?: string | Uint8Array): void;
    destroy(error?: Error): void;
    abort(): void;
    on(event: "response", listener: (res: IncomingMessage) => void): void;
    on(event: "socket", listener: (socket: Socket) => void): void;
    on(
      event: "upgrade",
      listener: (res: IncomingMessage, socket: Socket, head: Buffer) => void,
    ): void;
    on(event: "timeout" | "close" | "finish" | "abort" | "continue", listener: () => void): void;
    on(event: "error", listener: (err: Error) => void): void;
    /* addListener IS on (Node aliases them) — the suite spells both. */
    addListener(event: "response", listener: (res: IncomingMessage) => void): void;
    addListener(event: "socket", listener: (socket: Socket) => void): void;
    addListener(
      event: "upgrade",
      listener: (res: IncomingMessage, socket: Socket, head: Buffer) => void,
    ): void;
    addListener(event: "timeout" | "close" | "finish" | "abort", listener: () => void): void;
    addListener(event: "error", listener: (err: Error) => void): void;
    once(event: "response", listener: (res: IncomingMessage) => void): void;
    once(event: "socket", listener: (socket: Socket) => void): void;
    once(
      event: "upgrade",
      listener: (res: IncomingMessage, socket: Socket, head: Buffer) => void,
    ): void;
    once(event: "timeout" | "close" | "finish" | "abort" | "continue", listener: () => void): void;
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
  export function validateHeaderName(name: string, label?: string): void;
  export function validateHeaderValue(name: string, value: unknown): void;
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
 * without emitting an event, Node's default for 'tlsClientError' with no listener. */
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
    secureConnectionListener?: (socket: TLSSocket) => void,
  ): Server;
  /** TLSSocket — post-handshake it IS a net socket to every lowered
   * member (the mapping collapses it onto the socket kind; the
   * secureConnect/session events ride the shared socket declarations).
   * The TLS extras: authorized/authorizationError answer Node's verify
   * split — authorizationError is the verify-failure CODE STRING
   * (DEPTH_ZERO_SELF_SIGNED_CERT, ...), or null. */
  export interface TLSSocket extends Socket {
    readonly encrypted: true;
    authorized: boolean;
    authorizationError: string | null;
    /* null before the handshake, then the negotiated protocol or false */
    readonly alpnProtocol: string | false | null;
    /* "TLSv1.2" or "TLSv1.3"; null before the handshake and after close */
    getProtocol(): string | null;
    /* OpenSSL's suite name, the IANA name and the suite's version */
    getCipher(): CipherNameAndProtocol;
    /* whether the handshake resumed a cached session */
    isSessionReused(): boolean;
  }
  /** new tls.TLSSocket(socket, options): the server-mode wrap of an open
   * socket (a server connection or an http CONNECT socket). The options
   * record reads at runtime; isServer, cert, key, secureContext,
   * ALPNProtocols, minVersion and maxVersion are implemented. */
  export interface TLSSocketOptions {
    isServer?: boolean;
    cert?: string | Uint8Array;
    key?: string | Uint8Array;
    secureContext?: SecureContext;
    ALPNProtocols?: string[] | Uint8Array;
    minVersion?: string;
    maxVersion?: string;
    [option: string]: unknown;
  }
  export const TLSSocket: new (socket: Socket, options: TLSSocketOptions) => TLSSocket;
  export interface CipherNameAndProtocol {
    name: string;
    standardName: string;
    version: string;
  }
  export const DEFAULT_MIN_VERSION: string;
  export const DEFAULT_MAX_VERSION: string;
  /** tls.connect options — the RUNTIME options record (members read at
   * runtime; port/host/socket/rejectUnauthorized/ca/servername are the
   * honestly-implemented set, every other documented member throws the
   * runtime fence — the options-record stance's divergence-66 shape). */
  export interface ConnectionOptions {
    port?: number;
    host?: string;
    /* an open socket to run the client handshake over */
    socket?: Socket;
    rejectUnauthorized?: boolean;
    ca?: string | Uint8Array | ReadonlyArray<string | Uint8Array>;
    servername?: string;
    [option: string]: unknown;
  }
  export function connect(
    options: ConnectionOptions,
    secureConnectListener?: () => void,
  ): TLSSocket;
  export function connect(
    port: number,
    options?: ConnectionOptions,
    secureConnectListener?: () => void,
  ): TLSSocket;
  export function connect(
    port: number,
    host?: string,
    options?: ConnectionOptions,
    secureConnectListener?: () => void,
  ): TLSSocket;
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
  /* Node's keepAlive global agent for requests without an agent option. */
  export const globalAgent: Agent;
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
    /* Aborting destroys the request with an AbortError. */
    signal?: AbortSignal;
    socketPath?: string;
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
    addListener(event: "error" | "close", listener: (err: Error) => void): void;
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
    readonly writableEnded: boolean;
    readonly writableCorked: number;
    /* The same lowered surface as http.ServerResponse — the allowHTTP1
     * lowering serves every connection as HTTP/1.1, where the compat
     * response IS this parser's response handle. */
    statusCode: number;
    statusMessage: string;
    setHeader(name: string, value: string | number): void;
    getHeader(name: string): string | undefined;
    getHeaderNames(): string[];
    getRawHeaderNames(): string[];
    getHeaders(): import("http").OutgoingHttpHeaders;
    hasHeader(name: string): boolean;
    removeHeader(name: string): void;
    writeHead(
      statusCode: number,
      headers?: import("http").OutgoingHttpHeaders | string[],
    ): Http2ServerResponse;
    writeHead(
      statusCode: number,
      statusMessage: string,
      headers?: import("http").OutgoingHttpHeaders | string[],
    ): Http2ServerResponse;
    writeContinue(): void;
    writeEarlyHints(hints: Record<string, string | string[]>): void;
    write(data: string | Uint8Array): void;
    flushHeaders(): void;
    cork(): void;
    uncork(): void;
    addTrailers(
      headers: import("http").OutgoingHttpHeaders | ReadonlyArray<[string, string]>,
    ): void;
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
    on(
      event: "request",
      listener: (req: Http2ServerRequest, res: Http2ServerResponse) => void,
    ): void;
    on(event: "error", listener: (err: Error) => void): void;
    on(event: "close", listener: () => void): void;
    on(event: "sessionError", listener: (err: Error, session: ServerHttp2Session) => void): void;
    /* The ALPN=h2 server's surface (createSecureServer WITHOUT
     * allowHTTP1 — the real h2-over-TLS stack): per-stream and
     * per-session listeners, exactly the h2c server's. */
    on(
      event: "stream",
      listener: (stream: ServerHttp2Stream, headers: IncomingHttpHeaders, flags: number) => void,
    ): void;
    on(event: "session", listener: (session: ServerHttp2Session) => void): void;
    /* HTTP CONNECT (and, in Node, the h2 extended CONNECT — which the
     * allowHTTP1 lowering never sees): the second argument is the raw
     * socket on HTTP/1.1 connections; narrow with instanceof. */
    on(
      event: "connect",
      listener: (
        req: Http2ServerRequest | import("http").IncomingMessage,
        resOrSocket: Http2ServerResponse | Socket,
      ) => void,
    ): void;
    once(event: "connection", listener: (socket: Socket) => void): void;
    once(
      event: "request",
      listener: (req: Http2ServerRequest, res: Http2ServerResponse) => void,
    ): void;
    once(event: "error", listener: (err: Error) => void): void;
    once(event: "close", listener: () => void): void;
    once(event: "sessionError", listener: (err: Error, session: ServerHttp2Session) => void): void;
    once(
      event: "stream",
      listener: (stream: ServerHttp2Stream, headers: IncomingHttpHeaders, flags: number) => void,
    ): void;
    once(event: "session", listener: (session: ServerHttp2Session) => void): void;
    once(
      event: "connect",
      listener: (
        req: Http2ServerRequest | import("http").IncomingMessage,
        resOrSocket: Http2ServerResponse | Socket,
      ) => void,
    ): void;
    addListener(event: "connection", listener: (socket: Socket) => void): void;
    addListener(
      event: "request",
      listener: (req: Http2ServerRequest, res: Http2ServerResponse) => void,
    ): void;
    addListener(event: "error", listener: (err: Error) => void): void;
    addListener(event: "close", listener: () => void): void;
    addListener(
      event: "sessionError",
      listener: (err: Error, session: ServerHttp2Session) => void,
    ): void;
    addListener(
      event: "stream",
      listener: (stream: ServerHttp2Stream, headers: IncomingHttpHeaders, flags: number) => void,
    ): void;
    addListener(event: "session", listener: (session: ServerHttp2Session) => void): void;
    addListener(
      event: "connect",
      listener: (
        req: Http2ServerRequest | import("http").IncomingMessage,
        resOrSocket: Http2ServerResponse | Socket,
      ) => void,
    ): void;
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
    onRequestHandler?: (
      req: import("http").IncomingMessage,
      res: import("http").ServerResponse,
    ) => void,
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
    on(
      event: "connect",
      listener: (session: Http2Session, socket: import("net").Socket) => void,
    ): void;
    on(
      event: "stream",
      listener: (stream: ServerHttp2Stream, headers: IncomingHttpHeaders, flags: number) => void,
    ): void;
    on(
      event: "goaway",
      listener: (errorCode: number, lastStreamID: number, opaqueData?: Uint8Array) => void,
    ): void;
    on(event: "localSettings" | "remoteSettings", listener: (settings: any) => void): void;
    on(event: "frameError", listener: (type: number, code: number, id: number) => void): void;
    on(event: "ping", listener: (payload: Uint8Array) => void): void;
    once(event: "close" | "timeout", listener: () => void): void;
    once(event: "error", listener: (err: Error) => void): void;
    once(
      event: "connect",
      listener: (session: Http2Session, socket: import("net").Socket) => void,
    ): void;
    once(
      event: "stream",
      listener: (stream: ServerHttp2Stream, headers: IncomingHttpHeaders, flags: number) => void,
    ): void;
    once(
      event: "goaway",
      listener: (errorCode: number, lastStreamID: number, opaqueData?: Uint8Array) => void,
    ): void;
    once(event: "localSettings" | "remoteSettings", listener: (settings: any) => void): void;
    once(event: "frameError", listener: (type: number, code: number, id: number) => void): void;
    once(event: "ping", listener: (payload: Uint8Array) => void): void;
    addListener(event: "close" | "timeout", listener: () => void): void;
    addListener(event: "error", listener: (err: Error) => void): void;
    addListener(
      event: "connect",
      listener: (session: Http2Session, socket: import("net").Socket) => void,
    ): void;
    addListener(
      event: "stream",
      listener: (stream: ServerHttp2Stream, headers: IncomingHttpHeaders, flags: number) => void,
    ): void;
    addListener(
      event: "goaway",
      listener: (errorCode: number, lastStreamID: number, opaqueData?: Uint8Array) => void,
    ): void;
    addListener(event: "localSettings" | "remoteSettings", listener: (settings: any) => void): void;
    addListener(
      event: "frameError",
      listener: (type: number, code: number, id: number) => void,
    ): void;
    addListener(event: "ping", listener: (payload: Uint8Array) => void): void;
  }

  export interface ClientHttp2Session extends Http2Session {
    request(
      headers?: OutgoingHttpHeaders,
      options?: {
        endStream?: boolean;
        exclusive?: boolean;
        parent?: number;
        weight?: number;
        waitForTrailers?: boolean;
      },
    ): ClientHttp2Stream;
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
    on(
      event:
        | "end"
        | "close"
        | "aborted"
        | "ready"
        | "timeout"
        | "drain"
        | "finish"
        | "wantTrailers",
      listener: () => void,
    ): void;
    on(event: "error", listener: (err: Error) => void): void;
    on(event: "frameError", listener: (type: number, code: number, id: number) => void): void;
    on(event: "trailers", listener: (trailers: IncomingHttpHeaders, flags: number) => void): void;
    once(event: "data", listener: (chunk: any) => void): void;
    once(
      event:
        | "end"
        | "close"
        | "aborted"
        | "ready"
        | "timeout"
        | "drain"
        | "finish"
        | "wantTrailers",
      listener: () => void,
    ): void;
    once(event: "error", listener: (err: Error) => void): void;
    once(event: "frameError", listener: (type: number, code: number, id: number) => void): void;
    once(event: "trailers", listener: (trailers: IncomingHttpHeaders, flags: number) => void): void;
    addListener(event: "data", listener: (chunk: any) => void): void;
    addListener(
      event:
        | "end"
        | "close"
        | "aborted"
        | "ready"
        | "timeout"
        | "drain"
        | "finish"
        | "wantTrailers",
      listener: () => void,
    ): void;
    addListener(event: "error", listener: (err: Error) => void): void;
    addListener(
      event: "frameError",
      listener: (type: number, code: number, id: number) => void,
    ): void;
    addListener(
      event: "trailers",
      listener: (trailers: IncomingHttpHeaders, flags: number) => void,
    ): void;
    respond(
      headers?: OutgoingHttpHeaders,
      options?: { endStream?: boolean; waitForTrailers?: boolean },
    ): void;
    respondWithFile(
      path: string,
      headers?: OutgoingHttpHeaders,
      options?: Record<string, unknown>,
    ): void;
    respondWithFD(
      fd: number,
      headers?: OutgoingHttpHeaders,
      options?: Record<string, unknown>,
    ): void;
    pushStream(
      headers: OutgoingHttpHeaders,
      callback: (
        err: Error | null,
        pushStream: ServerHttp2Stream,
        headers: OutgoingHttpHeaders,
      ) => void,
    ): void;
    readonly headersSent: boolean;
    readonly pushAllowed: boolean;
    additionalHeaders(headers: OutgoingHttpHeaders): void;
  }

  export interface ClientHttp2Stream extends Http2StreamCore {
    on(event: "response", listener: (headers: IncomingHttpHeaders, flags: number) => void): void;
    on(event: "push", listener: (headers: IncomingHttpHeaders, flags: number) => void): void;
    on(event: "headers", listener: (headers: IncomingHttpHeaders, flags: number) => void): void;
    on(event: "data", listener: (chunk: any) => void): void;
    on(
      event:
        | "end"
        | "close"
        | "aborted"
        | "ready"
        | "timeout"
        | "drain"
        | "finish"
        | "wantTrailers",
      listener: () => void,
    ): void;
    on(event: "error", listener: (err: Error) => void): void;
    on(event: "frameError", listener: (type: number, code: number, id: number) => void): void;
    on(event: "trailers", listener: (trailers: IncomingHttpHeaders, flags: number) => void): void;
    once(event: "response", listener: (headers: IncomingHttpHeaders, flags: number) => void): void;
    once(event: "push", listener: (headers: IncomingHttpHeaders, flags: number) => void): void;
    once(event: "headers", listener: (headers: IncomingHttpHeaders, flags: number) => void): void;
    once(event: "data", listener: (chunk: any) => void): void;
    once(
      event:
        | "end"
        | "close"
        | "aborted"
        | "ready"
        | "timeout"
        | "drain"
        | "finish"
        | "wantTrailers",
      listener: () => void,
    ): void;
    once(event: "error", listener: (err: Error) => void): void;
    once(event: "frameError", listener: (type: number, code: number, id: number) => void): void;
    once(event: "trailers", listener: (trailers: IncomingHttpHeaders, flags: number) => void): void;
    addListener(
      event: "response",
      listener: (headers: IncomingHttpHeaders, flags: number) => void,
    ): void;
    addListener(
      event: "push",
      listener: (headers: IncomingHttpHeaders, flags: number) => void,
    ): void;
    addListener(
      event: "headers",
      listener: (headers: IncomingHttpHeaders, flags: number) => void,
    ): void;
    addListener(event: "data", listener: (chunk: any) => void): void;
    addListener(
      event:
        | "end"
        | "close"
        | "aborted"
        | "ready"
        | "timeout"
        | "drain"
        | "finish"
        | "wantTrailers",
      listener: () => void,
    ): void;
    addListener(event: "error", listener: (err: Error) => void): void;
    addListener(
      event: "frameError",
      listener: (type: number, code: number, id: number) => void,
    ): void;
    addListener(
      event: "trailers",
      listener: (trailers: IncomingHttpHeaders, flags: number) => void,
    ): void;
  }

  export interface Http2Server {
    listen(port?: number, callback?: () => void): void;
    listen(port: number, host: string, callback?: () => void): void;
    close(callback?: () => void): void;
    address(): import("node:dgram").AddressInfo;
    setTimeout(msecs?: number, callback?: () => void): void;
    ref(): void;
    unref(): void;
    on(
      event: "stream",
      listener: (stream: ServerHttp2Stream, headers: IncomingHttpHeaders, flags: number) => void,
    ): void;
    on(event: "session", listener: (session: ServerHttp2Session) => void): void;
    on(
      event: "request",
      listener: (req: Http2ServerRequest, res: Http2ServerResponse) => void,
    ): void;
    on(event: "error", listener: (err: Error) => void): void;
    on(event: "close" | "listening" | "timeout", listener: () => void): void;
    on(event: "connection", listener: (socket: import("net").Socket) => void): void;
    on(event: "sessionError", listener: (err: Error, session: ServerHttp2Session) => void): void;
    once(
      event: "stream",
      listener: (stream: ServerHttp2Stream, headers: IncomingHttpHeaders, flags: number) => void,
    ): void;
    once(event: "session", listener: (session: ServerHttp2Session) => void): void;
    once(
      event: "request",
      listener: (req: Http2ServerRequest, res: Http2ServerResponse) => void,
    ): void;
    once(event: "error", listener: (err: Error) => void): void;
    once(event: "close" | "listening" | "timeout", listener: () => void): void;
    once(event: "connection", listener: (socket: import("net").Socket) => void): void;
    once(event: "sessionError", listener: (err: Error, session: ServerHttp2Session) => void): void;
    addListener(
      event: "stream",
      listener: (stream: ServerHttp2Stream, headers: IncomingHttpHeaders, flags: number) => void,
    ): void;
    addListener(event: "session", listener: (session: ServerHttp2Session) => void): void;
    addListener(
      event: "request",
      listener: (req: Http2ServerRequest, res: Http2ServerResponse) => void,
    ): void;
    addListener(event: "error", listener: (err: Error) => void): void;
    addListener(event: "close" | "listening" | "timeout", listener: () => void): void;
    addListener(event: "connection", listener: (socket: import("net").Socket) => void): void;
    addListener(
      event: "sessionError",
      listener: (err: Error, session: ServerHttp2Session) => void,
    ): void;
  }

  export interface ServerOptions {
    [option: string]: unknown;
  }

  export function createServer(
    onRequestHandler?: (req: Http2ServerRequest, res: Http2ServerResponse) => void,
  ): Http2Server;
  export function createServer(
    options: ServerOptions,
    onRequestHandler?: (req: Http2ServerRequest, res: Http2ServerResponse) => void,
  ): Http2Server;

  export function connect(
    authority: string,
    listener?: (session: ClientHttp2Session, socket: import("net").Socket) => void,
  ): ClientHttp2Session;
  export function connect(
    authority: string,
    options: Record<string, unknown>,
    listener?: (session: ClientHttp2Session, socket: import("net").Socket) => void,
  ): ClientHttp2Session;

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
 * like Node. The socket options throw Node's errors (EBADF before bind);
 * add/dropMembership before bind is refused at run time (SC2020). 'error'
 * with no listener exits 1 (the unhandled EventEmitter 'error' behavior). */
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
    disconnect(): void;
    unref(): void;
    ref(): void;
    setBroadcast(flag: boolean): void;
    setTTL(ttl: number): number;
    setMulticastTTL(ttl: number): number;
    setMulticastLoopback(flag: boolean): boolean;
    setMulticastInterface(multicastInterface: string): void;
    addMembership(multicastAddress: string, multicastInterface?: string): void;
    dropMembership(multicastAddress: string, multicastInterface?: string): void;
    getRecvBufferSize(): number;
    getSendBufferSize(): number;
    setRecvBufferSize(size: number): void;
    setSendBufferSize(size: number): void;
    getSendQueueSize(): number;
    getSendQueueCount(): number;
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
  export interface LookupAddress {
    address: string;
    family: number;
  }
  export interface LookupOptions {
    family?: number | "IPv4" | "IPv6";
    hints?: number;
    all?: boolean;
    order?: "ipv4first" | "ipv6first" | "verbatim";
    verbatim?: boolean;
  }
  export interface LookupOneOptions extends LookupOptions {
    all?: false;
  }
  export interface LookupAllOptions extends LookupOptions {
    all: true;
  }
  /* The callback comes with the other lookup deliveries (literal
   * addresses on the next tick); the options follow lib/dns.js. */
  export function lookup(
    hostname: string,
    callback: (err: NodeJS.ErrnoException | null, address: string, family: number) => void,
  ): void;
  export function lookup(
    hostname: string,
    family: number,
    callback: (err: NodeJS.ErrnoException | null, address: string, family: number) => void,
  ): void;
  export function lookup(
    hostname: string,
    options: LookupOneOptions,
    callback: (err: NodeJS.ErrnoException | null, address: string, family: number) => void,
  ): void;
  export function lookup(
    hostname: string,
    options: LookupAllOptions,
    callback: (err: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void,
  ): void;
  /* getnameinfo with NI_NAMEREQD: the host's name and the port's service
   * name (the number when it has none). */
  export function lookupService(
    address: string,
    port: number,
    callback: (err: NodeJS.ErrnoException | null, hostname: string, service: string) => void,
  ): void;
  /* The nameservers /etc/resolv.conf lists. */
  export function getServers(): string[];
  export function getDefaultResultOrder(): "ipv4first" | "ipv6first" | "verbatim";
  export function setDefaultResultOrder(order: "ipv4first" | "ipv6first" | "verbatim"): void;
  /* The promise forms (node:dns/promises). */
  export const promises: typeof import("dns/promises");
}
declare module "node:dns" {
  export * from "dns";
}
/* node:dns/promises — lookup and lookupService as promises over the same
 * resolution as the callback forms: argument errors throw synchronously,
 * failures reject with the callbacks' errors. */
declare module "dns/promises" {
  import type { LookupAddress, LookupAllOptions, LookupOneOptions, LookupOptions } from "dns";
  export function lookup(hostname: string, family: number): Promise<LookupAddress>;
  export function lookup(hostname: string, options: LookupOneOptions): Promise<LookupAddress>;
  export function lookup(hostname: string, options: LookupAllOptions): Promise<LookupAddress[]>;
  export function lookup(
    hostname: string,
    options: LookupOptions,
  ): Promise<LookupAddress | LookupAddress[]>;
  export function lookup(hostname: string): Promise<LookupAddress>;
  export function lookupService(
    address: string,
    port: number,
  ): Promise<{ hostname: string; service: string }>;
  export function getServers(): string[];
  export function getDefaultResultOrder(): "ipv4first" | "ipv6first" | "verbatim";
  export function setDefaultResultOrder(order: "ipv4first" | "ipv6first" | "verbatim"): void;
}
declare module "node:dns/promises" {
  export * from "dns/promises";
}

/* node:v8 — importable for the packages that require it at top level.
 * getHeapStatistics answers allocator-derived figures in Node's shape
 * (approximate: the runtime heap's total and used bytes, the machine's
 * memory as the limit; V8-only figures are 0). The other members observe
 * V8 itself and fence at their use with the by-design reason; they are
 * declared so programs that type-check under their own tsc reach that
 * fence. */
declare module "v8" {
  type DoesZapCodeSpaceFlag = 0 | 1;
  export interface HeapInfo {
    total_heap_size: number;
    total_heap_size_executable: number;
    total_physical_size: number;
    total_available_size: number;
    used_heap_size: number;
    heap_size_limit: number;
    malloced_memory: number;
    peak_malloced_memory: number;
    does_zap_garbage: DoesZapCodeSpaceFlag;
    number_of_native_contexts: number;
    number_of_detached_contexts: number;
    total_global_handles_size: number;
    used_global_handles_size: number;
    external_memory: number;
  }
  export function getHeapStatistics(): HeapInfo;
  export function cachedDataVersionTag(): number;
  export function getHeapSpaceStatistics(): unknown[];
  export function getHeapCodeStatistics(): unknown;
  export function getHeapSnapshot(options?: unknown): unknown;
  export function writeHeapSnapshot(fileName?: string, options?: unknown): string;
  export function setFlagsFromString(flags: string): void;
  export function setHeapSnapshotNearHeapLimit(limit: number): void;
  export function serialize(value: unknown): Buffer;
  export function deserialize(buffer: Uint8Array): unknown;
  export function takeCoverage(): void;
  export function stopCoverage(): void;
  export function isStringOneByteRepresentation(content: string): boolean;
}
declare module "node:v8" {
  export * from "v8";
}

/* node:worker_threads — native workers use statically compiled entry points.
 * Lowering and runtime diagnostics define the supported options and methods. */
declare module "worker_threads" {
  export const isMainThread: boolean;
  export const isInternalThread: boolean;
  export const threadId: number;
  export interface ResourceLimits {
    maxYoungGenerationSizeMb?: number;
    maxOldGenerationSizeMb?: number;
    codeRangeSizeMb?: number;
    stackSizeMb?: number;
  }
  /* {} in the main thread */
  export const resourceLimits: ResourceLimits;
  /* the Worker's name option, trimmed ("WorkerThread" by default); "" in the main thread */
  export const threadName: string | null;
  export interface WorkerOptions {
    workerData?: unknown;
    transferList?: readonly unknown[];
    argv?: readonly unknown[];
    name?: string;
    resourceLimits?: ResourceLimits;
    stdout?: boolean;
    stderr?: boolean;
    stdin?: boolean;
    [option: string]: unknown;
  }
  export class Worker {
    constructor(filename: string | URL, options?: WorkerOptions);
    readonly threadId: number;
    readonly resourceLimits?: ResourceLimits;
    readonly threadName: string | null;
    /* with the stdout/stderr options: the worker's writes to those streams */
    readonly stdout: import("stream").Readable;
    readonly stderr: import("stream").Readable;
    /* with the stdin option: what the worker reads from process.stdin */
    readonly stdin: import("stream").Writable | null;
    /* terminate(), resolving with undefined once the worker exited */
    [Symbol.asyncDispose](): Promise<void>;
    on(event: "online", listener: () => void): this;
    on(event: "message", listener: (value: any) => void): this;
    on(event: "error", listener: (error: any) => void): this;
    on(event: "exit", listener: (code: number) => void): this;
    on(event: string, listener: (...args: any[]) => void): this;
    once(event: string, listener: (...args: any[]) => void): this;
    off(event: string, listener: (...args: any[]) => void): this;
    addListener(event: string, listener: (...args: any[]) => void): this;
    removeListener(event: string, listener: (...args: any[]) => void): this;
    prependListener(event: string, listener: (...args: any[]) => void): this;
    prependOnceListener(event: string, listener: (...args: any[]) => void): this;
    postMessage(value: unknown, transferList?: readonly unknown[]): void;
    ref(): void;
    unref(): void;
    terminate(): Promise<number>;
    removeAllListeners(event?: string): this;
    listenerCount(event: string, listener?: (...args: any[]) => void): number;
  }
  export class MessagePort {
    on(event: "message", listener: (value: any) => void): this;
    on(event: "close", listener: () => void): this;
    on(event: string, listener: (...args: any[]) => void): this;
    once(event: string, listener: (...args: any[]) => void): this;
    off(event: string, listener: (...args: any[]) => void): this;
    addListener(event: string, listener: (...args: any[]) => void): this;
    removeListener(event: string, listener: (...args: any[]) => void): this;
    prependListener(event: string, listener: (...args: any[]) => void): this;
    prependOnceListener(event: string, listener: (...args: any[]) => void): this;
    postMessage(value: unknown, transferList?: readonly unknown[]): void;
    start(): void;
    close(callback?: () => void): void;
    ref(): void;
    unref(): void;
    hasRef(): boolean;
    removeAllListeners(event?: string): this;
    listenerCount(event: string, listener?: (...args: any[]) => void): number;
  }
  /* Two entangled ports; a port moves to another thread through a
   * postMessage or workerData transferList. */
  export class MessageChannel {
    readonly port1: MessagePort;
    readonly port2: MessagePort;
  }
  export function receiveMessageOnPort(port: MessagePort): { message: any } | undefined;
  /* This thread's environment data; each new Worker starts from a clone. */
  export function setEnvironmentData(key: any, value?: any): void;
  export function getEnvironmentData(key: any): any;
  /* A marked object cannot be listed in a transfer list. */
  export function markAsUntransferable(object: any): void;
  /* structuredClone and postMessage throw DataCloneError for a marked
   * object, error or class instance */
  export function markAsUncloneable(object: any): void;
  export function isMarkedAsUntransferable(object: any): boolean;
  /* Delivers each message to every other open channel with the name, in
   * any thread, as a 'message' MessageEvent. */
  export class BroadcastChannel extends EventTarget {
    constructor(name: string);
    readonly name: string;
    onmessage: ((event: MessageEvent) => void) | null;
    onmessageerror: ((event: MessageEvent) => void) | null;
    postMessage(message: unknown): void;
    close(): void;
    ref(): this;
    unref(): this;
  }
  export const parentPort: MessagePort | null;
  export const workerData: any;
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
  export function isAscii(input: ArrayBuffer | ArrayBufferView): boolean;
  export function isUtf8(input: ArrayBuffer | ArrayBufferView): boolean;
  export function transcode(source: Uint8Array, fromEncoding: string, toEncoding: string): Buffer;
  export function atob(data: string): string;
  export function btoa(data: string): string;
  export const kMaxLength: number;
  export const kStringMaxLength: number;
  export const Buffer: BufferConstructor;
  export type Blob = globalThis.Blob;
  export type File = globalThis.File;
  export const Blob: typeof globalThis.Blob;
  export const File: typeof globalThis.File;
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

/* node:tty — the fd probe (the same isatty(3) behind process.*.isTTY)
 * and the supported structural view of a process output stream. */
declare module "tty" {
  export interface WriteStream extends NodeJS.WritableStream {
    write(data: string | Uint8Array, callback?: (error?: Error | null) => void): boolean;
    write(
      data: string | Uint8Array,
      encoding: BufferEncoding,
      callback?: (error?: Error | null) => void,
    ): boolean;
    readonly isTTY: boolean;
    readonly columns: number;
    readonly rows: number;
    getWindowSize(): [number, number];
  }
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
    /* Listeners registered under this symbol observe 'error' emits first
     * (an emit with no 'error' listener still throws). */
    static readonly errorMonitor: unique symbol;
    static addAbortListener(signal: AbortSignal, listener: (event: Event) => void): Disposable;
    on(eventName: string | symbol, listener: (...args: any[]) => void): this;
    addListener(eventName: string | symbol, listener: (...args: any[]) => void): this;
    once(eventName: string | symbol, listener: (...args: any[]) => void): this;
    prependListener(eventName: string | symbol, listener: (...args: any[]) => void): this;
    prependOnceListener(eventName: string | symbol, listener: (...args: any[]) => void): this;
    off(eventName: string | symbol, listener: (...args: any[]) => void): this;
    removeListener(eventName: string | symbol, listener: (...args: any[]) => void): this;
    removeAllListeners(eventName?: string | symbol): this;
    emit(eventName: string | symbol, ...args: any[]): boolean;
    listenerCount(eventName: string | symbol, listener?: (...args: any[]) => void): number;
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
    // The event's arguments, as checked-dynamic values.
    export function once(
      emitter: EventEmitter | NodeJS.ReadableStream | NodeJS.WritableStream,
      eventName: string,
      options?: { signal?: AbortSignal },
    ): Promise<unknown[]>;
    /* The emitter's own listenerCount/getMaxListeners/setMaxListeners/
     * listeners, over EventEmitter instances. */
    export function listenerCount(emitter: EventEmitter, eventName: string | symbol): number;
    export function getMaxListeners(emitter: EventEmitter): number;
    export function setMaxListeners(n?: number, ...eventTargets: EventEmitter[]): void;
    export function getEventListeners(emitter: EventEmitter, name: string): Array<() => void>;
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
 * strings converted at push/write like Node, and any value on an
 * object-mode side (objectMode, readableObjectMode, writableObjectMode —
 * the object-mode constructor overloads come first). The runtime-fired
 * events carry per-class FORCED argument tuples ('data' is one chunk,
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
    signal?: AbortSignal;
  }
  interface WritableOptions {
    highWaterMark?: number;
    decodeStrings?: boolean;
    defaultEncoding?: string;
    objectMode?: boolean;
    write?(
      this: Writable,
      chunk: Buffer,
      encoding: string,
      callback: (error?: Error | null) => void,
    ): void;
    writev?(
      this: Writable,
      chunks: Array<{ chunk: any; encoding: string }>,
      callback: (error?: Error | null) => void,
    ): void;
    final?(this: Writable, callback: (error?: Error | null) => void): void;
    destroy?(this: Writable, error: Error | null, callback: (error?: Error | null) => void): void;
    construct?(this: Writable, callback: (error?: Error | null) => void): void;
    autoDestroy?: boolean;
    emitClose?: boolean;
    captureRejections?: boolean;
    signal?: AbortSignal;
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
    write?(
      this: Duplex,
      chunk: Buffer,
      encoding: string,
      callback: (error?: Error | null) => void,
    ): void;
    final?(this: Duplex, callback: (error?: Error | null) => void): void;
    destroy?(this: Duplex, error: Error | null, callback: (error?: Error | null) => void): void;
    construct?(this: Duplex, callback: (error?: Error | null) => void): void;
    autoDestroy?: boolean;
    emitClose?: boolean;
    captureRejections?: boolean;
    readable?: boolean;
    writable?: boolean;
    defaultEncoding?: string;
    writev?(
      this: Duplex,
      chunks: Array<{ chunk: any; encoding: string }>,
      callback: (error?: Error | null) => void,
    ): void;
    signal?: AbortSignal;
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
    transform?(
      this: Transform,
      chunk: Buffer,
      encoding: string,
      callback: (error?: Error | null, data?: Buffer | string) => void,
    ): void;
    flush?(this: Transform, callback: (error?: Error | null, data?: Buffer | string) => void): void;
    destroy?(this: Transform, error: Error | null, callback: (error?: Error | null) => void): void;
    construct?(this: Transform, callback: (error?: Error | null) => void): void;
    read?(this: Transform, size: number): void;
    write?(
      this: Transform,
      chunk: Buffer,
      encoding: string,
      callback: (error?: Error | null) => void,
    ): void;
    final?(this: Transform, callback: (error?: Error | null) => void): void;
    writev?(this: Transform, chunks: unknown[], callback: (error?: Error | null) => void): void;
    autoDestroy?: boolean;
    emitClose?: boolean;
    captureRejections?: boolean;
    readable?: boolean;
    writable?: boolean;
    defaultEncoding?: string;
    signal?: AbortSignal;
  }

  /* Object-mode options (objectMode: true, or a Duplex's or Transform's
   * readableObjectMode / writableObjectMode): chunks and completion data
   * are any values, and an object-mode write's encoding argument reaches
   * write/transform as passed (undefined when absent, null when a
   * callback took its place). The constructors take these before the
   * byte-mode options, so a byte-mode stream's callbacks keep Buffer
   * chunks. */
  type ObjectModeEncoding = string | null | undefined;
  type ObjectModeFlag =
    | { objectMode: true }
    | { readableObjectMode: true }
    | { writableObjectMode: true };
  interface ObjectWritableOptions extends Omit<WritableOptions, "objectMode" | "write"> {
    objectMode: true;
    write?(
      this: Writable,
      chunk: any,
      encoding: ObjectModeEncoding,
      callback: (error?: Error | null) => void,
    ): void;
  }
  type ObjectDuplexOptions = Omit<DuplexOptions, "write"> & {
    write?(
      this: Duplex,
      chunk: any,
      encoding: ObjectModeEncoding,
      callback: (error?: Error | null) => void,
    ): void;
  } & ObjectModeFlag;
  type ObjectTransformOptions = Omit<TransformOptions, "transform" | "flush" | "write"> & {
    transform?(
      this: Transform,
      chunk: any,
      encoding: ObjectModeEncoding,
      callback: (error?: Error | null, data?: any) => void,
    ): void;
    flush?(this: Transform, callback: (error?: Error | null, data?: any) => void): void;
    write?(
      this: Transform,
      chunk: any,
      encoding: ObjectModeEncoding,
      callback: (error?: Error | null) => void,
    ): void;
  } & ObjectModeFlag;

  /* decodeStrings: false — a string write reaches write/transform as the
   * string with its encoding (Buffers keep 'buffer'). */
  interface StringWritableOptions extends Omit<WritableOptions, "decodeStrings" | "write"> {
    decodeStrings: false;
    write?(
      this: Writable,
      chunk: string | Buffer,
      encoding: string,
      callback: (error?: Error | null) => void,
    ): void;
  }
  type StringDuplexOptions = Omit<DuplexOptions, "decodeStrings" | "write"> & {
    decodeStrings: false;
    write?(
      this: Duplex,
      chunk: string | Buffer,
      encoding: string,
      callback: (error?: Error | null) => void,
    ): void;
  };
  type StringTransformOptions = Omit<TransformOptions, "decodeStrings" | "transform"> & {
    decodeStrings: false;
    transform?(
      this: Transform,
      chunk: string | Buffer,
      encoding: string,
      callback: (error?: Error | null, data?: Buffer | string) => void,
    ): void;
  };

  /* The operators' options: concurrency and highWaterMark bound map's
   * in-flight callbacks and queued results. */
  interface ArrayOptions {
    concurrency?: number;
    highWaterMark?: number;
    signal?: AbortSignal;
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
    iterator(options?: { destroyOnReturn?: boolean }): AsyncIterableIterator<any>;
    /* compose(this, stage), destroyed when options.signal aborts. */
    compose(stage: ComposeStage, options?: { signal: AbortSignal }): Duplex;
    push(chunk: Buffer | string | null, encoding?: string): boolean;
    /* An object-mode stream's values. */
    push(chunk: any, encoding?: string): boolean;
    unshift(chunk: Buffer | string, encoding?: string): void;
    unshift(chunk: any, encoding?: string): void;
    /* A Buffer, a string once encoded, an object-mode value, or null (as
     * @types/node types it). */
    read(size?: number): any;
    pause(): this;
    resume(): this;
    isPaused(): boolean;
    setEncoding(encoding: string): this;
    pipe<T extends NodeJS.WritableStream>(destination: T, options?: { end?: boolean }): T;
    unpipe(destination?: NodeJS.WritableStream): this;
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
    /* A Readable over a web ReadableStream's reader. */
    static fromWeb(
      readableStream: globalThis.ReadableStream,
      options?: {
        encoding?: string;
        highWaterMark?: number;
        objectMode?: boolean;
        signal?: AbortSignal;
      },
    ): Readable;
    /* The Readable operators: chunks are strings or Buffers, map and
     * flatMap callbacks return strings or Buffers (flatMap: arrays of
     * them, or strings), and callbacks that declare the options argument
     * are refused. */
    map(
      fn: (data: any, options?: Pick<ArrayOptions, "signal">) => any,
      options?: ArrayOptions,
    ): Readable;
    filter(
      fn: (data: any, options?: Pick<ArrayOptions, "signal">) => boolean | Promise<boolean>,
      options?: ArrayOptions,
    ): Readable;
    forEach(
      fn: (data: any, options?: Pick<ArrayOptions, "signal">) => void | Promise<void>,
      options?: ArrayOptions,
    ): Promise<void>;
    toArray(options?: Pick<ArrayOptions, "signal">): Promise<any[]>;
    some(
      fn: (data: any, options?: Pick<ArrayOptions, "signal">) => boolean | Promise<boolean>,
      options?: ArrayOptions,
    ): Promise<boolean>;
    find(
      fn: (data: any, options?: Pick<ArrayOptions, "signal">) => boolean | Promise<boolean>,
      options?: ArrayOptions,
    ): Promise<any>;
    every(
      fn: (data: any, options?: Pick<ArrayOptions, "signal">) => boolean | Promise<boolean>,
      options?: ArrayOptions,
    ): Promise<boolean>;
    flatMap(
      fn: (data: any, options?: Pick<ArrayOptions, "signal">) => any,
      options?: ArrayOptions,
    ): Readable;
    drop(limit: number, options?: Pick<ArrayOptions, "signal">): Readable;
    take(limit: number, options?: Pick<ArrayOptions, "signal">): Readable;
    reduce<T = any>(
      fn: (previous: any, data: any, options?: Pick<ArrayOptions, "signal">) => T,
      initial?: undefined,
      options?: Pick<ArrayOptions, "signal">,
    ): Promise<T>;
    reduce<T = any>(
      fn: (previous: T, data: any, options?: Pick<ArrayOptions, "signal">) => T,
      initial: T,
      options?: Pick<ArrayOptions, "signal">,
    ): Promise<T>;
    on(event: "data", listener: (chunk: any) => void): this;
    on(event: "end" | "close" | "readable" | "pause" | "resume", listener: () => void): this;
    on(event: "error", listener: (err: Error) => void): this;
    on(event: string, listener: (...args: any[]) => void): this;
    once(event: "data", listener: (chunk: any) => void): this;
    once(event: "end" | "close" | "readable" | "pause" | "resume", listener: () => void): this;
    once(event: "error", listener: (err: Error) => void): this;
    once(event: string, listener: (...args: any[]) => void): this;
    addListener(event: "data", listener: (chunk: any) => void): this;
    addListener(
      event: "end" | "close" | "readable" | "pause" | "resume",
      listener: () => void,
    ): this;
    addListener(event: "error", listener: (err: Error) => void): this;
    addListener(event: string, listener: (...args: any[]) => void): this;
    prependListener(event: "data", listener: (chunk: any) => void): this;
    prependListener(
      event: "end" | "close" | "readable" | "pause" | "resume",
      listener: () => void,
    ): this;
    prependListener(event: "error", listener: (err: Error) => void): this;
    prependListener(event: string, listener: (...args: any[]) => void): this;
    prependOnceListener(event: "data", listener: (chunk: any) => void): this;
    prependOnceListener(
      event: "end" | "close" | "readable" | "pause" | "resume",
      listener: () => void,
    ): this;
    prependOnceListener(event: "error", listener: (err: Error) => void): this;
    prependOnceListener(event: string, listener: (...args: any[]) => void): this;
    off(event: "data", listener: (chunk: any) => void): this;
    off(event: "end" | "close" | "readable" | "pause" | "resume", listener: () => void): this;
    off(event: "error", listener: (err: Error) => void): this;
    off(event: string, listener: (...args: any[]) => void): this;
    removeListener(event: "data", listener: (chunk: any) => void): this;
    removeListener(
      event: "end" | "close" | "readable" | "pause" | "resume",
      listener: () => void,
    ): this;
    removeListener(event: "error", listener: (err: Error) => void): this;
    removeListener(event: string, listener: (...args: any[]) => void): this;
  }

  class Writable extends EventEmitter {
    constructor(opts: ObjectWritableOptions);
    constructor(opts: StringWritableOptions);
    constructor(opts?: WritableOptions);
    /* The underscore-method surface (see Readable). */
    _write(chunk: any, encoding: string, callback: (error?: Error | null) => void): void;
    _writev(
      chunks: Array<{ chunk: any; encoding: string }>,
      callback: (error?: Error | null) => void,
    ): void;
    _final(callback: (error?: Error | null) => void): void;
    _destroy(error: Error | null, callback: (error?: Error | null) => void): void;
    write(chunk: Buffer | string, callback?: (error?: Error | null) => void): boolean;
    write(
      chunk: Buffer | string,
      encoding: string,
      callback?: (error?: Error | null) => void,
    ): boolean;
    /* An object-mode stream's values (the encoding argument reaches
     * _write as passed). */
    write(chunk: any, callback?: (error?: Error | null) => void): boolean;
    write(
      chunk: any,
      encoding: ObjectModeEncoding,
      callback?: (error?: Error | null) => void,
    ): boolean;
    end(callback?: () => void): this;
    end(chunk: Buffer | string, callback?: () => void): this;
    end(chunk: Buffer | string, encoding: string, callback?: () => void): this;
    end(chunk: any, callback?: () => void): this;
    end(chunk: any, encoding: ObjectModeEncoding, callback?: () => void): this;
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
    /* Duplex.from: an async generator function, an iterable, a string or
     * a stream (duplexify.js). */
    static from(body: unknown): Duplex;
    constructor(opts: ObjectDuplexOptions);
    constructor(opts: StringDuplexOptions);
    constructor(opts?: DuplexOptions);
    /* The underscore-method surface (see Readable). */
    _write(chunk: any, encoding: string, callback: (error?: Error | null) => void): void;
    _writev(
      chunks: Array<{ chunk: any; encoding: string }>,
      callback: (error?: Error | null) => void,
    ): void;
    _final(callback: (error?: Error | null) => void): void;
    write(chunk: Buffer | string, callback?: (error?: Error | null) => void): boolean;
    write(
      chunk: Buffer | string,
      encoding: string,
      callback?: (error?: Error | null) => void,
    ): boolean;
    /* An object-mode stream's values (the encoding argument reaches
     * _write as passed). */
    write(chunk: any, callback?: (error?: Error | null) => void): boolean;
    write(
      chunk: any,
      encoding: ObjectModeEncoding,
      callback?: (error?: Error | null) => void,
    ): boolean;
    end(callback?: () => void): this;
    end(chunk: Buffer | string, callback?: () => void): this;
    end(chunk: Buffer | string, encoding: string, callback?: () => void): this;
    end(chunk: any, callback?: () => void): this;
    end(chunk: any, encoding: ObjectModeEncoding, callback?: () => void): this;
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
    on(
      event: "end" | "close" | "readable" | "pause" | "resume" | "drain" | "finish",
      listener: () => void,
    ): this;
    on(event: "error", listener: (err: Error) => void): this;
    on(event: "pipe" | "unpipe", listener: (src: Readable) => void): this;
    on(event: string, listener: (...args: any[]) => void): this;
    once(event: "data", listener: (chunk: any) => void): this;
    once(
      event: "end" | "close" | "readable" | "pause" | "resume" | "drain" | "finish",
      listener: () => void,
    ): this;
    once(event: "error", listener: (err: Error) => void): this;
    once(event: "pipe" | "unpipe", listener: (src: Readable) => void): this;
    once(event: string, listener: (...args: any[]) => void): this;
    addListener(event: "data", listener: (chunk: any) => void): this;
    addListener(
      event: "end" | "close" | "readable" | "pause" | "resume" | "drain" | "finish",
      listener: () => void,
    ): this;
    addListener(event: "error", listener: (err: Error) => void): this;
    addListener(event: "pipe" | "unpipe", listener: (src: Readable) => void): this;
    addListener(event: string, listener: (...args: any[]) => void): this;
    prependListener(event: "data", listener: (chunk: any) => void): this;
    prependListener(
      event: "end" | "close" | "readable" | "pause" | "resume" | "drain" | "finish",
      listener: () => void,
    ): this;
    prependListener(event: "error", listener: (err: Error) => void): this;
    prependListener(event: "pipe" | "unpipe", listener: (src: Readable) => void): this;
    prependListener(event: string, listener: (...args: any[]) => void): this;
    prependOnceListener(event: "data", listener: (chunk: any) => void): this;
    prependOnceListener(
      event: "end" | "close" | "readable" | "pause" | "resume" | "drain" | "finish",
      listener: () => void,
    ): this;
    prependOnceListener(event: "error", listener: (err: Error) => void): this;
    prependOnceListener(event: "pipe" | "unpipe", listener: (src: Readable) => void): this;
    prependOnceListener(event: string, listener: (...args: any[]) => void): this;
    off(event: "data", listener: (chunk: any) => void): this;
    off(
      event: "end" | "close" | "readable" | "pause" | "resume" | "drain" | "finish",
      listener: () => void,
    ): this;
    off(event: "error", listener: (err: Error) => void): this;
    off(event: "pipe" | "unpipe", listener: (src: Readable) => void): this;
    off(event: string, listener: (...args: any[]) => void): this;
    removeListener(event: "data", listener: (chunk: any) => void): this;
    removeListener(
      event: "end" | "close" | "readable" | "pause" | "resume" | "drain" | "finish",
      listener: () => void,
    ): this;
    removeListener(event: "error", listener: (err: Error) => void): this;
    removeListener(event: "pipe" | "unpipe", listener: (src: Readable) => void): this;
    removeListener(event: string, listener: (...args: any[]) => void): this;
  }

  class Transform extends Duplex {
    constructor(opts: ObjectTransformOptions);
    constructor(opts: StringTransformOptions);
    constructor(opts?: TransformOptions);
    /* The underscore-method surface (see Readable). */
    _transform(
      chunk: any,
      encoding: string,
      callback: (error?: Error | null, data?: any) => void,
    ): void;
    _flush(callback: (error?: Error | null, data?: any) => void): void;
  }
  class PassThrough extends Transform {
    constructor(opts: ObjectTransformOptions);
    constructor(opts: StringTransformOptions);
    constructor(opts?: TransformOptions);
  }

  /* addAbortSignal(signal, stream): the stream, destroyed with an
   * AbortError (cause: signal.reason) when the signal aborts. */
  function addAbortSignal<T extends Readable | Writable>(signal: AbortSignal, stream: T): T;
  /* pipeline(...stages, callback): the last stream, or the object-mode
   * PassThrough that a function destination feeds. */
  type PipelineResult<T extends unknown[]> = T extends [
    ...unknown[],
    infer D,
    (...args: any[]) => unknown,
  ]
    ? D extends (...args: any[]) => unknown
      ? PassThrough
      : D
    : unknown;
  function pipeline<T extends unknown[]>(...streams: T): PipelineResult<T>;
  /* util.promisify's pipeline overload matches only pipeline itself: a
   * generic signature alone admits every function. */
  namespace pipeline {
    const __promisify__: typeof promises.pipeline;
  }
  /* A compose stage: a stream, an async generator function over the
   * previous stage, or (first) an iterable, async iterable or web
   * ReadableStream. */
  type ComposeStage =
    | Readable
    | Writable
    | Iterable<unknown>
    | AsyncIterable<unknown>
    | globalThis.ReadableStream
    | ((source: any, options?: { signal: AbortSignal }) => unknown);
  /* compose(...streams): a Duplex that writes to the first stage and
   * reads from the last, with the stages running as a pipeline. */
  function compose(...streams: ComposeStage[]): Duplex;
  /* finished's options: readable/writable choose which ends count,
   * error: false ignores 'error' events, signal aborts the wait. */
  interface FinishedOptions {
    readable?: boolean;
    writable?: boolean;
    error?: boolean;
    signal?: AbortSignal;
  }
  function finished(stream: unknown, callback: (err?: Error | null) => void): () => void;
  function finished(
    stream: unknown,
    options: FinishedOptions | null,
    callback: (err?: Error | null) => void,
  ): () => void;
  /* Folds to the TARGET platform's default at compile time (win32 16384,
   * else 65536 — Node's own state.js split); literal argument only. */
  function getDefaultHighWaterMark(objectMode: boolean): number;
  /* The promise pipeline's result: a last stage that is an async
   * function resolves the promise with its value (before the options
   * argument, when one follows). */
  type PipelinePromise<T extends unknown[]> = T extends [
    ...unknown[],
    (...args: any[]) => Promise<infer P>,
  ]
    ? Promise<P>
    : T extends [
          ...unknown[],
          (...args: any[]) => Promise<infer P>,
          { signal?: AbortSignal; end?: boolean },
        ]
      ? Promise<P>
      : Promise<void>;
  namespace promises {
    function pipeline<T extends unknown[]>(...streams: T): PipelinePromise<T>;
    function finished(
      stream: unknown,
      options?: FinishedOptions & { cleanup?: boolean },
    ): Promise<void>;
  }
  class Stream extends EventEmitter {}

  export {
    Readable,
    Writable,
    Duplex,
    Transform,
    PassThrough,
    Stream,
    addAbortSignal,
    pipeline,
    compose,
    finished,
    getDefaultHighWaterMark,
    promises,
  };
  export type {
    ReadableOptions,
    WritableOptions,
    DuplexOptions,
    TransformOptions,
    FinishedOptions,
    PipelinePromise,
  };
}
declare module "node:stream" {
  import stream = require("stream");
  export = stream;
}
declare module "stream/promises" {
  /* The promise forms of finished/pipeline: a void promise the stream's
   * terminal point settles (rejected with the error, or
   * ERR_STREAM_PREMATURE_CLOSE on an early close). Stream arguments are
   * the lowered surface — iterables/generators/functions fence per site.
   * pipeline's trailing { signal, end } object and finished's options
   * (readable, writable, error, cleanup, signal) are supported. A last
   * stage that is an async function resolves the promise with its value. */
  function pipeline<T extends unknown[]>(...streams: T): import("stream").PipelinePromise<T>;
  function finished(
    stream: unknown,
    options?: {
      readable?: boolean;
      writable?: boolean;
      error?: boolean;
      cleanup?: boolean;
      signal?: AbortSignal;
    } | null,
  ): Promise<void>;
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
   * ERR_STREAM_PREMATURE_CLOSE. arrayBuffer answers an ArrayBuffer over
   * the bytes; blob fences per site. */
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
/* node:stream/web — the module exports the web stream globals themselves
 * (require("stream/web").ReadableStream === globalThis.ReadableStream).
 * ReadableStream is the implemented class; its reader and controller are
 * exported as types. */
declare module "stream/web" {
  export const ReadableStream: typeof globalThis.ReadableStream;
  export type ReadableStream<T = unknown> = globalThis.ReadableStream<T>;
  export type ReadableStreamDefaultReader<T = unknown> = globalThis.ReadableStreamDefaultReader<T>;
  export type ReadableStreamDefaultController<T = unknown> =
    globalThis.ReadableStreamDefaultController<T>;
  export type UnderlyingSource<T = unknown> = globalThis.UnderlyingSource<T>;
  export type QueuingStrategy<T = unknown> = globalThis.QueuingStrategy<T>;
}
declare module "node:stream/web" {
  export * from "stream/web";
}
interface ErrorConstructor {
  stackTraceLimit: number;
}
