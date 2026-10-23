"use strict";
/* The Node island bootstrap: the main script of the Node environment that
 * scr_node_island.c loads into the process on the first call into Node.
 * scr_node_island_host.h embeds this file as a C string; regenerate it
 * with `node scripts/node-island-host.mjs` after every change.
 *
 * The libnode bridge (scr_node_bridge.cc) installs its natives (`settle`,
 * and for the hosted loop `run` and `listen`) as
 * globalThis.__scriptcNodeIslandHost before this script runs, and takes the
 * dispatcher this script leaves as globalThis.__scriptcNodeIsland
 * afterwards (`call` and the hosted-loop helpers); it deletes both globals.
 *
 * A copy of the call semantics lives in packages/node/index.js, which runs
 * them in-process under Node: both must produce the same results, errors
 * and messages. Outcomes are "R<json>" (returned; "R" alone is undefined)
 * or "T<json>" (threw), the encoding of scr_node_bridge.h. */
const { createRequire } = require("node:module");
const { constants: osConstants } = require("node:os");
const timers = require("node:timers");

const nativeHost = globalThis.__scriptcNodeIslandHost;

// Error classes that cross as copies, at their scr_error.h kind index.
const ERROR_KINDS = [
  [TypeError, 1],
  [RangeError, 2],
  [SyntaxError, 3],
  [ReferenceError, 5],
  [EvalError, 6],
  [URIError, 7],
];

// structuredClone of native values (NI-5). A native record, class
// instance or object is an object with interceptors in V8, which V8's
// serializer cannot clone (DataCloneError). Node clones such values as the
// plain data they are, so when a clone fails on a value holding native
// values, it clones a plain copy instead: native values and the plain
// objects and arrays around them are copied (own enumerable string keys,
// shared references and cycles kept), everything else is cloned as is.
const nodeStructuredClone = globalThis.structuredClone;
function plainCopy(value, memo) {
  if (value === null || typeof value !== "object") return value;
  if (memo.has(value)) return memo.get(value);
  const native = nativeHost.isExport(value);
  if (Array.isArray(value)) {
    const out = [];
    memo.set(value, out);
    for (let i = 0; i < value.length; i++) out[i] = plainCopy(value[i], memo);
    return out;
  }
  const proto = Object.getPrototypeOf(value);
  if (!native && proto !== Object.prototype && proto !== null) return value;
  const out = {};
  memo.set(value, out);
  for (const key of Object.keys(value)) out[key] = plainCopy(value[key], memo);
  return out;
}
function holdsNative(value, seen) {
  if (value === null || typeof value !== "object" || seen.has(value)) return false;
  seen.add(value);
  if (nativeHost.isExport(value)) return true;
  const proto = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && proto !== Object.prototype && proto !== null) return false;
  for (const key of Object.keys(value)) if (holdsNative(value[key], seen)) return true;
  return false;
}
if (typeof nodeStructuredClone === "function") {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "structuredClone");
  const structuredClone = {
    structuredClone(value, options = undefined) {
      try {
        return Reflect.apply(nodeStructuredClone, globalThis, arguments);
      } catch (error) {
        if (!holdsNative(value, new Set())) throw error;
        return Reflect.apply(nodeStructuredClone, globalThis, [
          plainCopy(value, new Map()),
          options,
        ]);
      }
    },
  }.structuredClone;
  Object.defineProperty(globalThis, "structuredClone", {
    configurable: descriptor === undefined || descriptor.configurable,
    enumerable: descriptor !== undefined && descriptor.enumerable,
    writable: true,
    value: structuredClone,
  });
}

const requires = new Map();

function exportedFunction(file, specifier, name) {
  let load = requires.get(file);
  if (load === undefined) {
    load = createRequire(file);
    requires.set(file, load);
  }
  const namespace = load(specifier);
  const fn = namespace === null || namespace === undefined ? undefined : namespace[name];
  if (typeof fn !== "function")
    throw new TypeError(`'${name}' exported by '${specifier}' is not a function`);
  return { fn, namespace };
}

