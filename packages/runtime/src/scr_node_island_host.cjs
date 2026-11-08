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
const {
  createRequire,
  enableCompileCache,
  flushCompileCache,
  getCompileCacheDir,
  isBuiltin,
  registerHooks,
} = require("node:module");
const { constants: osConstants } = require("node:os");
const timers = require("node:timers");

const nativeHost = globalThis.__scriptcNodeIslandHost;

// Node's module compile cache, before any module of the program loads. The
// directory is one the runtime made and vouches for (scr_node_island.c,
// "Node's compile cache"); it passes none when NODE_COMPILE_CACHE names the
// user's own, which Node has enabled by now, or when there is to be no
// cache. Node writes the entries of the modules a run compiled when it
// stops, and the runtime writes them when native code calls process.exit();
// a program that is only ever ended by a signal reaches neither, so they are
// also written once, a second after the start, when a program that is still
// running has its start behind it, by a timer that keeps no program alive.
const compileCache = globalThis.__scriptcNodeIslandCompileCache;
delete globalThis.__scriptcNodeIslandCompileCache;
if (typeof compileCache === "string") enableCompileCache(compileCache);
if (getCompileCacheDir() !== undefined) timers.setTimeout(() => flushCompileCache(), 1000).unref();

// The process state the program already has (scr_node_island.c prefixes
// this script with it): process.argv is the program's own, so island code
// that parses the command line reads the arguments the program was started
// with, and a Node that starts during the exit sequence is exiting too
// (process.nextTick drops its callbacks, as it does in an 'exit' listener).
const programProcess = globalThis.__scriptcNodeIslandProcess;
delete globalThis.__scriptcNodeIslandProcess;
if (programProcess !== undefined) {
  process.argv = programProcess.argv;
  if (programProcess.exiting) process._exiting = true;
}

// The program's island module tree (scr_node_island.c prefixes this script
// with its root, then the bridge removes the global): modules resolve only
// to files inside it, never to a file elsewhere on the machine.
const islandRoot = globalThis.__scriptcNodeIslandRoot;
delete globalThis.__scriptcNodeIslandRoot;
if (typeof islandRoot === "string" && islandRoot !== "/") {
  const { realpathSync } = require("node:fs");
  const { sep } = require("node:path");
  const { fileURLToPath } = require("node:url");
  const root = realpathSync(islandRoot);
  const inside = root.endsWith(sep) ? root : root + sep;
  registerHooks({
    resolve(specifier, context, nextResolve) {
      const result = nextResolve(specifier, context);
      if (result.url.startsWith("file:") && !fileURLToPath(result.url).startsWith(inside)) {
        const error = new Error(
          `Cannot find module '${specifier}': it is not one of the modules this program ships`,
        );
        error.code = "MODULE_NOT_FOUND";
        throw error;
      }
      return result;
    },
  });
  // Registered after the guard, so it answers first: what the program's
  // load plan holds is a file of the tree (scr_node_island_hooks.cjs).
  scriptcLoadPlan(root, islandRoot);
}

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
    // Own enumerable keys, as structuredClone copies them: holes stay holes
    // and named properties come along.
    const out = new Array(value.length);
    memo.set(value, out);
    for (const key of Object.keys(value)) out[key] = plainCopy(value[key], memo);
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

// Errors by which Node says it did not find a file, thrown while a call's
// module loaded, before its function ran. The runtime may put back files
// the installed module tree lost and repeat such a call (scr_node_island.c,
// "What a start does"); once the function has run, a call is never
// repeated.
const loadFailures = new WeakSet();
const MISSING_FILE_CODES = new Set(["MODULE_NOT_FOUND", "ERR_MODULE_NOT_FOUND", "ENOENT"]);

function loadedFunction(file, specifier, name) {
  try {
    return exportedFunction(file, specifier, name);
  } catch (error) {
    try {
      if (error instanceof Error && MISSING_FILE_CODES.has(error.code)) loadFailures.add(error);
    } catch {
      // An error whose code cannot be read is not one of Node's.
    }
    throw error;
  }
}

function invokeSync(file, specifier, name, args) {
  const { fn, namespace } = loadedFunction(file, specifier, name);
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
  const { fn, namespace } = loadedFunction(file, specifier, name);
  return await Reflect.apply(fn, namespace, args);
}

