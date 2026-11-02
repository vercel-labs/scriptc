/// <reference path="./stream.d.ts" />

/* node:child_process — the synchronous slice: spawnSync(command, args?)
 * runs the child to completion (posix_spawn + waitpid) with stdout/stderr
 * captured as UTF-8 bytes. The capture's TYPE is Node's: a string when the
 * options carry a string encoding, a Buffer without one
 * (`SpawnSyncReturns<Buffer>` in @types/node); reading the Buffer form is
 * the bytes<u8> Buffer reads fs uses. `status` is the exit code, or null
 * when the child died to a signal OR could not be spawned at all
 * (nonexistent binary, permission denied). A spawn failure is DATA on the
 * result, never a throw: `error` is the Error Node builds ("spawnSync
 * <file> ENOENT", `code` stamped, or ETIMEDOUT after a timeout kill) and
 * both outputs are "" (or an empty Buffer) where Node types them null
 * (SEMANTICS.md). */
declare module "child_process" {
  import type { Readable, Writable } from "stream";

  /* T is the capture type the options select. The default keeps a bare
   * `SpawnSyncReturns` annotation meaning the string form, as before. */
  export interface SpawnSyncReturns<T = string> {
    readonly status: number | null;
    readonly stdout: T;
    readonly stderr: T;
    /* The termination signal's name ("SIGTERM", ...) when a signal
     * killed the child (a timeout's killSignal included), null otherwise
     * — Node's shape. */
    readonly signal: string | null;
    /* Node's spawn-failure carrier: a real Error ("spawnSync <file>
     * ENOENT", `code` stamped) when the spawn itself failed — status is
     * null and both outputs "" (or an empty Buffer) then — or ETIMEDOUT
     * after a timeout kill; undefined otherwise. */
    readonly error?: Error;
  }
  /* The supported options: encoding ("utf8"/"utf-8" — the only form that
   * makes stdout/stderr strings, exactly Node), timeout (ms — sends
   * killSignal at the deadline and the result carries error: ETIMEDOUT +
   * the signal, never a throw), killSignal (a signal NAME literal),
   * stdio ("ignore"/"inherit"/"pipe" or a 3-tuple of those — captures
   * read "" / an empty Buffer for non-piped streams), env (replaces the
   * child's environment), cwd (the child's directory), input (the string
   * piped to its stdin — `| undefined` means the option is absent, ""
   * pipes an empty stdin), shell (the complete command line in
   * `command`, with a statically empty args list, run by /bin/sh -c),
   * and windowsHide (a POSIX no-op).
   * The shell form takes no separate args: Node warns DEP0190 because it
   * concatenates them unescaped, and a native build has no warning
   * channel, so the compiler REFUSES `shell: true` with a non-empty args
   * list. */
  export interface SpawnSyncOptions {
    encoding?: "utf8" | "utf-8";
    timeout?: number;
    killSignal?: string;
    stdio?: "pipe" | "ignore" | "inherit" | ("pipe" | "ignore" | "inherit")[];
    env?: { [k: string]: string | undefined };
    cwd?: string;
    /* Piped to the child's stdin. undefined is an ABSENT option (no
     * pipe, fd 0 is /dev/null or inherited per stdio); "" is an EMPTY
     * stdin, which the child reads as immediate EOF — Node's reading. */
    input?: string | undefined;
    windowsHide?: boolean;
    /* Node's shell form: the complete command line in `command`, with
     * an empty args list, runs through /bin/sh -c, so quoting and
     * operators follow the shell's rules. A non-empty args list with
     * shell: true is a compile error (Node warns DEP0190 for unescaped
     * shell arguments). */
    shell?: boolean;
  }
  export function spawnSync(
    command: string,
    args: string[] | undefined,
    options: SpawnSyncOptions & { encoding: "utf8" | "utf-8" },
  ): SpawnSyncReturns<string>;
  export function spawnSync(
    command: string,
    args?: string[],
    options?: SpawnSyncOptions,
  ): SpawnSyncReturns<Buffer>;

  /* The named options interface for the string-encoding spawnSync form —
   * @types/node's SpawnSyncOptionsWithStringEncoding, narrowed to the
   * honestly-implemented members (env and killSignal keep the inline
   * literal form: a runtime record cannot carry a replacement
   * environment). VALUES of this type are a real record (type-mapper.ts
   * interns the shape), so a typed const or a runner function's options
   * parameter flows to spawnSync at runtime with its members read at the
   * call. */
  export interface SpawnSyncOptionsWithStringEncoding {
    encoding: "utf8" | "utf-8";
    cwd?: string;
    input?: string;
    stdio?: "pipe" | "ignore" | "inherit" | ("pipe" | "ignore" | "inherit")[];
    timeout?: number;
    windowsHide?: boolean;
    /* Read at the call. The call then takes the command-line form only:
     * a statically non-empty args list is a compile error (Node warns
     * DEP0190 for unescaped shell arguments). */
    shell?: boolean;
  }

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
  /* The piped child stdin is the node:stream Writable Node's typings give
   * it, so it flows into any Writable slot and back. Members the direct
   * handle does not lower (the underscored hooks, cork, an encoding, a
   * third argument) typecheck and need the general stream
   * representation. */
  export interface ChildStdin extends Writable {}

  /* The piped child output is the node:stream Readable Node's typings
   * give it. The direct handle delivers one chunk per pipe read (a
   * Buffer, or a string after setEncoding); the rest of the Readable
   * surface typechecks and needs the general stream representation to
   * lower. */
  export interface ChildStdout extends Readable {}

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
    /* off/removeListener remove by FUNCTION IDENTITY — pass the same
     * function value (a const binding) that was registered. */
    off(event: "spawn", listener: () => void): this;
    off(event: "exit", listener: (code: number | null, signal: string | null) => void): this;
    off(event: "close", listener: (code: number | null, signal: string | null) => void): this;
    off(event: "error", listener: (err: Error) => void): this;
    removeListener(event: "spawn", listener: () => void): this;
    removeListener(
      event: "exit",
      listener: (code: number | null, signal: string | null) => void,
    ): this;
    removeListener(
      event: "close",
      listener: (code: number | null, signal: string | null) => void,
    ): this;
    removeListener(event: "error", listener: (err: Error) => void): this;
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
    /* signalCode is the signal that terminated the child, null while it
     * runs, after a normal exit, and after a spawn failure. */
    readonly signalCode: string | null;
    readonly killed: boolean;
    kill(signal?: string | number): boolean;
    unref(): void;
    readonly connected: boolean;
    send(message: object, callback?: (error: Error | null) => void): boolean;
    disconnect(): void;
    [Symbol.dispose](): void;
    /* The piped streams — non-null exactly when the matching stdio slot
     * was "pipe" (Node's shape; the node:stream classes, narrowed to the
     * members the direct handles deliver). */
    readonly stdin: ChildStdin | null;
    readonly stdout: ChildStdout | null;
    readonly stderr: ChildStdout | null;
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
     * runs the complete command string through /bin/sh or cmd.exe (with
     * an empty args list — a non-empty one is a compile error, because
     * Node warns DEP0190 for unescaped shell arguments). */
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
    /* Runs the complete command line through /bin/sh -c; it takes an
     * empty args list (Node warns DEP0190 for unescaped shell args). */
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
