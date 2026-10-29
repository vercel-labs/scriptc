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
  /** @deprecated since v10.0.0 - Use `Buffer.from(string[, encoding])` instead. */
  new (str: string, encoding?: BufferEncoding): Buffer;
  /** @deprecated since v10.0.0 - Use `Buffer.alloc()` instead. */
  new (size: number): Buffer;
  /** @deprecated since v10.0.0 - Use `Buffer.from(array)` instead. */
  new (array: ArrayLike<number>): Buffer;
  /** @deprecated since v10.0.0 - Use `Buffer.from(arrayBuffer[, byteOffset[, length]])` instead. */
  new (arrayBuffer: ArrayBuffer | SharedArrayBuffer): Buffer;
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
interface StreamPipeOptions {
  preventAbort?: boolean;
  preventCancel?: boolean;
  preventClose?: boolean;
  signal?: AbortSignal;
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
  tee(): [ReadableStream<T>, ReadableStream<T>];
  pipeTo(destination: WritableStream<T>, options?: StreamPipeOptions): Promise<void>;
  pipeThrough<O>(
    transform: { readable: ReadableStream<O>; writable: WritableStream<T> },
    options?: StreamPipeOptions,
  ): ReadableStream<O>;
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
/* The writable side of a TransformStream and its writer. A program that
 * constructs a WritableStream, or a TransformStream with a transformer,
 * builds its streams with the web stream classes (scr_webstreams.c). */
interface WritableStreamDefaultWriter<W = unknown> {
  readonly closed: Promise<void>;
  readonly desiredSize: number | null;
  readonly ready: Promise<void>;
  abort(reason?: unknown): Promise<void>;
  close(): Promise<void>;
  releaseLock(): void;
  write(chunk?: W): Promise<void>;
}
interface WritableStream<W = unknown> {
  readonly locked: boolean;
  abort(reason?: unknown): Promise<void>;
  close(): Promise<void>;
  getWriter(): WritableStreamDefaultWriter<W>;
}
/* Without a transformer, the identity transform: chunks written to
 * `writable` are read from `readable`, and a write completes when its chunk
 * is read. */
interface TransformStream<I = unknown, O = unknown> {
  readonly readable: ReadableStream<O>;
  readonly writable: WritableStream<I>;
}
interface Transformer<I = unknown, O = unknown> {
  start?(controller: TransformStreamDefaultController<O>): unknown;
  transform?(chunk: I, controller: TransformStreamDefaultController<O>): unknown;
  flush?(controller: TransformStreamDefaultController<O>): unknown;
  cancel?(reason?: unknown): unknown;
}
declare var TransformStream: {
  new <I = unknown, O = I>(
    transformer?: Transformer<I, O>,
    writableStrategy?: QueuingStrategy<I>,
    readableStrategy?: QueuingStrategy<O>,
  ): TransformStream<I, O>;
  readonly prototype: TransformStream<unknown, unknown>;
};
/* The other web stream interfaces. JavaScript sources construct and read
 * them as checked-dynamic values (scr_webstreams.c); TypeScript sources
 * have no static lowering for them. */
declare var ReadableStreamDefaultReader: {
  new <T = unknown>(stream: ReadableStream<T>): ReadableStreamDefaultReader<T>;
  readonly prototype: ReadableStreamDefaultReader<unknown>;
};
declare var ReadableStreamDefaultController: {
  new (): ReadableStreamDefaultController<unknown>;
  readonly prototype: ReadableStreamDefaultController<unknown>;
};
interface WritableStreamDefaultController {
  readonly signal: AbortSignal;
  error(reason?: unknown): void;
}
interface UnderlyingSink<W = unknown> {
  start?(controller: WritableStreamDefaultController): unknown;
  write?(chunk: W, controller: WritableStreamDefaultController): unknown;
  close?(): unknown;
  abort?(reason?: unknown): unknown;
}
declare var WritableStream: {
  new <W = unknown>(sink?: UnderlyingSink<W>, strategy?: QueuingStrategy<W>): WritableStream<W>;
  readonly prototype: WritableStream<unknown>;
};
declare var WritableStreamDefaultWriter: {
  new <W = unknown>(stream: WritableStream<W>): WritableStreamDefaultWriter<W>;
  readonly prototype: WritableStreamDefaultWriter<unknown>;
};
declare var WritableStreamDefaultController: {
  new (): WritableStreamDefaultController;
  readonly prototype: WritableStreamDefaultController;
};
interface TransformStreamDefaultController<O = unknown> {
  readonly desiredSize: number | null;
  enqueue(chunk?: O): void;
  error(reason?: unknown): void;
  terminate(): void;
}
declare var TransformStreamDefaultController: {
  new (): TransformStreamDefaultController<unknown>;
  readonly prototype: TransformStreamDefaultController<unknown>;
};
interface CountQueuingStrategy extends QueuingStrategy<unknown> {
  readonly highWaterMark: number;
  readonly size: QueuingStrategySize<unknown>;
}
declare var CountQueuingStrategy: {
  new (init: { highWaterMark: number }): CountQueuingStrategy;
  readonly prototype: CountQueuingStrategy;
};
interface ByteLengthQueuingStrategy extends QueuingStrategy<ArrayBufferView> {
  readonly highWaterMark: number;
  readonly size: QueuingStrategySize<ArrayBufferView>;
}
declare var ByteLengthQueuingStrategy: {
  new (init: { highWaterMark: number }): ByteLengthQueuingStrategy;
  readonly prototype: ByteLengthQueuingStrategy;
};
interface TextEncoderStream {
  readonly encoding: "utf-8";
  readonly readable: ReadableStream<Uint8Array>;
  readonly writable: WritableStream<string>;
}
declare var TextEncoderStream: {
  new (): TextEncoderStream;
  readonly prototype: TextEncoderStream;
};
interface TextDecoderStream {
  readonly encoding: string;
  readonly fatal: boolean;
  readonly ignoreBOM: boolean;
  readonly readable: ReadableStream<string>;
  readonly writable: WritableStream<Uint8Array>;
}
declare var TextDecoderStream: {
  new (label?: string, options?: { fatal?: boolean; ignoreBOM?: boolean }): TextDecoderStream;
  readonly prototype: TextDecoderStream;
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
  /* A copy whose body is one branch of the body's tee; the original keeps
   * the other. */
  clone(): Response;
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
  clone(): Request;
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
    /* The bytes queued behind the last write: the compiled binary's fd
     * 1/2 writes are synchronous, so it is always 0. */
    readonly writableLength: number;
    getWindowSize(): [number, number];
  }
  export function isatty(fd: number): boolean;
}
declare module "node:tty" {
  export * from "tty";
}

interface ErrorConstructor {
  stackTraceLimit: number;
  captureStackTrace(targetObject: object, constructorOpt?: Function): void;
}