function errorKind(error) {
  for (const [constructor, kind] of ERROR_KINDS) if (error instanceof constructor) return kind;
  return 0;
}

// A thrown value crosses as a copy: an Error as its nearest intrinsic
// class with its message and string code, anything else as JSON data. An
// error whose class, message or code cannot be read crosses as an Error
// with an empty message.
function thrown(error) {
  try {
    return thrownCopy(error);
  } catch {
    return 'T{"error":{"kind":0,"message":""}}';
  }
}

function thrownCopy(error) {
  if (error instanceof Error) {
    const copy = { kind: errorKind(error), message: String(error.message) };
    if (typeof error.code === "string") copy.code = error.code;
    if (loadFailures.has(error)) copy.load = true;
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
const Module = require("node:module");

// ToPrimitive for the runtime's String(), template literals, `+` and
// numeric conversions of island objects (scr_node_island_handle.c loads it
// as "scriptc:toPrimitive").
function toPrimitive(value, hint) {
  const exotic = value[Symbol.toPrimitive];
  if (exotic !== undefined && exotic !== null) {
    if (typeof exotic !== "function") {
      throw new TypeError(`${String(exotic)} is not a function`);
    }
    const result = Reflect.apply(exotic, value, [hint]);
    if (result !== null && (typeof result === "object" || typeof result === "function")) {
      throw new TypeError("Cannot convert object to primitive value");
    }
    return result;
  }
  const order = hint === "string" ? ["toString", "valueOf"] : ["valueOf", "toString"];
  for (const name of order) {
    const method = value[name];
    if (typeof method === "function") {
      const result = Reflect.apply(method, value, []);
      if (result === null || (typeof result !== "object" && typeof result !== "function")) {
        return result;
      }
    }
  }
  throw new TypeError("Cannot convert object to primitive value");
}

// Helpers for native classes extending island classes (scope-B NI-5b),
// reached by the runtime as the module "scriptc:island-helpers". A native
// subclass is a JavaScript constructor whose instances Reflect.construct
// builds through the island base, so island code sees an instance of the
// base and `instanceof` holds on both sides; the native constructor runs
// with a box as `this` until its super() call constructs the instance
// (superConstruct), field initializers run right after (the native
// `fields` function), and the native methods and accessors sit on the
// subclass prototype.
const MUST_CALL_SUPER =
  "Must call super constructor in derived class before accessing 'this' or returning from derived constructor";
class SuperBox {
  constructor(base, target, fields) {
    this.base = base;
    this.target = target;
    this.fields = fields;
    this.self = undefined;
  }
}
// The intrinsic classes a native `instanceof Error` (and its builtin
// subclasses) asks about island values, captured before island code runs.
const INTRINSIC_CLASSES = {
  Error,
  TypeError,
  RangeError,
  SyntaxError,
  ReferenceError,
  EvalError,
  URIError,
  AggregateError,
};
const collectionSyncs = new WeakMap();

// ── twins (scr_node_bridge.h SCR_NVF_TWIN) ───────────────────────────────
// A native object of a platform class whose receivers here test its brand
// (fetch, addEventListener's `signal`, AbortSignal.any, events.once and
// timers/promises all refuse anything but a real AbortSignal) crosses as a
// real object of this realm's class: its twin. One twin per native object
// while either side holds it, and the native object again when the twin
// crosses back. Each class says how to make a twin, how the twin takes its
// native object's state when it becomes that object's representative
// (`start`), and what the native side tells it afterwards (`tell`).
// `native` reads a property of the native object (`get`), calls one of
// its methods (`invoke`) and tells it what changed here (`tell`).
//
// The other way, an object of such a class made here that reaches native
// code is adopted: a native object stands for it there, and this object is
// that native object's representative (`adopt` says how it keeps the native
// object in step). twinPrototypes tells the bridge which objects those are.
const TWIN_GET = 16;
const TWIN_INVOKE = 17;
const TWIN_TELL = 18;
const twinStates = new WeakMap(); // twin -> { cls, native, adopted }

function twinNative(op) {
  return {
    get: (key) => op(TWIN_GET, key),
    invoke: (method, ...args) => op(TWIN_INVOKE, method, ...args),
    tell: (event, value) => op(TWIN_TELL, event, value),
  };
}
const nodeAbort = AbortController.prototype.abort;
// The controller of each AbortSignal twin: it aborts the twin when the
// native signal aborts, and it is the twin of the native AbortController.
const twinControllers = new WeakMap();

// A reason that cannot cross reaches the twin as the error that says so.
function nativeReason(native) {
  try {
    return native.get("reason");
  } catch (error) {
    return error;
  }
}

const twinClasses = {
  AbortSignal: {
    prototype: AbortSignal.prototype,
    make() {
      const controller = new AbortController();
      twinControllers.set(controller.signal, controller);
      return controller.signal;
    },
    start(signal, native) {
      if (native.get("aborted")) this.tell.abort(signal, nativeReason(native));
    },
    // A signal made here reached native code, where a native signal now
    // stands for it. That one aborts when this one does: through a signal
    // of the bootstrap's that follows this one, so this signal's own
    // listeners are the island's only and run before the native ones.
    adopt(signal, native) {
      if (signal.aborted) {
        native.tell("abort", signal.reason);
        return;
      }
      const follower = AbortSignal.any([signal]);
      follower.addEventListener("abort", () => native.tell("abort", follower.reason), {
        once: true,
      });
    },
    tell: {
      // The native signal aborted: before its own 'abort' listeners run,
      // so both sides answer `aborted` and `reason` alike in every listener.
      abort(signal, reason) {
        Reflect.apply(nodeAbort, twinControllers.get(signal), [reason]);
      },
    },
  },
  AbortController: {
    // The controller of the native signal's twin. Its abort() aborts the
    // native signal, which aborts the twin (tell.abort), so the two sides
    // change together whichever side aborts.
    make(native) {
      const controller = twinControllers.get(native.get("signal"));
      Object.defineProperty(controller, "abort", {
        value: function abort(reason = undefined) {
          if (this !== controller) return Reflect.apply(nodeAbort, this, arguments);
          native.invoke("abort", reason);
        },
        writable: true,
        enumerable: false,
        configurable: true,
      });
      return controller;
    },
    start() {},
    tell: {},
  },
};

// Values the bridge pairs one to one with runtime objects (byte views and
// symbols), answered by intrinsics captured before island code runs. A
// symbol is [kind, text]: 0 unique (its description), 1 unique without a
// description, 2 registered (its Symbol.for key), 3 well-known (its name on
// Symbol), the numbering of SCR_NODE_SYMBOL_*.
const symbolFor = Symbol.for;
const symbolKeyFor = Symbol.keyFor;
// Own-property probes of an island object: the intrinsics, never the
// object's own methods, which may be shadowed or absent (a null-prototype
// object).
const objectHasOwn = Object.hasOwn;
const propertyIsEnumerable = Object.prototype.propertyIsEnumerable;
const wellKnownNames = new Map();
const wellKnownSymbols = new Map();
for (const name of Object.getOwnPropertyNames(Symbol)) {
  if (typeof Symbol[name] !== "symbol") continue;
  wellKnownNames.set(Symbol[name], name);
  wellKnownSymbols.set(name, Symbol[name]);
}
const islandHelpers = {
  makeTwin(name, op) {
    const cls = twinClasses[name];
    const native = twinNative(op);
    const twin = cls.make(native);
    twinStates.set(twin, { cls, native, adopted: false });
    return twin;
  },
  // An object made here became the representative of the native object
  // that adopts it.
  adoptTwin(name, twin, op) {
    twinStates.set(twin, { cls: twinClasses[name], native: twinNative(op), adopted: true });
  },
  startTwin(twin) {
    const state = twinStates.get(twin);
    if (state === undefined) return;
    if (state.adopted) state.cls.adopt(twin, state.native);
    else state.cls.start(twin, state.native);
  },
  // The class that adopts `value`, by its prototype, or undefined. A value
  // that a native object adopted since its handle was made (the same
  // object twice in one argument list) answers itself: it crosses back as
  // that native object.
  twinClassOf(value) {
    if (twinStates.has(value)) return value;
    const prototype = Object.getPrototypeOf(value);
    for (const name of Object.keys(twinClasses)) {
      const cls = twinClasses[name];
      if (cls.adopt !== undefined && cls.prototype === prototype) return name;
    }
    return undefined;
  },
  twinReady(twin) {
    return twinStates.has(twin);
  },
  tellTwin(name, event, twin, value) {
    twinClasses[name].tell[event](twin, value);
  },
  bufferPrototype: Buffer.prototype,
  symbolInfo(symbol) {
    const key = symbolKeyFor(symbol);
    if (key !== undefined) return [2, key];
    const name = wellKnownNames.get(symbol);
    if (name !== undefined) return [3, name];
    const description = symbol.description;
    return description === undefined ? [1, ""] : [0, description];
  },
  symbolOf(kind, text) {
    return kind === 2 ? symbolFor(text) : wellKnownSymbols.get(text);
  },
  isInstance(value, name) {
    // The error classes by their intrinsics; any other standard class by
    // the global of that name (Array, Map, Date, …).
    const C = INTRINSIC_CLASSES[name] ?? globalThis[name];
    return typeof C === "function" && value instanceof C;
  },
  subclass(Base, name, ctor, fields, methods, getters, setters) {
    const C = {
      [name]: function (...args) {
        if (new.target === undefined)
          throw new TypeError(`Class constructor ${name} cannot be invoked without 'new'`);
        if (typeof ctor !== "function") {
          const self = Reflect.construct(Base, args, new.target);
          if (typeof fields === "function") Reflect.apply(fields, self, []);
          return self;
        }
        const box = new SuperBox(Base, new.target, fields);
        const result = Reflect.apply(ctor, box, args);
        // As a derived constructor: an object it returns is the result.
        if (result !== undefined) {
          if (result !== null && (typeof result === "object" || typeof result === "function"))
            return result;
          throw new TypeError("Derived constructors may only return object or undefined");
        }
        if (box.self === undefined) throw new ReferenceError(MUST_CALL_SUPER);
        return box.self;
      },
    }[name];
    // The class's length is its constructor's (the native function reports
    // the length Node gives the declaration); without one it is 0, as for
    // a derived class's implicit constructor.
    if (typeof ctor === "function")
      Object.defineProperty(C, "length", { value: ctor.length, configurable: true });
    Object.setPrototypeOf(C, Base);
    const proto = Object.create(Base.prototype, {
      constructor: { value: C, writable: true, configurable: true },
    });
    for (const key of Object.keys(methods))
      Object.defineProperty(proto, key, {
        value: methods[key],
        writable: true,
        configurable: true,
      });
    const accessors = new Set([...Object.keys(getters), ...Object.keys(setters)]);
    for (const key of accessors)
      Object.defineProperty(proto, key, {
        get: getters[key],
        set: setters[key],
        configurable: true,
      });
    Object.defineProperty(C, "prototype", { value: proto, writable: false });
    return C;
  },
  superConstruct(box, ...args) {
    if (!(box instanceof SuperBox)) throw new ReferenceError(MUST_CALL_SUPER);
    if (box.self !== undefined)
      throw new ReferenceError("Super constructor may only be called once");
    const self = Reflect.construct(box.base, args, box.target);
    box.self = self;
    if (typeof box.fields === "function") Reflect.apply(box.fields, self, []);
    return self;
  },
  superMethod(Base, self, name, ...args) {
    return Reflect.apply(Reflect.get(Base.prototype, name, self), self, args);
  },
  defineField(self, key, value) {
    Object.defineProperty(self, key, {
      value,
      writable: true,
      enumerable: true,
      configurable: true,
    });
  },
  // A native Map or Set in Node (NI-5b): a real Map/Set (util.types,
  // instanceof) whose prototype's methods run the native operations
  // through `op` (scr_node_bridge.h SCR_NODE_COLLECTION_*).
  makeCollection(isMap, op) {
    const Base = isMap ? Map : Set;
    const proto = Object.create(Base.prototype);
    const methods = {
      has(k) {
        return op(2, k);
      },
      delete(k) {
        Base.prototype.delete.call(this, k);
        return op(3, k);
      },
      clear() {
        Base.prototype.clear.call(this);
        op(4);
      },
      forEach(callback, thisArg) {
        for (const e of op(6)) {
          if (isMap) Reflect.apply(callback, thisArg, [e[1], e[0], this]);
          else Reflect.apply(callback, thisArg, [e, e, this]);
        }
      },
      entries() {
        return Array.from(op(6), (e) => (isMap ? [e[0], e[1]] : [e, e])).values();
      },
      keys() {
        return Array.from(op(6), (e) => (isMap ? e[0] : e)).values();
      },
      values() {
        return Array.from(op(6), (e) => (isMap ? e[1] : e)).values();
      },
    };
    if (isMap) {
      methods.get = function (k) {
        return op(0, k);
      };
      methods.set = function (k, v) {
        op(1, k, v);
        Map.prototype.set.call(this, k, v);
        return this;
      };
    } else {
      methods.add = function (v) {
        op(1, v);
        Set.prototype.add.call(this, v);
        return this;
      };
    }
    for (const key of Object.keys(methods))
      Object.defineProperty(proto, key, {
        value: methods[key],
        writable: true,
        configurable: true,
      });
    Object.defineProperty(proto, "size", { get: () => op(5), configurable: true });
    Object.defineProperty(proto, Symbol.iterator, {
      value: isMap ? methods.entries : methods.values,
      writable: true,
      configurable: true,
    });
    const self = new Base();
    Object.setPrototypeOf(self, proto);
    collectionSyncs.set(self, () => {
      Base.prototype.clear.call(self);
      for (const e of op(6)) {
        if (isMap) Map.prototype.set.call(self, e[0], e[1]);
        else Set.prototype.add.call(self, e);
      }
    });
    return self;
  },
  // The collection's internal slots mirror the native contents, for what
  // reads them directly (util.inspect): refreshed at every crossing and by
  // the island's own writes.
  syncCollection(self) {
    const sync = collectionSyncs.get(self);
    if (sync !== undefined) sync();
  },
  promisify(fn) {
    return require("node:util").promisify(fn);
  },
  // ── process events: one registry ──────────────────────────────────────
  // Once Node is loaded, `process` is the registry of the events Node raises
  // itself (uncaughtException and its monitor, unhandledRejection,
  // rejectionHandled, warning): the program's native listeners are
  // registered here as the functions they are, and the runtime raises its
  // own errors, rejections and warnings through the entries below
  // (scr_node_island_events.c), so one list orders the listeners of both
  // sides and Node's own rules decide what each event does.
  processListen(mode, event, listener) {
    if (mode === 0) process.on(event, listener);
    else if (mode === 1) process.once(event, listener);
    else if (mode === 2) process.prependListener(event, listener);
    else if (mode === 4) process.prependOnceListener(event, listener);
    else process.removeListener(event, listener);
  },
  // An error native code let escape, as Node handles one of its own: the
  // monitors, then the capture callback or the listeners. false: nobody
  // handled it and the runtime reports it; a throw is the listener's own
  // error, which ends the process.
  processUncaught(error, fromPromise) {
    const handled = process._fatalException(error, fromPromise) !== false;
    if (handled && jobs > 0) handledInJob = true;
    return handled;
  },
  // A rejected native promise nobody handles: crossing gave it its V8
  // promise, which rejects without a handler, and Node's own tracking does
  // the rest (unhandledRejection, the --unhandled-rejections mode).
  processRejected(_promise) {},
  // Native code attached a handler to a native promise V8 tracks: its V8
  // promise is handled too (rejectionHandled, when Node already reported it).
  processHandled(promise) {
    Promise.prototype.then.call(promise, undefined, () => {});
  },
  // A warning native code emitted, as process.emitWarning's own tick emits
  // it: Node's listener prints it, then the program's listeners run. The
  // V8 error a native warning crosses as has its name, message and stack;
  // its code and detail, which Node's report prints, come beside it. While
  // native code has process.noDeprecation set, Node's report reads it as set
  // for this warning, and finds its own value again afterwards.
  processWarning(warning, noDeprecation, code, detail) {
    if (warning !== null && typeof warning === "object") {
      if (typeof code === "string" && warning.code === undefined) warning.code = code;
      if (typeof detail === "string" && warning.detail === undefined) warning.detail = detail;
    }
    if (!noDeprecation || process.noDeprecation) {
      process.emit("warning", warning);
      return;
    }
    const own = Object.getOwnPropertyDescriptor(process, "noDeprecation");
    process.noDeprecation = true;
    try {
      process.emit("warning", warning);
    } finally {
      if (own === undefined) delete process.noDeprecation;
      else Object.defineProperty(process, "noDeprecation", own);
    }
  },
  // process.exitCode is Node's property once Node is loaded: the runtime
  // writes it here and reads it back. An unset code (undefined or null) is
  // null, which is not 0.
  processExitCode(set, code) {
    if (set) process.exitCode = code;
    const current = process.exitCode;
    return current === undefined || current === null ? null : Number(current);
  },
  // The program changed directory with its own system call. Node caches
  // process.cwd() until its own process.chdir runs: changing to "." keeps
  // the directory and drops the cached answer.
  processChdir() {
    process.chdir(".");
  },
  // The V8 error a native error crosses as (scr_ni_error_link).
  same(value) {
    return value;
  },
  // clearTimeout (0), clearInterval (1) or clearImmediate (2) of an island
  // value the program holds: Node's own function.
  clearTimer(which, timer) {
    clearFunctions[which](timer);
  },
};

// Island imports of modules the program shares resolve to their native
// exports (NI-6, scr_node_island_hooks.cjs, appended to this file).
let sharedModules = null;

function load(path, esm) {
  if (path === "scriptc:toPrimitive") return toPrimitive;
  if (path === "scriptc:spread") return (value) => [...value];
  if (path === "scriptc:clone") return (value) => structuredClone(value);
  if (path === "scriptc:objectTag") return (value) => Object.prototype.toString.call(value);
  if (path === "scriptc:hasOwn") return (object, key) => objectHasOwn(object, key);
  if (path === "scriptc:isEnumerable")
    return (object, key) => propertyIsEnumerable.call(object, key);
  if (path === "scriptc:island-helpers") return islandHelpers;
  // The runtime's process.exit(): the compile cache's new entries.
  if (path === "scriptc:flushCompileCache") return flushCompileCache();
  // A built-in module's name, with or without the node: prefix.
  if (isBuiltin(path)) return require(path);
  if (sharedModules === null) sharedModules = scriptcSharedModules(nativeHost);
  if (esm) return import(pathToFileURL(path).href);
  // No CommonJS parent, as when Node's ES-module loader imports CommonJS
  // (the program's entry is an ES module): `module.parent` is undefined
  // and MODULE_NOT_FOUND require stacks start at the island module. A
  // module the program shares loads through its entry first (NI-6).
  return sharedModules.entry(path, (entry) => {
    if (entry !== null) createRequire(path)(entry);
    return Module._load(path, undefined, false);
  });
}

function sharedPush(mod, slot, value) {
  if (sharedModules !== null) sharedModules.push(mod, slot, value);
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

// A runtime job that let an error escape which the uncaughtException
// listeners then handled (islandHelpers.processUncaught, called by the
// runtime before `run` returns) ends as a JavaScript callback that threw
// does: with a throw, so Node's tick, timer and immediate loops go on
// exactly as after a handled error of their own (the rest of the tick queue
// waits for the next callback, the next timer of the list runs before the
// ticks the listener queued). HANDLED is that throw; process._fatalException
// below answers that it was handled without raising anything.
const HANDLED = new Error("scriptc: a handled runtime error");
let jobs = 0;
let handledInJob = false;

function runJob(kind, token) {
  jobs++;
  try {
    nativeHost.run(kind, token);
  } finally {
    jobs--;
  }
  if (handledInJob) {
    handledInJob = false;
    throw HANDLED;
  }
}

const nodeFatalException = process._fatalException;
process._fatalException = function (error) {
  if (error === HANDLED) return true;
  return Reflect.apply(nodeFatalException, this, arguments);
};

function onTick(token) {
  runJob(JOB_TICK, token);
}

function onTimer(token) {
  runJob(JOB_TIMER, token);
}

function onImmediate(handle, token) {
  handles.delete(handle);
  runJob(JOB_IMMEDIATE, token);
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

// ── timers across the boundary ───────────────────────────────────────────
// A timer or immediate the program created is a number in island code, as
// it is in the program: its id, which starts at 2^52 in a program with
// islands, a range Node's own timer ids (async ids) do not reach. Node's
// clear functions accept such a number and clear the program's handle of that
// kind through the runtime's own clear (scr_loop_hosted_run in scr_async.c,
// whose job kinds these are), so the runtime releases its callback and its
// count of live timers stays right; a clear of the other kind's number finds
// nothing to clear, as in Node. Every other value is Node's to clear.
const TIMER_ID_BASE = 2 ** 52;
const JOB_CLEAR_TIMER = 16;
const JOB_CLEAR_IMMEDIATE = 16 | 8;

function programTimerId(value) {
  if (typeof value !== "number" && typeof value !== "string") return 0;
  const id = typeof value === "string" ? Number(value) : value;
  return Number.isInteger(id) && id > TIMER_ID_BASE && id < 2 * TIMER_ID_BASE ? id : 0;
}

function clearProgramTimer(job, id) {
  const offset = id - TIMER_ID_BASE;
  nativeHost.run(job | (Math.floor(offset / 2 ** 32) << 8), offset >>> 0);
}

function clearFunction(name, job) {
  const nodeClear = timers[name];
  // The wrapper has the name and length of the Node function it replaces.
  const clear = {
    [name](timer) {
      const id = programTimerId(timer);
      if (id !== 0) return clearProgramTimer(job, id);
      return Reflect.apply(nodeClear, this, arguments);
    },
  }[name];
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
  timers[name] = clear;
  if (descriptor !== undefined)
    Object.defineProperty(globalThis, name, { ...descriptor, value: clear });
  return clear;
}
const clearFunctions = [
  clearFunction("clearTimeout", JOB_CLEAR_TIMER),
  clearFunction("clearInterval", JOB_CLEAR_TIMER),
  clearFunction("clearImmediate", JOB_CLEAR_IMMEDIATE),
];

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
// Not a process event: from a tick of its own, the runtime asks for the
// rest of the current turn before it decides its unhandled rejections
// (scr_async.c, scr_hosted_deciding_tick). Node's tick callback, the
// function Node runs after every callback, runs the tick queue and the
// microtasks to exhaustion and then decides Node's rejections, so the
// runtime decides where Node does. A throw from a tick leaves `emit`
// through MakeCallback as an uncaught exception, so the runtime hears
// JOB_TURN only when the turn ran to its end.
const EVENT_TURN = 3;
const JOB_TURN = 5;
const runNextTicks = process._tickCallback;
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
  islandListeners.push({ event, listener, id, raw: undefined });
  nativeHost.listen(kind, event, id, 1, 0);
});

function forget(i, kind) {
  const entry = islandListeners[i];
  islandListeners.splice(i, 1);
  nativeHost.listen(kind, entry.event, entry.id, 0, 0);
}

process.on("removeListener", (event, listener) => {
  const kind = eventKind(event);
  if (kind === 0) return;
  // Node reports the removed registration as the raw listener it installed (a
  // once wrapper removing itself reports the wrapper) or as the listener
  // itself. The raw listener each entry recorded separates a once
  // registration from an `on` registration of the same function: the removed
  // one is the entry whose raw listener is no longer on `process`.
  const live = process.rawListeners(event);
  let same = -1;
  for (let i = islandListeners.length - 1; i >= 0; i--) {
    const entry = islandListeners[i];
    if (entry.event !== event) continue;
    if (entry.listener !== listener && entry.raw !== listener) continue;
    if (entry.raw !== undefined && !live.includes(entry.raw)) {
      forget(i, kind);
      return;
    }
    if (same < 0) same = i;
  }
  // Duplicate registrations of one function share a raw listener; Node
  // removes the most recent, which is the last matching entry.
  if (same >= 0) forget(same, kind);
});

// The raw listener is the function handed to the emitter (a once wrapper
// for process.once, which registers through process.on): tag each entry
// with it as its registration returns. Node emits newListener before it
// installs the listener, so the entry learns its raw only afterwards.
function tagRaw(start, event, listener) {
  if (islandListeners.length === start) return;
  const registered = listener.listener ?? listener;
  for (let i = start; i < islandListeners.length; i++) {
    const entry = islandListeners[i];
    if (entry.event === event && entry.listener === registered && entry.raw === undefined) {
      entry.raw = listener;
      return;
    }
  }
}

// The wrappers replacing process's emitter methods, installed together by
// installProcessMethods below. One wrapper serves `on` and `addListener`,
// which are one function in Node, and each has the name of the Node function
// it wraps.
const processMethods = {};
const nodeAddListener = process.addListener;
const nodePrependListener = process.prependListener;
processMethods.on = processMethods.addListener = function addListener(event, listener) {
  const start = islandListeners.length;
  const result = Reflect.apply(nodeAddListener, this, arguments);
  tagRaw(start, event, listener);
  return result;
};
processMethods.prependListener = function prependListener(event, listener) {
  const start = islandListeners.length;
  const result = Reflect.apply(nodePrependListener, this, arguments);
  tagRaw(start, event, listener);
  return result;
};

function emit(kind, id, name, arg) {
  if (kind === EVENT_TURN) {
    runNextTicks();
    nativeHost.run(JOB_TURN, 0);
    return;
  }
  // The runtime's exit sequence began (it announces it with listener 0
  // before the first 'exit' listener of either side): process._exiting is
  // true from here on, as in Node, so process.nextTick drops its callbacks.
  if (kind === EVENT_EXIT) process._exiting = true;
  const entry = islandListeners.find((e) => e.id === id);
  if (entry === undefined) return;
  // The registered function: the listener itself, or its once wrapper,
  // which removes itself before calling it.
  const registered =
    entry.raw ??
    process.rawListeners(entry.event).find((raw) => (raw.listener ?? raw) === entry.listener);
  if (registered === undefined) return;
  if (kind === EVENT_SIGNAL) Reflect.apply(registered, process, [name, arg]);
  else Reflect.apply(registered, process, [arg]);
}

const nodeEmit = process.emit;
processMethods.emit = function emit(event, ...args) {
  if (event === "exit") return this.listenerCount("exit") > 0;
  return Reflect.apply(nodeEmit, this, [event, ...args]);
};

// Node's process inherits its emitter methods from EventEmitter.prototype,
// through a prototype of its own that holds only `constructor`. The wrappers
// go on that prototype with EventEmitter.prototype's attributes, so process
// has no own property for them: Object.keys(process), Object.hasOwn and
// for...in see what they see in Node. for...in lists a prototype's keys
// before its parent's, so the keys EventEmitter.prototype lists before the
// last wrapped method are defined there too, with the same values, in their
// order.
function installProcessMethods() {
  const processPrototype = Object.getPrototypeOf(process);
  const emitterPrototype = Object.getPrototypeOf(processPrototype);
  const keys = Object.keys(emitterPrototype);
  const last = Math.max(...Object.keys(processMethods).map((key) => keys.indexOf(key)));
  for (const key of keys.slice(0, last + 1)) {
    const descriptor = Object.getOwnPropertyDescriptor(emitterPrototype, key);
    if (Object.hasOwn(processMethods, key)) descriptor.value = processMethods[key];
    Object.defineProperty(processPrototype, key, descriptor);
  }
}
installProcessMethods();

// Writes reach the shared stdout and stderr before control returns to the
// program, as the program's own writes do.
for (const stream of [process.stdout, process.stderr]) {
  if (stream._handle && typeof stream._handle.setBlocking === "function")
    stream._handle.setBlocking(true);
}

// process.execPath is this program, not a node executable: a fork without
// an execPath of its own would start the program again.
const childProcess = require("node:child_process");
const nodeFork = childProcess.fork;
childProcess.fork = function fork(modulePath, args, options) {
  const forkOptions = Array.isArray(args) ? options : args;
  const execPath =
    forkOptions === null || typeof forkOptions !== "object" ? undefined : forkOptions.execPath;
  if (execPath === undefined || execPath === process.execPath) {
    throw new Error(
      "child_process.fork() in a Node island needs options.execPath (a node executable): process.execPath is this program",
    );
  }
  return Reflect.apply(nodeFork, this, arguments);
};
require("node:module").syncBuiltinESMExports();

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
  sharedPush,
  // The prototypes of the classes whose objects native code adopts.
  twinPrototypes: Object.values(twinClasses)
    .filter((cls) => cls.adopt !== undefined)
    .map((cls) => cls.prototype),
};
