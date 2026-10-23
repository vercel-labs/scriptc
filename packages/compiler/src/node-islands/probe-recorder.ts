/* The build-time load recorder of deferred Node islands (scope-B NI-7b).
 * It runs inside libnode in the probe host (snapshot.ts writes it next to
 * the host and the bootstrap requires it), loads every candidate island
 * module once and records, for each:
 *
 *   - inputs: reads of values that can differ between the build and a run,
 *     or between the import position and a later evaluation: process.env
 *     keys (guarded at boot), process.env enumeration, stdio TTY state
 *     (`isTTY` is guarded at boot; window size and colour depth are not),
 *     argv, execPath, cwd, uid/gid, the file system, os information, and
 *     the clock and random numbers (volatile: allowed, but then no
 *     constants are snapshotted);
 *   - effects: output, warnings, process listeners and exits, timers,
 *     immediates, ticks, microtasks and any other async resource created
 *     during the load (promises included), child processes, the network,
 *     workers, vm, the inspector, native addons (process.dlopen), writes
 *     to process.env;
 *   - mutations of builtin state: globalThis, the builtin prototypes and
 *     constructors, `process`, and the exports of common builtin modules
 *     (island-local, since native code has its own builtins, but
 *     observable by other island modules evaluated out of order);
 *   - every file the load required (the module's closure), and a throw;
 *
 * and takes the interface snapshot of the module's value (snapshot.ts).
 * Calls made by Node's own internals (the module loader reading files,
 * for instance) are not the module's: a record is kept only when the
 * nearest caller outside this file is not `node:internal/`.
 *
 * Determinism argument: a load that read no input runs the same way at
 * any time in any run (with the same pack and the same files, which the
 * boot guards check), so one recorded run is the whole truth about its
 * effects, and evaluating it later is unobservable when that run had
 * none. Volatile values (pid, clock, random) do not change between the
 * import position and a later evaluation in the same process except the
 * clock and random numbers, which no run of Node reproduces either. */