function isThenable(value) {
  return (
    value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    typeof value.then === "function"
  );
}

function invokeSync(file, specifier, name, args) {
  const { fn, namespace } = exportedFunction(file, specifier, name);
  const result = Reflect.apply(fn, namespace, args);
  if (isThenable(result)) {
    // The promise is dropped: its rejection must not end the process.
    Promise.resolve(result).catch(() => {});
    throw new TypeError(
      `callSync: '${name}' exported by '${specifier}' returned a promise; use call() for asynchronous functions`,
    );
  }
  return result;
}

async function invokeAsync(file, specifier, name, args) {
  const { fn, namespace } = exportedFunction(file, specifier, name);
  return await Reflect.apply(fn, namespace, args);
}

function errorKind(error) {
  for (const [constructor, kind] of ERROR_KINDS) if (error instanceof constructor) return kind;
  return 0;
}

// A thrown value crosses as a copy: an Error as its nearest intrinsic
// class with its message and string code, anything else as JSON data.
function thrown(error) {
  if (error instanceof Error) {
    const copy = { kind: errorKind(error), message: String(error.message) };
    if (typeof error.code === "string") copy.code = error.code;
    return `T${JSON.stringify({ error: copy })}`;
  }
  let text;
  try {
    text = JSON.stringify(error);
  } catch {
    text = undefined;
  }
  return text === undefined ? 'T{"undefined":true}' : `T{"value":${text}}`;
}

function returned(result) {
  let text;
  try {
    text = JSON.stringify(result);
  } catch (error) {
    return thrown(error);
  }
  return text === undefined ? "R" : `R${text}`;
}

function call(id, sync, file, specifier, name, argsJson) {
  const args = JSON.parse(argsJson);
  if (sync) {
    let result;
    try {
      result = invokeSync(file, specifier, name, args);
    } catch (error) {
      return thrown(error);
    }
    return returned(result);
  }
  invokeAsync(file, specifier, name, args).then(
    (result) => nativeHost.settle(id, returned(result)),
    (error) => nativeHost.settle(id, thrown(error)),
  );
  return undefined;
}

// ── island modules (scope-B NI-4) ──────────────────────────────────────
// Island code loaded by absolute path: require (CommonJS, and require(esm)
// for ES modules without top-level await) answers the exports; import
// answers a promise of the namespace.
const { pathToFileURL } = require("node:url");

function load(path, esm) {
  if (path.startsWith("node:")) return require(path);
  if (esm) return import(pathToFileURL(path).href);
  return createRequire(path)(path);
}

// ── the hosted loop (scope-B NI-3) ─────────────────────────────────────
// The runtime's ticks, timers and immediates are Node's, created here with
// Node's own timers (captured now, so island code replacing the globals
// does not reach them) and run through the native `run`. Handles name the
// Node objects until the runtime clears them.

const JOB_TICK = 2;
const JOB_TIMER = 3;
const JOB_IMMEDIATE = 4;
const handles = new Map();
let nextHandle = 1;

function onTick(token) {
  nativeHost.run(JOB_TICK, token);
}

function onTimer(token) {
  nativeHost.run(JOB_TIMER, token);
}

function onImmediate(handle, token) {
  handles.delete(handle);
  nativeHost.run(JOB_IMMEDIATE, token);
}

function setTimer(delay, repeat, ref, token) {
  let timer;
  if (repeat > 0 && delay === repeat) {
    timer = timers.setInterval(onTimer, repeat, token);
  } else {
    timer = timers.setTimeout(onTimer, delay, token);
    // An interval migrated mid-period: its first run comes after the rest
    // of the period, later ones every `repeat` (Node re-arms a Timeout
    // whose _repeat is set, exactly as for setInterval).
    if (repeat > 0) timer._repeat = repeat;
  }
  if (!ref) timer.unref();
  const handle = nextHandle++;
  handles.set(handle, timer);
  return handle;
}

function clearTimer(handle) {
  const timer = handles.get(handle);
  if (timer === undefined) return;
  handles.delete(handle);
  timers.clearTimeout(timer);
}

