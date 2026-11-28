import { arrayOf, BOOL, BYTES_U8, CHILD_T, DYN, F64, SPAWNRES_T, STRING, VOID } from "../ir.js";
import { defineLibFnSignatures } from "./shared.js";

/** The cp builtin call slots. */
export const cpSignatures = defineLibFnSignatures({
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
  "cp.spawnSync": { argTypes: [STRING, arrayOf(STRING), STRING], result: SPAWNRES_T },
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
    argTypes: [STRING, arrayOf(STRING), F64, STRING, F64, F64, F64, STRING],
    result: SPAWNRES_T,
  },
  /** cp.spawnSyncOpts with the `env` option: the trailing [k,v,...]
   * pairs replace the child's environment (recordToEnvPairs). */
  "cp.spawnSyncEnv": {
    argTypes: [STRING, arrayOf(STRING), F64, STRING, F64, F64, F64, arrayOf(STRING), STRING],
    result: SPAWNRES_T,
  },
  /** cp.spawnSyncOpts with the stdio carried as a RUNTIME string —
   * "pipe" | "ignore" | "inherit", proven by the call site's TYPE (the
   * defaultRunner idiom `stdio: options?.stdio ?? "pipe"`); the runtime
   * maps the value to the three modes. Args (cmd, argv, timeout,
   * killSignal, stdio). Never throws, like the other spawnSync forms. */
  "cp.spawnSyncStdioStr": {
    argTypes: [STRING, arrayOf(STRING), F64, STRING, STRING, STRING],
    result: SPAWNRES_T,
  },
  /** spawnSync with the `cwd`, `input`, and `shell` options (the
   * SCR_CHILD_CP_OPTIONS build of scr_child.c): the cp.spawnSyncOpts
   * contract plus the child's working directory ("" = inherit), stdin
   * input (has_input false leaves fd 0 to the stdio mode — an absent
   * `input` option; "" pipes an empty stdin), and the shell form
   * (the complete command line through /bin/sh -c — the compiler emits
   * it with an empty args list only, since Node warns DEP0190 for
   * separate shell arguments), exactly Node's reading of the members.
   * Args (cmd, argv, timeout, killSignal, inMode, outMode, errMode,
   * cwd, input, hasInput, shell). Never throws, like every spawnSync
   * form. */
  "cp.spawnSyncExt": {
    argTypes: [
      STRING,
      arrayOf(STRING),
      F64,
      STRING,
      F64,
      F64,
      F64,
      STRING,
      STRING,
      BOOL,
      BOOL,
      STRING,
    ],
    result: SPAWNRES_T,
  },
  /** cp.spawnSyncExt with the `env` option: the trailing [k,v,...] pairs
   * replace the child's environment. */
  "cp.spawnSyncExtEnv": {
    argTypes: [
      STRING,
      arrayOf(STRING),
      F64,
      STRING,
      F64,
      F64,
      F64,
      STRING,
      STRING,
      BOOL,
      BOOL,
      arrayOf(STRING),
      STRING,
    ],
    result: SPAWNRES_T,
  },
  /** execFileSync/execSync as ONE entry (args: cmd, argv, shell, input,
   * cwd, hasEnv, envPairs, timeoutMs, stdoutMode, stderrMode, encoding —
   * see scr_child.h). Throws Node's exact errors: "Command failed: <cmd>"
   * (+ captured stderr) on non-zero exit or signal death, "spawnSync
   * <file> ENOENT" on spawn failure, "spawnSync <file> ETIMEDOUT" after
   * the SIGTERM timeout, with Node's status, signal, output, pid, stdout
   * and stderr properties (decoded strings: the encoding option's name).
   * Result is the captured stdout decoded with that encoding (+1). */
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
      STRING,
    ],
    result: STRING,
  },
  /** The unencoded execFileSync/execSync form (cp.execSyncBytes): the
   * same call with Node's Buffer result and Buffer error outputs. Args:
   * cmd, argv, shell, input, hasInput, cwd, hasEnv, envPairs, timeoutMs,
   * stdoutMode, stderrMode. THROWS Node's exact errors, with the
   * status/signal/output/pid/stdout/stderr properties. */
  "cp.execSyncBytes": {
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
    result: BYTES_U8,
  },
  /** The promisified-execFile/exec capture (args: cmd, argv, shell, cwd,
   * hasEnv, envPairs, timeoutMs; shell marks exec's /bin/sh -c argv, as
   * for execSync, so failures display the command string): the same exec
   * core in the async shape — both streams captured, no echo, Node's ASYNC messages on the throw paths
   * ("Command failed: <cmd>\n<stderr>" with the unconditional newline,
   * "spawn <file> ENOENT" with .code, timeouts reporting as ordinary
   * SIGTERM command failures — never ETIMEDOUT). Result reuses the
   * ScrSpawnRes container (+1; stdout/stderr strings, status unused).
   * Called only from the frontend's interned %execFileAsync and
   * %execAsync ASYNC helpers, whose fiber turns the throw into the
   * rejection. */
  /** The program's own maxBuffer for the capturing call that follows
   * (validateMaxBuffer: a negative or NaN value throws Node's
   * ERR_OUT_OF_RANGE). The flag arms the value as the next capture's
   * limit; without it the call only validates. Without this call a
   * capture has Node's 1 MiB default. */
  "cp.maxBuffer": { argTypes: [F64, BOOL], result: VOID },
  "cp.execCapture": {
    argTypes: [STRING, arrayOf(STRING), BOOL, STRING, BOOL, arrayOf(STRING), F64],
    result: SPAWNRES_T,
  },
  /** child_process.spawn (scr_child.c + the scr_async.c loop): posix_spawn
   * after the PATH search in the parent, with per-slot ignore/inherit/pipe
   * modes (and number output fds), the all-piped Node default, and the
   * child registered with the event loop, which polls waitpid(WNOHANG) at
   * quiescence like timers.
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
  "cp.fork": {
    argTypes: [F64, arrayOf(STRING), F64, F64, F64, BOOL, arrayOf(STRING), STRING],
    result: CHILD_T,
  },
  /** child_process.execFile's callback slice: starts an all-piped child,
   * captures stdout/stderr, and moves the error-first callback into the
   * child registry. The callback shape is program-dependent and checked
   * by the validator/backends. The last argument is exec's shell flag:
   * the argv is ["-c", command] and failure messages show the command. */
  "cp.execFile": { argTypes: [STRING, arrayOf(STRING), null, BOOL], result: CHILD_T },
  /** The same callback slice with the `cwd` option (the
   * SCR_CHILD_CP_OPTIONS build): the child starts in cwd.
   * (cmd, argv, callback, shell, cwd). */
  "cp.execFileCwd": {
    argTypes: [STRING, arrayOf(STRING), null, BOOL, STRING],
    result: CHILD_T,
  },
  /** The callback slice with `env`, `timeout` and `killSignal` (the
   * SCR_CHILD_CP_OPTIONS build): (cmd, argv, callback, shell, cwd,
   * hasEnv, envPairs, timeoutMs, killSignal). cwd "" = inherit;
   * envPairs REPLACES the environment when hasEnv (an empty list with
   * hasEnv is Node's `env: {}`); timeoutMs 0 = no deadline; killSignal
   * "" = the SIGTERM default, otherwise a signal name resolved by the
   * runtime. Throws Node's option errors synchronously (validateTimeout's
   * ERR_OUT_OF_RANGE, sanitizeKillSignal's ERR_UNKNOWN_SIGNAL) before the
   * child starts. The callback contract is cp.execFile's. */
  "cp.execFileOpts": {
    argTypes: [
      STRING,
      arrayOf(STRING),
      null,
      BOOL,
      STRING,
      BOOL,
      arrayOf(STRING),
      F64,
      STRING,
      DYN,
      BOOL,
    ],
    result: CHILD_T,
  },
  // spawn's options form: per-slot stdio modes (0 ignore / 1 inherit /
  // 2 fd) with the out/err fds for mode 2, detached, env replacement
  // pairs, cwd ("" = inherit).
  /** spawn with options (scr_child.c): the cp.spawn core plus PER-SLOT
   * stdio — args are (cmd, argv, inMode, outMode, errMode, outFd, errFd,
   * detached, hasEnv, envPairs, cwd, ipcFd); modes 0 ignore (/dev/null), 1
   * inherit, 2 fd (out/err only — the fd dup2s into the child's slot,
   * Node's stdio fd form; the daemon-log idiom ["ignore", logFd, logFd]).
   * detached is POSIX_SPAWN_SETSID (the child gets its own session and
   * process group, Node's semantics), env is a REPLACEMENT ([k,v,...]
   * pairs like cp.execSync's), cwd ""=inherit, ipcFd is the child fd of an
   * "ipc" stdio slot (-1 for none: the channel socketpair and
   * NODE_CHANNEL_FD). Same event/loop story as cp.spawn. */
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
      F64,
    ],
    result: CHILD_T,
  },
  /** spawn's options form with `timeout`, `killSignal` and `signal`
   * (the SCR_CHILD_CP_OPTIONS build): cp.spawnOpts' arguments, then
   * timeoutMs (0 = no timer), killSignal and signal as checked-dynamic
   * values (undefined = absent; killSignal may be a name, matched
   * without case, or a signal number). Node's launch checks run in its
   * order — validateTimeout, validateAbortSignal, sanitizeKillSignal —
   * before the child starts, so unlike cp.spawnOpts this call can throw
   * synchronously. ipcFd rides after signal, as in cp.spawnOpts. */
  "cp.spawnArmed": {
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
      F64,
      DYN,
      DYN,
      F64,
    ],
    result: CHILD_T,
  },
  /** Runtime options normalized into the native spawn core; unsupported
   * process features retain explicit refusals. (command, args, options). */
  "cp.spawnDynamic": { argTypes: [STRING, arrayOf(STRING), DYN], result: CHILD_T },
  /** Node's argument checks for the child launch that follows
   * (normalizeSpawnArguments, normalizeExecArgs): a NUL in the file or
   * command, an argument, cwd or an environment key or value, or an
   * empty file, throws ERR_INVALID_ARG_VALUE before a process starts.
   * (form, cmd, args, envPairs, cwd): form 0 reads cmd as the file and
   * args as its arguments; 1 and 2 are the /bin/sh -c launches, whose
   * args[1] is exec's command (1) or execFile's file (2); 3 is fork,
   * which has no file. An absent cwd is "", an inherited environment an
   * empty array. */
  "cp.checkArgs": {
    argTypes: [F64, STRING, arrayOf(STRING), arrayOf(STRING), STRING],
    result: VOID,
  },
});