export const PROBE_RECORDER = String.raw`"use strict";
const types = require("node:util").types;
const Module = require("node:module");
const { createRequire } = Module;
const asyncHooks = require("node:async_hooks");
const SELF = __filename;

let lastCaller = "";
// The closure of the module being loaded (files its load resolved), and
// its package directory: code in other files (an earlier module that
// wrapped a builtin, as graceful-fs wraps fs.closeSync) acts for its caller.
let currentFiles = null;
let currentPackageDir = null;
function frameFile(line) {
  const m = /\(([^()]+):\d+:\d+\)\s*$/.exec(line) || /at ([^ ()]+):\d+:\d+\s*$/.exec(line);
  if (m === null) return null;
  let f = m[1];
  if (f.startsWith("file://")) { try { f = require("node:url").fileURLToPath(f); } catch {} }
  return f;
}
// Whose call this is: walking out from the recorder's frames, the first
// frame of the module loader (node:internal/modules/) makes it the
// loader's (reading a module's files); the first frame of other code
// (an island module, outside node:) makes it the module's. Other builtin
// frames (console, streams, a public builtin calling its own exports) act
// for their caller.
function internalCaller() {
  const limit = Error.stackTraceLimit;
  Error.stackTraceLimit = 64;
  const lines = new Error().stack.split("\n");
  Error.stackTraceLimit = limit;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.includes(SELF)) continue;
    if (line.includes("node:internal/modules/")) return true;
    if (/[( ]node:/.test(line)) continue;
    const file = frameFile(line);
    if (currentFiles !== null && file !== null && !currentFiles.has(file)) continue;
    lastCaller = line.trim().replace(/^at /, "");
    return false;
  }
  return true;
}

const fnToString = Function.prototype.toString;
const hasOwn = Object.prototype.hasOwnProperty;
function isConstructor(f) {
  try { Reflect.construct(String, [], f); return true; } catch { return false; }
}
function plainClass(f) {
  let source = "";
  try { source = fnToString.call(f); } catch { return false; }
  if (/\[native code\]\s*\}$/.test(source)) return false;
  for (let o = f; o !== null && o !== Function.prototype; o = Object.getPrototypeOf(o))
    if (hasOwn.call(o, Symbol.hasInstance)) return false;
  return true;
}

const builtinObjects = new Set();
for (const name of ["assert", "buffer", "child_process", "constants", "crypto", "dns", "events", "fs",
  "fs/promises", "http", "https", "module", "net", "os", "path", "querystring", "readline", "stream",
  "stream/promises", "string_decoder", "timers", "tty", "url", "util", "util/types", "zlib"]) {
  try { builtinObjects.add(require(name)); } catch {}
}

exports.probe = function probe(input) {
  const objects = {};
  const oids = new Map();
  let next = 1;
  const value = (v, depth) => {
    if (v === undefined) return { u: 1 };
    if (v === null) return { l: 1 };
    switch (typeof v) {
      case "boolean": return { b: v };
      case "number": return { n: Object.is(v, -0) ? "-0" : String(v) };
      case "string": return v.isWellFormed() ? { s: v } : { x: 1 };
      case "symbol": return object(v, 2, depth);
      case "function":
        if (types.isProxy(v)) return { x: 1 };
        return object(v, 1 | (isConstructor(v) ? 32 : 0), depth);
      case "object":
        if (types.isProxy(v) || types.isPromise(v) || types.isNativeError(v) ||
            ArrayBuffer.isView(v) || types.isExternal(v) || builtinObjects.has(v)) return { x: 1 };
        return object(v, Array.isArray(v) ? 8 : 0, depth);
      default: return { x: 1 };
    }
  };
  const object = (v, flags, depth) => {
    if (oids.has(v)) return { o: oids.get(v) };
    const id = next++;
    oids.set(v, id);
    const entry = { f: flags, p: (flags & 1) !== 0 && plainClass(v), m: [] };
    objects[id] = entry;
    if (typeof v === "symbol") return { o: id };
    const keys = depth === 0 || (depth === 1 && typeof v !== "function")
      ? Object.getOwnPropertyNames(v)
      : typeof v === "function" ? ["name", "length"] : [];
    for (const key of keys) {
      let d;
      try { d = Object.getOwnPropertyDescriptor(v, key); } catch { continue; }
      if (d === undefined) continue;
      if (!("value" in d)) {
        // The module value's getters (esbuild's __export): read once, under
        // the recording, as Node reads CommonJS named exports after the
        // module evaluated.
        if (depth !== 0 || typeof d.get !== "function") continue;
        // A getter that reads inputs or has effects (esbuild's lazy __esm
        // inits) is left out: its member starts Node, and its work happens
        // when the program reads the member, eager or deferred alike (Node
        // reads every CommonJS named export at import; scriptc reads the
        // ones the program imports). It is not part of the load.
        const marks = [inputs.length, volatile.length, envKeys.size, tty.size, effects.length];
        const keysBefore = new Set(envKeys.keys());
        const ttyBefore = new Set(tty.keys());
        let got, ok = true;
        recording = true;
        try { got = d.get.call(v); } catch { ok = false; }
        recording = false;
        const readInput = inputs.length > marks[0] || volatile.length > marks[1] ||
          envKeys.size > marks[2] || tty.size > marks[3] || effects.length > marks[4];
        if (readInput) {
          inputs.length = marks[0];
          volatile.length = marks[1];
          effects.length = marks[4];
          for (const k of [...envKeys.keys()]) if (!keysBefore.has(k)) envKeys.delete(k);
          for (const k of [...tty.keys()]) if (!ttyBefore.has(k)) tty.delete(k);
        }
        if (ok && !readInput) entry.m.push([key, value(got, depth + 1)]);
        continue;
      }
      entry.m.push([key, value(d.value, depth + 1)]);
    }
    return { o: id };
  };

  // ── the recorder ──
  const inputs = [], volatile = [], effects = [], tty = new Map(), envKeys = new Map();
  const files = new Set();
  let recording = false;
  const note = (list, what) => {
    if (recording && !internalCaller()) list.push(list === volatile ? what : what + " (" + lastCaller + ")");
  };
  const undo = [];
  const wrapFn = (owner, key, list, label) => {
    let original;
    try { original = owner[key]; } catch { return; }
    if (typeof original !== "function") return;
    const wrapped = function (...a) {
      note(list, label);
      return new.target ? Reflect.construct(original, a, new.target) : original.apply(this, a);
    };
    try {
      Object.defineProperty(wrapped, "name", { value: original.name });
      Object.defineProperty(wrapped, "length", { value: original.length });
      for (const k of Reflect.ownKeys(original))
        if (!hasOwn.call(wrapped, k)) Object.defineProperty(wrapped, k, Object.getOwnPropertyDescriptor(original, k));
      owner[key] = wrapped;
    } catch { return; }
    undo.push(() => { try { owner[key] = original; } catch {} });
  };
  const wrapGetter = (owner, key, label, onRead) => {
    const d = Object.getOwnPropertyDescriptor(owner, key);
    if (d === undefined || !d.configurable) return;
    Object.defineProperty(owner, key, {
      configurable: true,
      enumerable: d.enumerable,
      get() {
        const v = d.get ? d.get.call(this) : d.value;
        if (recording && !internalCaller()) onRead(v);
        return v;
      },
      set(v) {
        note(effects, "a write of " + label);
        if (d.set) d.set.call(this, v); else d.value = v;
      },
    });
    undo.push(() => Object.defineProperty(owner, key, d));
  };
  const realEnv = process.env;
  const readKey = (t, k) => {
    if (recording && typeof k === "string" && !envKeys.has(k) && !internalCaller())
      envKeys.set(k, t[k] === undefined ? null : String(t[k]));
  };
  process.env = new Proxy(realEnv, {
    get(t, k) { readKey(t, k); return t[k]; },
    has(t, k) { readKey(t, k); return k in t; },
    getOwnPropertyDescriptor(t, k) { readKey(t, k); return Reflect.getOwnPropertyDescriptor(t, k); },
    ownKeys(t) { note(inputs, "an enumeration of process.env"); return Reflect.ownKeys(t); },
    set(t, k, v) { note(effects, "a write of process.env." + String(k)); t[k] = v; return true; },
    defineProperty(t, k, d) { note(effects, "a write of process.env." + String(k)); return Reflect.defineProperty(t, k, d); },
    deleteProperty(t, k) { note(effects, "a delete of process.env." + String(k)); delete t[k]; return true; },
  });
  undo.push(() => { process.env = realEnv; });
  for (const k of ["argv", "execArgv", "execPath", "title", "argv0", "debugPort", "exitCode"])
    wrapGetter(process, k, "process." + k, () => note(inputs, "process." + k));
  for (const k of ["pid", "ppid"]) wrapGetter(process, k, "process." + k, () => note(volatile, "process." + k));
  for (const k of ["cwd", "getuid", "getgid", "geteuid", "getegid", "getgroups", "umask", "getActiveResourcesInfo", "resourceUsage", "availableMemory", "constrainedMemory"])
    wrapFn(process, k, inputs, "process." + k + "()");
  for (const k of ["uptime", "hrtime", "memoryUsage", "cpuUsage"]) wrapFn(process, k, volatile, "process." + k + "()");
  if (process.hrtime) wrapFn(process.hrtime, "bigint", volatile, "process.hrtime.bigint()");
  for (const k of ["exit", "reallyExit", "abort", "kill", "chdir", "setuid", "setgid", "seteuid", "setegid", "setgroups", "dlopen", "binding", "_linkedBinding", "emitWarning", "on", "addListener", "once", "prependListener", "prependOnceListener", "removeListener", "off", "removeAllListeners", "setMaxListeners", "nextTick", "setUncaughtExceptionCaptureCallback", "setSourceMapsEnabled", "send", "disconnect"])
    wrapFn(process, k, effects, "process." + k + "()");
  for (const [fd, s] of [[0, "stdin"], [1, "stdout"], [2, "stderr"]]) {
    let stream;
    try { stream = process[s]; } catch { continue; }
    for (const k of ["write", "on", "once", "addListener", "prependListener", "end", "setRawMode", "resume", "pause", "read", "cork", "uncork", "destroy", "pipe"])
      wrapFn(stream, k, effects, "process." + s + "." + k + "()");
    wrapGetter(stream, "isTTY", "process." + s + ".isTTY", (v) => { if (!tty.has(fd)) tty.set(fd, v === true); });
    for (const k of ["columns", "rows"]) wrapGetter(stream, k, "process." + s + "." + k, () => note(inputs, "process." + s + "." + k));
    for (const k of ["getColorDepth", "hasColors", "getWindowSize"]) wrapFn(stream, k, inputs, "process." + s + "." + k + "()");
  }
  for (const k of ["queueMicrotask", "fetch"]) wrapFn(globalThis, k, effects, k + "()");
  // Timers: one the load sets and clears again, and a clear of nothing
  // (undefined, null), leave nothing behind (NI-7d).
  const pendingTimers = new Map();
  for (const k of ["setTimeout", "setInterval", "setImmediate"]) {
    const original = globalThis[k];
    const wrapped = function (...a) {
      const handle = original.apply(this, a);
      if (recording && !internalCaller()) {
        effects.push(k + "() (" + lastCaller + ")");
        pendingTimers.set(handle, effects.length - 1);
      }
      return handle;
    };
    Object.defineProperty(wrapped, "name", { value: original.name });
    globalThis[k] = wrapped;
    undo.push(() => { globalThis[k] = original; });
  }
  for (const k of ["clearTimeout", "clearInterval", "clearImmediate"]) {
    const original = globalThis[k];
    const wrapped = function (handle) {
      if (recording && !internalCaller()) {
        if (pendingTimers.has(handle)) {
          effects[pendingTimers.get(handle)] = null;
          pendingTimers.delete(handle);
        } else if (handle !== undefined && handle !== null) {
          effects.push(k + "() of a timer the load did not set (" + lastCaller + ")");
        }
      }
      return original.apply(this, arguments);
    };
    Object.defineProperty(wrapped, "name", { value: original.name });
    globalThis[k] = wrapped;
    undo.push(() => { globalThis[k] = original; });
  }
  wrapFn(Date, "now", volatile, "Date.now()");
  wrapFn(Math, "random", volatile, "Math.random()");
  wrapFn(globalThis, "Date", volatile, "new Date()");
  const whole = {
    fs: inputs, os: inputs, child_process: effects, net: effects, dgram: effects, dns: effects,
    http: effects, https: effects, http2: effects, tls: effects, worker_threads: effects,
    cluster: effects, vm: effects, inspector: effects, tty: inputs, readline: effects, timers: effects,
    perf_hooks: volatile, crypto: volatile, v8: effects, repl: effects, trace_events: effects,
    async_hooks: effects, diagnostics_channel: effects,
  };
  // os.homedir() and os.tmpdir() are functions of the environment on POSIX:
  // HOME (when set), and TMPDIR, TMP, TEMP. Their keys become env guards.
  const osModule = require("node:os");
  for (const [k, keys] of [["homedir", ["HOME"]], ["tmpdir", ["TMPDIR", "TMP", "TEMP"]]]) {
    const original = osModule[k];
    osModule[k] = function () {
      const result = original.apply(this, arguments);
      if (recording && !internalCaller()) {
        if (process.platform === "win32" || (k === "homedir" && realEnv.HOME === undefined))
          inputs.push("os." + k + "()");
        else for (const key of keys) if (!envKeys.has(key)) envKeys.set(key, realEnv[key] === undefined ? null : String(realEnv[key]));
      }
      return result;
    };
    undo.push(() => { osModule[k] = original; });
  }
  const pureFns = new Set(["os.platform", "os.homedir", "os.tmpdir", "os.type", "os.arch", "os.machine", "os.endianness",
    "crypto.createHash", "crypto.createHmac", "crypto.getHashes", "crypto.getCiphers", "crypto.getCurves",
    "crypto.createCipheriv", "crypto.createDecipheriv", "vm.isContext", "fs.existsSync__never",
    "async_hooks.AsyncLocalStorage", "async_hooks.AsyncResource", "diagnostics_channel.channel",
    "diagnostics_channel.tracingChannel", "diagnostics_channel.hasSubscribers"]);
  // Synchronous reads of the module's own package (its files are boot
  // guards, by size and mtime) are guarded inputs, not inputs.
  const fsModule = require("node:fs");
  const guardedFds = new Set();
  const ownPath = (p) => {
    if (currentPackageDir === null) return null;
    let f = p;
    if (f instanceof URL) { try { f = require("node:url").fileURLToPath(f); } catch { return null; } }
    if (Buffer.isBuffer(f)) f = f.toString();
    if (typeof f !== "string") return null;
    const abs = require("node:path").resolve(f);
    return abs === currentPackageDir || abs.startsWith(currentPackageDir + "/") ? abs : null;
  };
  const readOnlyFlags = (flags) => flags === undefined || flags === "r" || flags === "rs" || flags === fsModule.constants.O_RDONLY;
  for (const key of ["readFileSync", "existsSync", "statSync", "lstatSync", "readdirSync", "realpathSync", "accessSync", "readlinkSync", "openSync"]) {
    const original = fsModule[key];
    if (typeof original !== "function") continue;
    const wrapped = function (target, flags) {
      const result = original.apply(this, arguments);
      if (recording && !internalCaller()) {
        const own = ownPath(target);
        if (own !== null && (key !== "openSync" || readOnlyFlags(flags))) {
          files.add(own);
          if (key === "openSync") guardedFds.add(result);
        } else {
          inputs.push("fs." + key + "() (" + lastCaller + ")");
        }
      }
      return result;
    };
    for (const k of Reflect.ownKeys(original)) if (!hasOwn.call(wrapped, k)) { try { Object.defineProperty(wrapped, k, Object.getOwnPropertyDescriptor(original, k)); } catch {} }
    fsModule[key] = wrapped;
    undo.push(() => { fsModule[key] = original; });
  }
  for (const key of ["readSync", "fstatSync", "closeSync"]) {
    const original = fsModule[key];
    const wrapped = function (fd) {
      const result = original.apply(this, arguments);
      if (recording && !internalCaller()) {
        if (!guardedFds.has(fd)) inputs.push("fs." + key + "() (" + lastCaller + ")");
        else if (key === "closeSync") guardedFds.delete(fd);
      }
      return result;
    };
    fsModule[key] = wrapped;
    undo.push(() => { fsModule[key] = original; });
  }
  const guardedFsFns = new Set(["readFileSync", "existsSync", "statSync", "lstatSync", "readdirSync", "realpathSync", "accessSync", "readlinkSync", "openSync", "readSync", "fstatSync", "closeSync"]);
  for (const [name, list] of Object.entries(whole)) {
    let m;
    try { m = require(name); } catch { continue; }
    for (const key of Object.keys(m)) {
      if (name === "fs" && guardedFsFns.has(key)) continue;
      if (pureFns.has(name + "." + key) || key === "promises" || /^[A-Z]/.test(key) && name !== "worker_threads" && name !== "child_process") continue;
      wrapFn(m, key, list, name + "." + key + "()");
    }
    if (name === "fs" && m.promises)
      for (const key of Object.keys(m.promises)) wrapFn(m.promises, key, inputs, "fs.promises." + key + "()");
  }
  wrapFn(require("worker_threads"), "Worker", effects, "new Worker()");
  // Async resources the load creates. A promise alone is no work (an async
  // function that returns at once creates one); a reaction to a promise
  // the load created (then/catch/finally, an await) is.
  const loadPromises = new Set();
  const hook = asyncHooks.createHook({
    init(id, type, trigger) {
      // Timers and immediates are the timer wrappers' to account for.
      if (type === "Timeout" || type === "Immediate" || !recording) return;
      if (type === "PROMISE") {
        if (loadPromises.has(trigger)) {
          internalCaller();
          effects.push("a promise reaction (" + lastCaller + ")");
        } else if (!internalCaller()) {
          loadPromises.add(id);
        }
        return;
      }
      if (!internalCaller()) effects.push("async work (" + type + ", " + lastCaller + ")");
    },
  });
  hook.enable();
  undo.push(() => hook.disable());
  // The closure: a resolve hook (no frame of ours stays on the stack while
  // modules evaluate, so Node's node_modules checks see the real callers).
  const hooks = Module.registerHooks({
    resolve(specifier, context, nextResolve) {
      const result = nextResolve(specifier, context);
      if (recording && typeof result.url === "string" && result.url.startsWith("file:"))
        files.add(require("node:url").fileURLToPath(result.url));
      return result;
    },
  });
  undo.push(() => hooks.deregister());
  const watched = [
    ["globalThis", globalThis], ["Object", Object], ["Object.prototype", Object.prototype],
    ["Function.prototype", Function.prototype], ["Array", Array], ["Array.prototype", Array.prototype],
    ["String.prototype", String.prototype], ["Number.prototype", Number.prototype],
    ["Boolean.prototype", Boolean.prototype], ["Symbol", Symbol], ["Symbol.prototype", Symbol.prototype],
    ["Promise", Promise], ["Promise.prototype", Promise.prototype], ["Error", Error],
    ["Error.prototype", Error.prototype], ["RegExp.prototype", RegExp.prototype],
    ["Map.prototype", Map.prototype], ["Set.prototype", Set.prototype], ["JSON", JSON],
    ["Math", Math], ["Reflect", Reflect], ["process", process], ["Buffer", Buffer],
    ["Buffer.prototype", Buffer.prototype],
  ];
  for (const name of ["fs", "path", "events", "stream", "util", "os", "child_process", "http", "https",
    "net", "url", "buffer", "crypto", "zlib", "module", "assert", "string_decoder", "timers", "tty",
    "fs/promises", "stream/promises", "util/types", "constants", "querystring", "readline"]) {
    try { watched.push([name, require(name)]); } catch {}
  }
  try { watched.push(["events.prototype", require("events").prototype]); } catch {}
  try { watched.push(["stream.prototype", require("stream").prototype]); } catch {}
  const shot = () => watched.map(([name, o]) => {
    const m = new Map();
    for (const k of Reflect.ownKeys(o)) {
      const d = Object.getOwnPropertyDescriptor(o, k);
      m.set(k, d === undefined ? undefined : "value" in d ? d.value : d.get);
    }
    return [name, m];
  });

  const results = [];
  for (const path of input.modules) {
    inputs.length = volatile.length = effects.length = 0;
    pendingTimers.clear();
    loadPromises.clear();
    tty.clear(); envKeys.clear(); files.clear();
    files.add(path);
    currentFiles = files;
    currentPackageDir = null;
    for (let d = require("node:path").dirname(path); d !== require("node:path").dirname(d); d = require("node:path").dirname(d)) {
      if (require("node:fs").existsSync(d + "/package.json")) { currentPackageDir = d; break; }
    }
    const before = shot();
    let exportsValue, threw;
    recording = true;
    try { exportsValue = createRequire(path)(path); } catch (e) { threw = String((e && e.message) || e); }
    recording = false;
    const after = shot();
    const root = threw === undefined ? value(exportsValue, 0) : undefined;
    const mutations = [];
    for (let i = 0; i < before.length; i++) {
      const [name, b] = before[i];
      const a = after[i][1];
      for (const [k, v] of a) if (!b.has(k) || !Object.is(b.get(k), v)) mutations.push(name + "." + String(k));
      for (const k of b.keys()) if (!a.has(k)) mutations.push("delete " + name + "." + String(k));
    }
    // Node's own undici creates its global-dispatcher symbol lazily, at
    // times unrelated to the module; only code that names it can set it.
    const names = (key) => {
      for (const f of files) {
        try { if (require("node:fs").readFileSync(f, "utf8").includes(key)) return true; } catch {}
      }
      return false;
    };
    for (let i = mutations.length - 1; i >= 0; i--) {
      const m = /^globalThis\.Symbol\((undici\.globalDispatcher\.\d+)\)$/.exec(mutations[i]);
      if (m !== null && !names("undici.globalDispatcher")) mutations.splice(i, 1);
    }
    const record = {
      path,
      inputs: [...new Set(inputs)],
      volatile: [...new Set(volatile)],
      effects: [...new Set(effects.filter((x) => x !== null))],
      mutations,
      env: [...envKeys],
      tty: [...tty],
      files: [...files],
    };
    if (threw !== undefined) { record.throws = threw; results.push(record); continue; }
    if (!("o" in root)) { record.reason = "its value is not an object"; results.push(record); continue; }
    record.root = root.o;
    results.push(record);
  }
  for (const u of undo.reverse()) u();
  return { results, objects };
};
`;