function refTimer(handle, ref) {
  const timer = handles.get(handle);
  if (timer !== undefined) {
    if (ref) timer.ref();
    else timer.unref();
  }
}

function refreshTimer(handle) {
  const timer = handles.get(handle);
  if (timer !== undefined) timer.refresh();
}

function setImmediateJob(ref, token) {
  const handle = nextHandle++;
  const immediate = timers.setImmediate(onImmediate, handle, token);
  if (!ref) immediate.unref();
  handles.set(handle, immediate);
  return handle;
}

function clearImmediateJob(handle) {
  const immediate = handles.get(handle);
  if (immediate === undefined) return;
  handles.delete(handle);
  timers.clearImmediate(immediate);
}

function refImmediate(handle, ref) {
  refTimer(handle, ref);
}

function nextTick(token) {
  process.nextTick(onTick, token);
}

// ── process state (scope-B NI-3) ─────────────────────────────────────────
// Signal and 'exit' listeners of island code join the runtime's registries
// at their registration position, so one registry orders both sides and
// the runtime keeps owning every signal disposition: Node's own handlers,
// which would hand a signal to libuv and reset it to SIG_DFL when the last
// listener goes, are taken off. The listeners stay on `process` (listeners
// and listenerCount answer as in Node); the runtime calls them through
// `emit`, and Node's own 'exit' emission is left to the runtime's exit
// sequence.

const EVENT_SIGNAL = 1;
const EVENT_EXIT = 2;
const signalNames = new Set(Object.keys(osConstants.signals));
const islandListeners = [];
let nextListener = 1;

function eventKind(event) {
  if (event === "exit") return EVENT_EXIT;
  return typeof event === "string" && signalNames.has(event) ? EVENT_SIGNAL : 0;
}

for (const [event, name] of [
  ["newListener", "startListeningIfSignal"],
  ["removeListener", "stopListeningIfSignal"],
]) {
  for (const listener of process.listeners(event)) {
    if (listener.name === name) process.removeListener(event, listener);
  }
}

process.on("newListener", (event, listener) => {
  const kind = eventKind(event);
  if (kind === 0) return;
  const id = nextListener++;
  islandListeners.push({ event, listener, id });
  nativeHost.listen(kind, event, id, 1, 0);
});

process.on("removeListener", (event, listener) => {
  const kind = eventKind(event);
  if (kind === 0) return;
  for (let i = islandListeners.length - 1; i >= 0; i--) {
    const entry = islandListeners[i];
    if (entry.event === event && entry.listener === listener) {
      islandListeners.splice(i, 1);
      nativeHost.listen(kind, event, entry.id, 0, 0);
      return;
    }
  }
});

function emit(kind, id, name, arg) {
  const entry = islandListeners.find((e) => e.id === id);
  if (entry === undefined) return;
  // The registered function: the listener itself, or its once wrapper,
  // which removes itself before calling it.
  const registered = process
    .rawListeners(entry.event)
    .find((raw) => (raw.listener ?? raw) === entry.listener);
  if (registered === undefined) return;
  if (kind === EVENT_SIGNAL) Reflect.apply(registered, process, [name, arg]);
  else Reflect.apply(registered, process, [arg]);
}

const nodeEmit = process.emit;
process.emit = function emit(event, ...args) {
  if (event === "exit") return this.listenerCount("exit") > 0;
  return Reflect.apply(nodeEmit, this, [event, ...args]);
};

// Writes reach the shared stdout and stderr before control returns to the
// program, as the program's own writes do.
for (const stream of [process.stdout, process.stderr]) {
  if (stream._handle && typeof stream._handle.setBlocking === "function")
    stream._handle.setBlocking(true);
}

globalThis.__scriptcNodeIsland = {
  call,
  setTimer,
  clearTimer,
  refTimer,
  refreshTimer,
  setImmediate: setImmediateJob,
  clearImmediate: clearImmediateJob,
  refImmediate,
  nextTick,
  emit,
  load,
};
