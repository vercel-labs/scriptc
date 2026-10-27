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
