/* The build-time load recorder of deferred Node islands (scope-B NI-7b).
 * It runs inside libnode in the probe host (snapshot.ts writes it next to
 * the host and the bootstrap requires it), loads every candidate island
 * module once and records, for each:
 *
 *   - what the load read of the machine and the moment. The recorder is a
 *     list of what it knows to be safe, not of what it knows to be dangerous:
 *     everything a load can reach besides the language itself and the
 *     package's own files is in one of four classes, and what is in none of
 *     them keeps the load eager, named in the build trace with the place
 *     that read it.
 *       deterministic: the pure built-ins (the allowlists below), what is
 *         fixed by the libnode pack (process.version, platform, arch), and
 *         the package's own files (boot guards, by size and mtime);
 *       guarded: a value the executable can compare at the import without
 *         starting Node: an environment variable (also behind os.homedir(),
 *         os.tmpdir(), util.debuglog(), the default locale and a TZ that is
 *         set), and whether a standard stream is a terminal (isTTY,
 *         tty.isatty(), and the members only a terminal's stream has);
 *       inputs: a setting of the machine no guard covers (the arguments,
 *         the working directory, the user, the host, the file system, the
 *         time zone of a machine whose TZ is unset, a terminal's size);
 *       volatile: a reading no run repeats, or one whose order against the
 *         program's own readings is observable: the clocks, random numbers,
 *         the process id, resource meters;
 *     a load that read an input or a volatile value evaluates where it is
 *     imported (snapshot.ts);
 *   - effects: output, warnings, process listeners and exits, timers,
 *     immediates, ticks, microtasks and any other async resource created
 *     during the load (promises included), a promise the load leaves
 *     rejected (Node reports it unhandled when the import's turn ends),
 *     child processes, the network, workers, vm, the inspector, native
 *     addons (process.dlopen), writes to process.env;
 *   - mutations of builtin state: globalThis, the builtin prototypes and
 *     constructors, `process`, and the exports of common builtin modules
 *     (island-local, since native code has its own builtins, but
 *     observable by other island modules evaluated out of order);
 *   - every file the load required (the module's closure), and a throw;
 *     a load that resolves a file outside every node_modules directory (the
 *     program's own source) throws before that file evaluates, and its
 *     record is that throw even when the load catches it;
 *
 * and takes the interface snapshot of the module's value (snapshot.ts).
 * Calls made by Node's own internals (the module loader reading files,
 * for instance) are not the module's: a record is kept only when the
 * nearest caller outside this file is not `node:internal/`.
 *
 * Determinism argument: a load that read nothing but guarded values runs
 * the same way in any run whose guards hold (with the same pack and the
 * same files, which the boot guards check, after the same island loads), so
 * one recorded run is the whole truth about its value and its effects, and
 * evaluating it later is unobservable when that run had none. A load that
 * read anything else has no such argument: its value may be another one,
 * the build's reading may be in the shape of what it exports (which members
 * are objects) or in what a later load computed from state it left behind,
 * and for a clock the order against the program's own readings is lost when
 * the load evaluates late. It stays where it is imported.
 *
 * What the lists rest on, and cannot see: a package that reads memory it
 * allocated without initializing it (Buffer.allocUnsafe) or measures how
 * deep the stack is by overflowing it; a value derived from the module's
 * own path that no longer contains the path (the path itself keeps the
 * module eager, snapshot.ts); state behind underscore-prefixed members of
 * Node's own objects. */
export const PROBE_RECORDER = String.raw`"use strict";
const types = require("node:util").types;
const Module = require("node:module");
const { createRequire } = Module;
const asyncHooks = require("node:async_hooks");
const SELF = __filename;

let lastCaller = "";
// Every file of the current load whose code is on the stack of the call at
// lastCaller's depth and below (the call, its requiring module, that
// module's requiring module and so on): a read the call makes is the whole
// chain's, since an importer exports what it read through its dependency.
let lastFiles = [];
// The closure of the module being loaded (files its load resolved), and
// its package directory: code in other files (an earlier module that
// wrapped a builtin, as graceful-fs wraps fs.closeSync) acts for its caller.
let currentFiles = null;
let currentPackageDir = null;
// The file whose import of a builtin's member by name is being recorded:
// the read is that file's, whatever the stack says.
let forcedCaller = null;
function frameFile(line) {
  const m = /\(([^()]+):\d+:\d+\)\s*$/.exec(line) || /at ([^ ()]+):\d+:\d+\s*$/.exec(line);
  if (m === null) return null;
  let f = m[1];
  if (f.startsWith("file://")) { try { f = require("node:url").fileURLToPath(f); } catch {} }
  return f;
}
// The module that asked for a file, from a resolve hook's context.
function parentFile(context) {
  const u = context === undefined || context === null ? undefined : context.parentURL;
  if (typeof u !== "string" || !u.startsWith("file:")) return null;
  try { return require("node:url").fileURLToPath(u); } catch { return null; }
}
// Whose call this is: walking out from the recorder's frames, the first
// frame of the module loader (node:internal/modules/) makes it the
// loader's (reading a module's files); the first frame of other code
// (an island module, outside node:) makes it the module's. Other builtin
// frames (console, streams, a public builtin calling its own exports) act
// for their caller. Once the call is the module's, the frames below it,
// past the loader frames between them, are the modules that required it.
function internalCaller() {
  if (forcedCaller !== null) {
    lastCaller = "an import by name in " + forcedCaller;
    lastFiles = [forcedCaller];
    return false;
  }
  const limit = Error.stackTraceLimit;
  Error.stackTraceLimit = 64;
  const lines = new Error().stack.split("\n");
  Error.stackTraceLimit = limit;
  lastFiles = [];
  let mine = false;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.includes(SELF)) continue;
    if (!mine) {
      if (line.includes("node:internal/modules/")) return true;
      if (/[( ]node:/.test(line)) continue;
      const file = frameFile(line);
      // A frame of the engine itself (a native accessor call, Array.map,
      // Promise.then) acts for whoever called it. With no caller below it,
      // the engine made the call on its own: Node filling the namespace of
      // a builtin for an ES module reads every member of the builtin.
      if (file === null && /\(<anonymous>\)\s*$/.test(line)) continue;
      if (currentFiles !== null && file !== null && !currentFiles.has(file)) continue;
      lastCaller = line.trim().replace(/^at /, "");
      mine = true;
      if (file !== null) lastFiles.push(file);
      continue;
    }
    if (/[( ]node:/.test(line)) continue;
    const file = frameFile(line);
    if (file !== null && currentFiles !== null && currentFiles.has(file) && lastFiles.indexOf(file) < 0)
      lastFiles.push(file);
  }
  return !mine;
}

// Whether the nearest caller outside this file is the module's own code,
// not a builtin acting for it.
function directCaller() {
  const limit = Error.stackTraceLimit;
  Error.stackTraceLimit = 16;
  const lines = new Error().stack.split("\n");
  Error.stackTraceLimit = limit;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.includes(SELF)) continue;
    if (/[( ]node:/.test(line)) return false;
    if (frameFile(line) === null && /\(<anonymous>\)\s*$/.test(line)) continue;
    return !internalCaller();
  }
  return false;
}

const fnToString = Function.prototype.toString;
const hasOwn = Object.prototype.hasOwnProperty;
// A getter that only reads a binding (esbuild's and tsc's export getters):
// reading it again reads the same binding. A member read ('a.b', 'a[b]')
// can invoke another accessor that runs code on every read, so only a bare
// identifier qualifies. Any other getter can also run code on every read,
// so its member is not snapshotted.
const BINDING_GETTER = /^(?:\(\)\s*=>\s*[A-Za-z_$][\w$]*|function\s*[\w$]*\s*\(\)\s*\{\s*return\s+[A-Za-z_$][\w$]*\s*;?\s*\}|get\s+[\w$]+\s*\(\)\s*\{\s*return\s+[A-Za-z_$][\w$]*\s*;?\s*\})$/;
function bindingGetter(fn) {
  let source = "";
  try { source = fnToString.call(fn); } catch { return false; }
  return BINDING_GETTER.test(source.trim());
}
function isConstructor(f) {
  try { Reflect.construct(String, [], f); return true; } catch { return false; }
}
function plainClass(f) {
  // instanceof reads the prototype: without an object there, it throws.
  const proto = Object.getOwnPropertyDescriptor(f, "prototype");
  if (proto === undefined || !("value" in proto)) return false;
  if (proto.value === null || (typeof proto.value !== "object" && typeof proto.value !== "function"))
    return false;
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
        if (depth !== 0 || typeof d.get !== "function" || !bindingGetter(d.get)) continue;
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

  // The modules whose code is the program's own: the ones the build wrote
  // for its island-closed constants, and its modules that run in an island
  // and whose top level the static gate admitted.
  const own = new Set(input.own || []);
  // ── the recorder ──
  const inputs = [], volatile = [], effects = [], tty = new Map(), envKeys = new Map();
  const files = new Set();
  let recording = false;
  // The first program file the current load asked for (the resolve hook),
  // and, for every file a load with a refusal evaluated, that program file:
  // the module cache keeps what such a file exported without it.
  let refused = null;
  const refusedBy = new Map();
  // Evaluating one of the program's own modules (own): the build does not
  // perform what its code would do to the machine.
  // The first effect or input ends the evaluation instead (withheld).
  let withholding = false;
  let withheld = null;
  // What the module's own code read or did (not Node's internals): note
  // checks the caller; a caller that has checked it calls add.
  const add = (list, what) => {
    list.push(what + " (" + lastCaller + ")");
    if (withholding && list !== volatile) {
      if (withheld === null) withheld = what;
      throw new Error("the build does not perform " + what + " for the program");
    }
  };
  const note = (list, what) => {
    if (!recording || internalCaller()) return;
    add(list, what);
  };
  const undo = [];
  // The members the recorder has a rule for, by object: what is left of an
  // object's members after its rules is on its allowlist or not classified.
  const claimed = new Map();
  const claim = (owner, key) => {
    let keys = claimed.get(owner);
    if (keys === undefined) claimed.set(owner, (keys = new Set()));
    keys.add(key);
  };
  const isClaimed = (owner, key) => claimed.has(owner) && claimed.get(owner).has(key);
  // The members read through an accessor of the recorder's, by object: an
  // ES module that imports one by name gets a copy no accessor sees.
  const trapped = new Map();
  // Members the recorder has a rule for and cannot observe (Node makes them
  // not configurable). A load whose files name one is taken to have read it.
  const untrappable = [];
  // Rules that need to fire once per load (a sort comparator calls
  // localeCompare for every pair), by name.
  const fired = new Set();
  // A function in the place of the original that reports the module's calls:
  // to a list under a label, or to list(args, isNew, self) when that is a
  // function (the caller is the module's then, and it calls add).
  const wrapperOf = (original, list, label, once) => {
    const wrapped = function (...a) {
      if (typeof list !== "function") note(list, label);
      else if (recording && !(once !== undefined && fired.has(once)) && !internalCaller()) list(a, new.target !== undefined, this);
      return new.target ? Reflect.construct(original, a, new.target) : original.apply(this, a);
    };
    Object.defineProperty(wrapped, "name", { value: original.name });
    Object.defineProperty(wrapped, "length", { value: original.length });
    // Its statics, own and inherited, and its prototype: what it constructs
    // is an instance of the original.
    for (const k of Reflect.ownKeys(original))
      if (k === "prototype" || !hasOwn.call(wrapped, k)) Object.defineProperty(wrapped, k, Object.getOwnPropertyDescriptor(original, k));
    Object.setPrototypeOf(wrapped, Object.getPrototypeOf(original));
    return wrapped;
  };
  const wrapFn = (owner, key, list, label, once) => {
    claim(owner, key);
    let original;
    try { original = owner[key]; } catch { return undefined; }
    if (typeof original !== "function") return undefined;
    const had = hasOwn.call(owner, key);
    let wrapped;
    try {
      wrapped = wrapperOf(original, list, label, once);
      owner[key] = wrapped;
    } catch { return undefined; }
    undo.push(() => { try { if (had) owner[key] = original; else delete owner[key]; } catch {} });
    return wrapped;
  };
  const wrapGetter = (owner, key, label, onRead) => {
    claim(owner, key);
    const d = Object.getOwnPropertyDescriptor(owner, key);
    if (d !== undefined && !d.configurable) { untrappable.push({ label, key }); return; }
    let keys = trapped.get(owner);
    if (keys === undefined) trapped.set(owner, (keys = new Set()));
    keys.add(key);
    // Without an own property (a pipe's isTTY), reads go to the prototype.
    const own = d !== undefined;
    let shadow;
    Object.defineProperty(owner, key, {
      configurable: true,
      enumerable: own ? d.enumerable : false,
      get() {
        const v = own
          ? (d.get ? d.get.call(this) : d.value)
          : shadow !== undefined ? shadow.v : Reflect.get(Object.getPrototypeOf(owner), key, this);
        if (recording && !internalCaller()) onRead(v);
        return v;
      },
      set(v) {
        note(effects, "a write of " + label);
        if (!own) shadow = { v };
        else if (d.set) d.set.call(this, v);
        else d.value = v;
      },
    });
    undo.push(() => {
      if (own) Object.defineProperty(owner, key, d);
      else delete owner[key];
    });
  };
  // A member no rule lists: the module's call of it (a function) or read of
  // it (anything else) is a source the recorder cannot classify.
  const NOT = ", which the recorder does not classify";
  const unclassified = (owner, key, label) => {
    let d;
    try { d = Object.getOwnPropertyDescriptor(owner, key); } catch { return; }
    if (d !== undefined && "value" in d && typeof d.value === "function") wrapFn(owner, key, inputs, label + "()" + NOT);
    else wrapGetter(owner, key, label, () => add(inputs, label + NOT));
  };
  // Every name an object answers to, its own and its prototypes'.
  const members = (o, stop) => {
    const names = new Set();
    for (let p = o; p !== null && p !== undefined && p !== stop && p !== Object.prototype; p = Object.getPrototypeOf(p))
      for (const k of Object.getOwnPropertyNames(p)) if (k !== "constructor") names.add(k);
    return names;
  };
  const realEnv = process.env;
  // The environment keys each file's code read, kept across the probe's
  // loads. A file the module cache hands to a later load was evaluated in
  // an earlier one, and what it read then is in what it exports now, so its
  // keys belong to every load that receives it.
  const envFiles = new Map();
  const saveEnvFile = (file, k) => {
    if (file === null) return;
    let keys = envFiles.get(file);
    if (keys === undefined) envFiles.set(file, (keys = new Set()));
    keys.add(k);
  };
  const noteEnv = (k, v) => {
    if (!envKeys.has(k)) envKeys.set(k, v);
    for (const f of lastFiles) saveEnvFile(f, k);
  };
  const envValue = (k) => (realEnv[k] === undefined ? null : String(realEnv[k]));
  const readKey = (t, k) => {
    if (recording && typeof k === "string" && !internalCaller())
      noteEnv(k, t[k] === undefined ? null : String(t[k]));
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
  claim(process, "env");
  undo.push(() => { process.env = realEnv; });
  // The default locale and the time zone. Both are the module's reads when
  // these are called (the caller is checked by the wrapper that calls them).
  // ICU takes the default locale from LC_ALL, LC_MESSAGES and LANG, in that
  // order (measured on Linux); elsewhere no guard is known to cover it.
  const locale = () => {
    fired.add("locale");
    if (process.platform === "linux") for (const k of ["LC_ALL", "LC_MESSAGES", "LANG"]) noteEnv(k, envValue(k));
    else add(inputs, "the default locale");
  };
  // The time zone is TZ where it is set. Unset, it is the machine's (a link
  // in /etc), which no boot guard covers.
  const zone = () => {
    fired.add("zone");
    if (realEnv.TZ !== undefined) noteEnv("TZ", String(realEnv.TZ));
    else add(inputs, "the time zone of the machine (TZ is unset)");
  };
  // An argument of a call is looked at only where the engine answers without
  // running the load's own code. A getter, a proxy trap or a conversion run
  // here would run before the call's own: the load would see its accessor
  // read twice, or the second value of one that answers differently each
  // time, and that result would be recorded. An argument only the load's
  // code can answer is an input: the load evaluates where it is imported.
  const descriptorOf = Object.getOwnPropertyDescriptor, prototypeOf = Object.getPrototypeOf;
  const isArray = Array.isArray, applyFn = Reflect.apply;
  const OPAQUE = {};
  const opaque = (what) => add(inputs, what + " that only the load's own code can answer (an accessor, a proxy or a conversion)");
  // The data property key of value, own or inherited: its value,
  // undefined when there is none, OPAQUE behind an accessor or a proxy.
  const dataMember = (value, key) => {
    for (let o = value; o !== null; o = prototypeOf(o)) {
      if (types.isProxy(o)) return OPAQUE;
      const d = descriptorOf(o, key);
      if (d !== undefined) return hasOwn.call(d, "value") ? d.value : OPAQUE;
    }
    return undefined;
  };
  // The Intl services as the recorder found them, and what answers a tag of
  // an Intl.Locale from its own slot.
  const realIntl = {};
  const supportedLocalesOf = new Map();
  for (const k of Object.getOwnPropertyNames(Intl)) {
    const service = Intl[k];
    if (typeof service !== "function" || typeof service.supportedLocalesOf !== "function") continue;
    realIntl[k] = service;
    supportedLocalesOf.set(service, service.supportedLocalesOf);
  }
  const localeTag = typeof Intl.Locale === "function" ? Intl.Locale.prototype.toString : undefined;
  // The tags of a locales argument, or null when reading them would run the
  // load's code: a string, an Intl.Locale, or a plain array of those.
  const tagOf = (v) => {
    if (typeof v === "string") return v;
    if (v === null || typeof v !== "object" || localeTag === undefined) return null;
    try { return applyFn(localeTag, v, []); } catch { return null; }
  };
  const tagsOf = (locales) => {
    const one = tagOf(locales);
    if (one !== null) return [one];
    if (!isArray(locales) || types.isProxy(locales) || locales.length > 64) return null;
    const tags = [];
    for (let i = 0; i < locales.length; i++) {
      const d = descriptorOf(locales, i);
      const tag = d !== undefined && hasOwn.call(d, "value") ? tagOf(d.value) : null;
      if (tag === null) return null;
      tags.push(tag);
    }
    return tags;
  };
  // Whether a locales argument leaves the choice to the default locale:
  // none, an empty list, or tags of which ICU supports none.
  const defaultLocale = (service, locales) => {
    if (locales === undefined) return true;
    const tags = tagsOf(locales);
    if (tags === null) { opaque("a locales argument"); return false; }
    try { return applyFn(supportedLocalesOf.get(service), service, [tags]).length === 0; } catch { return false; }
  };
  const arrayIterator = Array.prototype[Symbol.iterator];
  const arrayIteratorProto = prototypeOf([][Symbol.iterator]());
  const arrayIteratorNext = arrayIteratorProto.next;
  // A value a builtin takes without running the load's code: a primitive.
  const inert = (v) => v === null || (typeof v !== "object" && typeof v !== "function");
  // What the built-in prototypes held before any load: a member added to one
  // since is the load's.
  const namesOf = Object.getOwnPropertyNames;
  const builtinNames = new Map();
  for (const proto of [Object.prototype, Function.prototype, Array.prototype, String.prototype, Number.prototype, Boolean.prototype, BigInt.prototype, Symbol.prototype])
    builtinNames.set(proto, new Set(namesOf(proto)));
  // Whether a call can read every member of an options argument without
  // running the load's code: no proxy, no accessor and no object-valued
  // member (a conversion) on it or its prototypes. Reading one member here
  // is not enough: the call reads others first, and a getter or a
  // conversion among them can remove or replace the member the recorder
  // looked at before the call gets to it.
  const inertOptions = (options) => {
    if (options === undefined || options === null) return true;
    for (let o = inert(options) ? prototypeOf(options) : options; o !== null; o = prototypeOf(o)) {
      if (types.isProxy(o)) return false;
      const builtin = builtinNames.get(o);
      for (const k of namesOf(o)) {
        if (builtin !== undefined && builtin.has(k)) continue;
        const d = descriptorOf(o, k);
        if (!hasOwn.call(d, "value") || !inert(d.value)) return false;
      }
    }
    return true;
  };
  const zoneOption = (options) => {
    if (!inertOptions(options)) { opaque("an options argument"); return true; }
    if (options === undefined || options === null) return false;
    return dataMember(inert(options) ? prototypeOf(options) : options, "timeZone") !== undefined;
  };

  // ── process ──
  // Node makes this set on first use and replaces the property with it:
  // made here, it is no load's change of process.
  void process.allowedNodeEnvironmentFlags;
  for (const k of ["argv", "execArgv", "execPath", "title", "argv0", "debugPort"])
    wrapGetter(process, k, "process." + k, () => note(inputs, "process." + k));
  for (const k of ["pid", "ppid"]) wrapGetter(process, k, "process." + k, () => note(volatile, "process." + k));
  for (const k of ["cwd", "getuid", "getgid", "geteuid", "getegid", "getgroups", "umask", "getActiveResourcesInfo", "resourceUsage", "availableMemory", "constrainedMemory"])
    wrapFn(process, k, inputs, "process." + k + "()");
  for (const k of ["uptime", "hrtime", "memoryUsage", "cpuUsage", "threadCpuUsage"]) wrapFn(process, k, volatile, "process." + k + "()");
  if (process.hrtime) wrapFn(process.hrtime, "bigint", volatile, "process.hrtime.bigint()");
  if (process.memoryUsage) wrapFn(process.memoryUsage, "rss", volatile, "process.memoryUsage.rss()");
  for (const k of ["exit", "reallyExit", "abort", "kill", "chdir", "setuid", "setgid", "seteuid", "setegid", "setgroups", "initgroups", "dlopen", "binding", "_linkedBinding", "emitWarning", "on", "addListener", "once", "prependListener", "prependOnceListener", "removeListener", "off", "removeAllListeners", "setMaxListeners", "nextTick", "setUncaughtExceptionCaptureCallback", "setSourceMapsEnabled", "send", "disconnect", "execve", "ref", "unref", "loadEnvFile", "openStdin"])
    wrapFn(process, k, effects, "process." + k + "()");
  if (typeof process.getBuiltinModule === "function") {
    const original = process.getBuiltinModule;
    claim(process, "getBuiltinModule");
    process.getBuiltinModule = function (id) {
      if (recording && !internalCaller()) builtinLoaded(String(id).replace(/^node:/, ""), lastCaller);
      return original.apply(this, arguments);
    };
    undo.push(() => { process.getBuiltinModule = original; });
  }
  // The standard streams. Node's own code acting for the module (console.log,
  // util.styleText) uses the stream itself, whose listed members report in
  // place. The module's own code gets a proxy that also sees the members no
  // rule lists and the questions asked of the object itself (its prototype,
  // its keys): a stream is a terminal's, a pipe's or a file's, with different
  // members each, and only whether it is a terminal has a boot guard.
  const ttyModule = require("node:tty");
  const ttyOnly = new Set(["columns", "rows", "isRaw"]);
  for (const proto of [ttyModule.WriteStream.prototype, ttyModule.ReadStream.prototype])
    for (const k of Object.getOwnPropertyNames(proto)) if (k !== "constructor" && k !== "isTTY") ttyOnly.add(k);
  const streamEffects = ["write", "on", "once", "addListener", "prependListener", "end", "setRawMode", "resume", "pause", "read", "cork", "uncork", "destroy", "pipe"];
  // Effects only when the module itself calls them: Node's own code calls
  // these while it acts for a module (console.log removes its error listener
  // in a finally block), where a withheld call would escape as a throw.
  const moduleEffects = new Set(["prependOnceListener", "unpipe", "removeListener", "off", "removeAllListeners", "setMaxListeners", "setEncoding", "setDefaultEncoding", "ref", "unref", "emit", "cursorTo", "moveCursor", "clearLine", "clearScreenDown"]);
  // Answered from the stream's listeners, which only island code adds.
  const streamPure = ["fd", "listenerCount", "listeners", "rawListeners", "eventNames", "getMaxListeners"];
  for (const [fd, s] of [[0, "stdin"], [1, "stdout"], [2, "stderr"]]) {
    let stream;
    try { stream = process[s]; } catch { continue; }
    const name = "process." + s;
    const isTty = stream.isTTY === true;
    const terminal = () => { if (!tty.has(fd)) tty.set(fd, isTty); };
    for (const k of streamEffects) wrapFn(stream, k, effects, name + "." + k + "()");
    wrapGetter(stream, "isTTY", name + ".isTTY", (v) => { if (!tty.has(fd)) tty.set(fd, v === true); });
    // Only a terminal's stream has a size, and the size has no guard.
    for (const k of ["columns", "rows"]) wrapGetter(stream, k, name + "." + k, () => { terminal(); if (isTty) add(inputs, name + "." + k); });
    for (const k of ["getColorDepth", "hasColors", "getWindowSize"]) wrapFn(stream, k, inputs, name + "." + k + "()");
    const listed = new Set(["isTTY", "columns", "rows", "getColorDepth", "hasColors", "getWindowSize", ...streamEffects, ...moduleEffects, ...streamPure]);
    const kind = "what kind of stream " + name + " is";
    const seen = (k) => {
      if (typeof k !== "string") { add(inputs, kind + NOT); return; }
      // A member only a terminal's stream has: reading it is asking whether
      // the stream is one.
      if (ttyOnly.has(k)) { terminal(); if (isTty && k === "isRaw") add(inputs, name + "." + k); return; }
      if (!listed.has(k)) add(inputs, name + "." + k + NOT);
    };
    const bound = new Map();
    const proxy = new Proxy(stream, {
      get(t, k) {
        if (recording && !internalCaller()) seen(k);
        const v = Reflect.get(t, k, t);
        if (typeof v !== "function") return v;
        // Called on the stream itself, so that Node's code inside the call
        // sees the stream; a method that answers the stream answers the proxy.
        let f = bound.get(v);
        if (f === undefined) {
          const effect = typeof k === "string" && moduleEffects.has(k) ? name + "." + k + "()" : null;
          f = function (...a) {
            if (effect !== null) note(effects, effect);
            const r = v.apply(this === proxy ? t : this, a);
            return r === t ? proxy : r;
          };
          Object.defineProperty(f, "name", { value: v.name });
          Object.defineProperty(f, "length", { value: v.length });
          bound.set(v, f);
        }
        return f;
      },
      has(t, k) { if (recording && !internalCaller()) seen(k); return Reflect.has(t, k); },
      set(t, k, v) { note(effects, "a write of " + name + "." + String(k)); return Reflect.set(t, k, v, t); },
      defineProperty(t, k, d) { note(effects, "a write of " + name + "." + String(k)); return Reflect.defineProperty(t, k, d); },
      deleteProperty(t, k) { note(effects, "a delete of " + name + "." + String(k)); return Reflect.deleteProperty(t, k); },
      getPrototypeOf(t) { note(inputs, kind + NOT); return Reflect.getPrototypeOf(t); },
      ownKeys(t) { note(inputs, kind + NOT); return Reflect.ownKeys(t); },
      getOwnPropertyDescriptor(t, k) { note(inputs, kind + NOT); return Reflect.getOwnPropertyDescriptor(t, k); },
    });
    const d = Object.getOwnPropertyDescriptor(process, s);
    claim(process, s);
    if (d === undefined || !d.configurable) { untrappable.push({ label: name, key: s }); continue; }
    let keys = trapped.get(process);
    if (keys === undefined) trapped.set(process, (keys = new Set()));
    keys.add(s);
    Object.defineProperty(process, s, {
      configurable: true,
      enumerable: d.enumerable,
      get() { return recording && directCaller() ? proxy : stream; },
      set(v) {
        note(effects, "a write of " + name);
        Object.defineProperty(process, s, { configurable: true, enumerable: d.enumerable, writable: true, value: v });
      },
    });
    undo.push(() => Object.defineProperty(process, s, d));
  }
  // What is fixed by the libnode pack, and what only island code changes
  // (the listeners, the island's exit code, Node's own bookkeeping).
  const processPure = new Set(["version", "versions", "arch", "platform", "release", "config", "features", "exitCode",
    "allowedNodeEnvironmentFlags", "moduleLoadList", "domain", "emit", "listeners", "listenerCount", "eventNames",
    "getMaxListeners", "rawListeners", "hasUncaughtExceptionCaptureCallback", "assert", "_events", "_eventsCount",
    "_maxListeners", "_exiting", "_preload_modules", "_eval", "_tickCallback", "_fatalException"]);
  for (const k of Object.getOwnPropertyNames(process))
    if (!isClaimed(process, k) && !processPure.has(k)) unclassified(process, k, "process." + k);

  for (const k of ["queueMicrotask", "fetch"]) wrapFn(globalThis, k, effects, k + "()");
  // Timers: one the load sets and clears again, and a clear of nothing
  // (undefined, null), leave nothing behind (NI-7d).
  const pendingTimers = new Map();
  // Inside one of the wrappers below: the timer is theirs to account for.
  let ownTimer = 0;
  for (const k of ["setTimeout", "setInterval", "setImmediate"]) {
    const original = globalThis[k];
    claim(globalThis, k);
    const wrapped = function (...a) {
      // The program's own code sets no timer in the build (note throws).
      if (withholding) note(effects, k + "()");
      ownTimer++;
      let handle;
      try { handle = original.apply(this, a); } finally { ownTimer--; }
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
    claim(globalThis, k);
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

  // ── the clock, the time zone and the locale ──
  // What a Date is made from decides what it read: nothing at all is the
  // clock; year, month and so on are local time; a string is local time
  // unless it says otherwise, which is asked of the parser itself, in two
  // zones a day apart (Node follows a change of TZ).
  const RealDate = Date;
  const realParse = Date.parse;
  const parsedIn = (tz, text) => {
    const had = realEnv.TZ;
    realEnv.TZ = tz;
    try { return realParse(text); } finally { if (had === undefined) delete realEnv.TZ; else realEnv.TZ = had; }
  };
  const localText = (text) => {
    let west, east;
    try { west = parsedIn("Etc/GMT+12", text); east = parsedIn("Etc/GMT-14", text); } catch { return true; }
    return !Object.is(west, east);
  };
  wrapFn(RealDate, "now", volatile, "Date.now()");
  wrapFn(RealDate, "parse", (a) => { if (typeof a[0] !== "string" || localText(a[0])) zone(); }, "");
  {
    const wrapped = wrapFn(globalThis, "Date", (a, isNew) => {
      if (!isNew) add(volatile, "Date()");
      else if (a.length === 0) add(volatile, "new Date()");
      else if (a.length > 1) zone();
      else if (typeof a[0] === "string" ? localText(a[0]) : a[0] !== null && typeof a[0] === "object" && !types.isDate(a[0])) zone();
    }, "");
    // new date.constructor(...) is the same question.
    if (wrapped !== undefined) {
      const d = Object.getOwnPropertyDescriptor(RealDate.prototype, "constructor");
      RealDate.prototype.constructor = wrapped;
      undo.push(() => Object.defineProperty(RealDate.prototype, "constructor", d));
    }
  }
  for (const k of ["getDate", "getDay", "getFullYear", "getHours", "getMinutes", "getMonth", "getSeconds", "getTimezoneOffset", "getYear", "setDate", "setFullYear", "setHours", "setMilliseconds", "setMinutes", "setMonth", "setSeconds", "setYear", "toString", "toDateString", "toTimeString"])
    wrapFn(RealDate.prototype, k, zone, "", "zone");
  for (const k of ["toLocaleString", "toLocaleDateString", "toLocaleTimeString"])
    wrapFn(RealDate.prototype, k, (a) => {
      if (defaultLocale(realIntl.DateTimeFormat, a[0])) locale();
      if (!zoneOption(a[1])) zone();
    }, "");
  wrapFn(Number.prototype, "toLocaleString", (a) => { if (defaultLocale(realIntl.NumberFormat, a[0])) locale(); }, "", "locale");
  wrapFn(BigInt.prototype, "toLocaleString", (a) => { if (defaultLocale(realIntl.NumberFormat, a[0])) locale(); }, "", "locale");
  // The receiver and the compared value are converted to strings before the
  // locales are read: a conversion of the load's own could change the list.
  wrapFn(String.prototype, "localeCompare", (a, isNew, self) => {
    if (typeof self !== "string" || !inert(a[0])) opaque("a compared value");
    else if (defaultLocale(realIntl.Collator, a[1])) locale();
  }, "", "locale");
  for (const k of ["toLocaleUpperCase", "toLocaleLowerCase"])
    wrapFn(String.prototype, k, (a, isNew, self) => {
      if (typeof self !== "string") opaque("a converted value");
      else if (defaultLocale(realIntl.Collator, a[0])) locale();
    }, "", "locale");
  // Every Intl service that takes locales (Intl.Locale and the functions
  // take a tag and answer from ICU's data, which is the pack's).
  for (const k of Object.getOwnPropertyNames(Intl)) {
    const service = Intl[k];
    if (typeof service !== "function" || typeof service.supportedLocalesOf !== "function") continue;
    const wrapped = wrapFn(Intl, k, (a) => {
      if (defaultLocale(service, a[0])) locale();
      if (k === "DateTimeFormat" && !zoneOption(a[1])) zone();
    }, "");
    if (wrapped === undefined) continue;
    const d = Object.getOwnPropertyDescriptor(service.prototype, "constructor");
    service.prototype.constructor = wrapped;
    undo.push(() => Object.defineProperty(service.prototype, "constructor", d));
  }
  // A format of no date is a format of now.
  {
    const proto = Intl.DateTimeFormat.prototype;
    const d = Object.getOwnPropertyDescriptor(proto, "format");
    // By the format function an instance hands out (the same one each time).
    const made = new Map();
    if (d !== undefined && d.configurable && typeof d.get === "function") {
      Object.defineProperty(proto, "format", {
        configurable: true,
        enumerable: d.enumerable,
        get() {
          const format = d.get.call(this);
          let wrapped = made.get(format);
          if (wrapped === undefined) {
            wrapped = function (date) {
              if (date === undefined) note(volatile, "Intl.DateTimeFormat#format() of the current time");
              return format(date);
            };
            made.set(format, wrapped);
          }
          return wrapped;
        },
      });
      undo.push(() => Object.defineProperty(proto, "format", d));
    }
    wrapFn(proto, "formatToParts", (a) => { if (a[0] === undefined) add(volatile, "Intl.DateTimeFormat#formatToParts() of the current time"); }, "");
  }
  wrapFn(Math, "random", volatile, "Math.random()");
  // performance: every member is a clock or a meter.
  const perf = globalThis.performance;
  if (perf !== undefined && perf !== null) {
    for (const k of members(perf, EventTarget.prototype)) {
      let v;
      try { v = perf[k]; } catch { continue; }
      if (typeof v === "function") wrapFn(perf, k, volatile, "performance." + k + "()");
      else wrapGetter(perf, k, "performance." + k, () => add(volatile, "performance." + k));
    }
  }
  for (const k of ["time", "timeEnd", "timeLog", "timeStamp"]) wrapFn(console, k, volatile, "console." + k + "()");
  // console's own streams are the standard streams themselves.
  for (const k of ["_stdout", "_stderr"])
    wrapGetter(console, k, "console." + k, () => { if (directCaller()) add(inputs, "console." + k + NOT); });
  // The web crypto object: random numbers, and digests and keys behind promises.
  const webcrypto = globalThis.crypto;
  if (webcrypto !== undefined && webcrypto !== null)
    for (const k of members(webcrypto)) {
      if (k === "subtle") continue;
      if (k === "getRandomValues" || k === "randomUUID") wrapFn(webcrypto, k, volatile, "crypto." + k + "()");
      else unclassified(webcrypto, k, "crypto." + k);
    }
  const nav = globalThis.navigator;
  if (nav !== undefined && nav !== null)
    for (const k of members(nav)) {
      if (k === "userAgent" || k === "platform") continue;
      if (k === "language" || k === "languages") wrapGetter(nav, k, "navigator." + k, locale);
      else if (k === "hardwareConcurrency") wrapGetter(nav, k, "navigator." + k, () => add(inputs, "navigator." + k));
      else unclassified(nav, k, "navigator." + k);
    }
  // Constructors that read the clock for what they make (Node defines some
  // of them on first use, and replaces the property when it does).
  const wrapGlobalClass = (key, classify) => {
    const d = Object.getOwnPropertyDescriptor(globalThis, key);
    claim(globalThis, key);
    if (d === undefined) return;
    if (!d.configurable) { untrappable.push({ label: "globalThis." + key, key }); return; }
    let original, wrapped;
    const mine = {
      configurable: true,
      enumerable: d.enumerable,
      get() {
        if (original === undefined) {
          original = d.get ? d.get.call(globalThis) : d.value;
          if (d.get) Object.defineProperty(globalThis, key, mine);
        }
        if (typeof original !== "function") return original;
        if (wrapped === undefined) wrapped = wrapperOf(original, classify, "");
        return wrapped;
      },
      set(v) {
        note(effects, "a write of globalThis." + key);
        Object.defineProperty(globalThis, key, { configurable: true, enumerable: d.enumerable, writable: true, value: v });
      },
    };
    Object.defineProperty(globalThis, key, mine);
    undo.push(() => Object.defineProperty(globalThis, key, d));
  };
  const fileMade = (a) => {
    // The parts and the name are converted before the options are read.
    const parts = a[0];
    // The parts are read through the array's iterator: the engine's own,
    // as it was before any load, or the load's code runs there too.
    let plain = isArray(parts) && !types.isProxy(parts) && parts.length <= 1024 && typeof a[1] === "string" && inertOptions(a[2]) &&
      prototypeOf(parts) === Array.prototype && !hasOwn.call(parts, Symbol.iterator) &&
      Array.prototype[Symbol.iterator] === arrayIterator && arrayIteratorProto.next === arrayIteratorNext;
    for (let i = 0; plain && i < parts.length; i++) {
      const d = descriptorOf(parts, i);
      plain = d !== undefined && hasOwn.call(d, "value") && (typeof d.value === "string" || types.isAnyArrayBuffer(d.value) || types.isArrayBufferView(d.value));
    }
    if (!plain) opaque("an argument of new File()");
    else if (a[2] === undefined || a[2] === null || dataMember(inert(a[2]) ? prototypeOf(a[2]) : a[2], "lastModified") === undefined) add(volatile, "new File() (its lastModified)");
  };
  wrapGlobalClass("File", fileMade);
  try { wrapFn(require("node:buffer"), "File", fileMade, ""); } catch {}
  for (const k of ["Event", "CustomEvent", "MessageEvent", "CloseEvent"])
    wrapGlobalClass(k, () => add(volatile, "new " + k + "() (its timeStamp)"));
  if (typeof URL.createObjectURL === "function") wrapFn(URL, "createObjectURL", volatile, "URL.createObjectURL()");
  // ── the globals ──
  // The language, and the web interfaces that compute from their arguments
  // or whose work the async hook below sees (a channel's ports, a socket).
  const pureGlobals = new Set(("AbortController AbortSignal AggregateError Array ArrayBuffer AsyncDisposableStack Atomics " +
    "BigInt BigInt64Array BigUint64Array Blob Boolean BroadcastChannel Buffer ByteLengthQueuingStrategy CompressionStream " +
    "CountQueuingStrategy Crypto CryptoKey DOMException DataView DecompressionStream DisposableStack Error EvalError " +
    "EventTarget FinalizationRegistry Float16Array Float32Array Float64Array FormData Function Headers Infinity Int16Array " +
    "Int32Array Int8Array Intl Iterator JSON Map Math MessageChannel MessagePort NaN Navigator Number Object Performance " +
    "PerformanceEntry PerformanceMark PerformanceMeasure PerformanceObserver PerformanceObserverEntryList " +
    "PerformanceResourceTiming Promise Proxy RangeError ReadableByteStreamController ReadableStream " +
    "ReadableStreamBYOBReader ReadableStreamBYOBRequest ReadableStreamDefaultController ReadableStreamDefaultReader " +
    "ReferenceError Reflect RegExp Request Response Set SharedArrayBuffer String SubtleCrypto SuppressedError Symbol " +
    "SyntaxError TextDecoder TextDecoderStream TextEncoder TextEncoderStream TransformStream " +
    "TransformStreamDefaultController TypeError URIError URL URLPattern URLSearchParams Uint16Array Uint32Array " +
    "Uint8Array Uint8ClampedArray WeakMap WeakRef WeakSet WebAssembly WebSocket WritableStream " +
    "WritableStreamDefaultController WritableStreamDefaultWriter atob btoa console crypto decodeURI decodeURIComponent " +
    "encodeURI encodeURIComponent escape eval global globalThis isFinite isNaN navigator parseFloat parseInt performance " +
    "process structuredClone undefined unescape").split(" "));
  for (const k of Object.getOwnPropertyNames(globalThis))
    if (!isClaimed(globalThis, k) && !pureGlobals.has(k)) unclassified(globalThis, k, "globalThis." + k);

  // ── the builtin modules ──
  // A module is on one of three lists. whole: its functions are one kind of
  // source by default, with the exceptions below. pureModules: it computes
  // from its arguments, or reaches the machine only through what is wrapped
  // here (path.resolve() through process.cwd()). Any other builtin, known or
  // new, is not classified, and loading it keeps the load eager.
  const whole = {
    fs: inputs, os: inputs, child_process: effects, net: effects, dgram: effects, dns: effects,
    http: effects, https: effects, http2: effects, tls: effects, worker_threads: effects,
    cluster: effects, vm: effects, inspector: effects, tty: inputs, readline: effects, timers: effects,
    perf_hooks: volatile, crypto: volatile, v8: effects, repl: effects, trace_events: effects,
    async_hooks: effects, diagnostics_channel: effects, "dns/promises": effects, "readline/promises": effects,
    "inspector/promises": effects, "timers/promises": effects,
  };
  const pureModules = new Set(["assert", "assert/strict", "buffer", "console", "constants", "events", "module", "path",
    "path/posix", "path/win32", "process", "punycode", "querystring", "stream", "stream/consumers", "stream/promises",
    "stream/web", "string_decoder", "sys", "url", "util", "util/types", "zlib", "_stream_duplex", "_stream_passthrough",
    "_stream_readable", "_stream_transform", "_stream_wrap", "_stream_writable"]);
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
        else for (const key of keys) noteEnv(key, envValue(key));
      }
      return result;
    };
    undo.push(() => { osModule[k] = original; });
  }
  // tty.isatty() of a standard stream is the question its isTTY answers.
  {
    const original = ttyModule.isatty;
    ttyModule.isatty = function (fd) {
      const result = original.apply(this, arguments);
      if (recording && !internalCaller()) {
        if (fd === 0 || fd === 1 || fd === 2) { if (!tty.has(fd)) tty.set(fd, result === true); }
        else add(inputs, "tty.isatty()");
      }
      return result;
    };
    undo.push(() => { ttyModule.isatty = original; });
  }
  // util.debuglog() answers from NODE_DEBUG, which Node read when it started.
  {
    const utilModule = require("node:util");
    for (const k of ["debuglog", "debug"]) {
      const original = utilModule[k];
      if (typeof original !== "function") continue;
      utilModule[k] = function () {
        if (recording && !internalCaller()) noteEnv("NODE_DEBUG", envValue("NODE_DEBUG"));
        return original.apply(this, arguments);
      };
      undo.push(() => { utilModule[k] = original; });
    }
  }
  // Members of the modules on the second list that answer from something
  // else than their arguments, through Node's own code where no wrapper
  // here sees the read: the command line, and where the compile cache is.
  wrapFn(require("node:util"), "parseArgs", inputs, "util.parseArgs()");
  wrapFn(Module, "getCompileCacheDir", inputs, "module.getCompileCacheDir()");
  // What the module loader does for a program besides loading.
  for (const k of ["register", "registerHooks", "enableCompileCache", "flushCompileCache", "syncBuiltinESMExports", "setSourceMapsSupport", "runMain", "findPackageJSON", "findSourceMap"])
    wrapFn(Module, k, effects, "module." + k + "()");
  // A function is here only when what it answers, and what the object it
  // makes can answer, follows from its arguments and the pack. Not here, so
  // a reading no run repeats like the rest of crypto: createECDH,
  // getDiffieHellman and createDiffieHellman (their objects generate a
  // private key), createSign and sign (a signature draws a nonce for most
  // key types), publicEncrypt (random padding), every generate* and random*.
  const pureFns = new Set(["os.platform", "os.homedir", "os.tmpdir", "os.type", "os.arch", "os.machine", "os.endianness",
    "tty.isatty", "net.isIP", "net.isIPv4", "net.isIPv6", "tls.getCiphers", "tls.checkServerIdentity",
    // Marks on an object the caller holds: Node's own Headers, Request and
    // Response mark themselves when they are made.
    "worker_threads.markAsUncloneable", "worker_threads.markAsUntransferable", "worker_threads.isMarkedAsUntransferable",
    "crypto.createHash", "crypto.createHmac", "crypto.getHashes", "crypto.getCiphers", "crypto.getCurves",
    "crypto.createCipheriv", "crypto.createDecipheriv", "crypto.hash", "crypto.createSecretKey", "crypto.createPublicKey",
    "crypto.createPrivateKey", "crypto.pbkdf2Sync", "crypto.scryptSync", "crypto.hkdfSync", "crypto.timingSafeEqual",
    "crypto.createVerify", "crypto.verify", "crypto.getCipherInfo",
    "crypto.privateDecrypt", "crypto.publicDecrypt", "vm.isContext", "fs.existsSync__never",
    "async_hooks.AsyncLocalStorage", "async_hooks.AsyncResource", "diagnostics_channel.channel",
    "diagnostics_channel.tracingChannel", "diagnostics_channel.hasSubscribers", "perf_hooks.createHistogram"]);
  // The members of a module on the first list that are not functions and are the same
  // in every run: constants, and objects whose own members have their rules.
  const pureData = {
    fs: "constants promises", os: "EOL devNull constants",
    // crypto.getRandomValues is an accessor here; what it answers draws
    // through a request the async hook below sees.
    crypto: "constants webcrypto subtle getRandomValues",
    perf_hooks: "performance constants", http: "METHODS STATUS_CODES globalAgent maxHeaderSize", https: "globalAgent",
    http2: "constants sensitiveHeaders", dns: "promises", vm: "constants", timers: "promises", readline: "promises",
    tls: "rootCertificates", async_hooks: "asyncWrapProviders",
    worker_threads: "isMainThread isInternalThread threadId workerData parentPort resourceLimits SHARE_ENV",
  };
  // The modules whose classes are sources themselves: a context of its own
  // globals, a stream on a descriptor, a thread, a debugger.
  // Classes of the other modules whose instances draw random numbers: a key
  // pair, a prime, a signature's nonce.
  const sourceClassNames = new Set(["crypto.ECDH", "crypto.DiffieHellman", "crypto.DiffieHellmanGroup", "crypto.Sign"]);
  const sourceClasses = new Set(["vm", "tty", "worker_threads", "child_process", "inspector", "inspector/promises", "repl", "cluster", "trace_events", "v8", "readline", "readline/promises"]);
  // Synchronous reads of the module's own package (its files are boot
  // guards, by size and mtime) are guarded inputs, not inputs.
  const fsModule = require("node:fs");
  const rawExists = fsModule.existsSync;
  const rawReadFile = fsModule.readFileSync;
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
      // A guarded call reads the module's own package, which is boot state
      // the build may take. Any other call is the program's input, and an
      // open for writing is an effect: a generated module's evaluation
      // withholds it before the call, so the build never reads a file the
      // program would read nor truncates one it would write. The refusal
      // goes through note, which records the call before it throws: a
      // package that catches the refusal and goes on with a fallback has
      // the call in its record, and its module is not deferred with the
      // fallback's value.
      if (withholding && (ownPath(target) === null || (key === "openSync" && !readOnlyFlags(flags))))
        note(inputs, "fs." + key + "()");
      let result;
      try {
        result = original.apply(this, arguments);
      } catch (e) {
        // A file that is not there has no boot guard: its absence is an input.
        if (recording && !internalCaller()) inputs.push("fs." + key + "() (" + lastCaller + ")");
        throw e;
      }
      if (recording && !internalCaller()) {
        const own = ownPath(target);
        if (key === "existsSync" && result === false) {
          inputs.push("fs." + key + "() (" + lastCaller + ")");
        } else if (own !== null && (key !== "openSync" || readOnlyFlags(flags))) {
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
      // Only a guarded read's descriptor is the build's own; any other is
      // the program's, which a generated module's evaluation withholds
      // (recorded before the refusal, as above).
      if (withholding && !guardedFds.has(fd)) note(inputs, "fs." + key + "()");
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
  // The builtins by name, for a load that asks for one.
  const builtinById = new Map([["process", process]]);
  for (const [name, list] of Object.entries(whole)) {
    let m;
    try { m = require(name); } catch { continue; }
    builtinById.set(name, m);
    const data = new Set((pureData[name] || "").split(" "));
    for (const key of Object.getOwnPropertyNames(m)) {
      if (name === "fs" && guardedFsFns.has(key)) continue;
      if (pureFns.has(name + "." + key)) continue;
      let d;
      try { d = Object.getOwnPropertyDescriptor(m, key); } catch { continue; }
      if (d === undefined) continue;
      const constant = /^[A-Z][A-Z0-9_]*$/.test(key);
      const fn = "value" in d && typeof d.value === "function";
      // A class (Node makes some on first use, behind an accessor) is a
      // source where what it makes is one; elsewhere it computes, or the
      // async hook below sees the handle it opens.
      if (/^[A-Z]/.test(key) && !constant && (fn || !("value" in d)) && !sourceClasses.has(name) && !sourceClassNames.has(name + "." + key)) continue;
      if (fn) wrapFn(m, key, list, name + "." + key + "()");
      // A member this platform does not have (fs.lchmod) is absent in every run.
      else if ("value" in d && d.value === undefined) continue;
      else if (!data.has(key) && !constant) unclassified(m, key, name + "." + key);
    }
    if (name === "fs" && m.promises)
      for (const key of Object.keys(m.promises)) wrapFn(m.promises, key, inputs, "fs.promises." + key + "()");
  }
  const knownModules = new Set([...Object.keys(whole), ...pureModules, "fs/promises"]);
  function builtinLoaded(id, where) {
    if (!knownModules.has(id)) inputs.push("the builtin module " + id + NOT + " (" + where + ")");
  }
  // The names an ES module imports from a specifier ("*": its namespace).
  const importedNames = (source, specifier) => {
    const names = new Set();
    const quoted = specifier.replace(/[^A-Za-z0-9_:\/-]/g, "\\$&");
    const statement = new RegExp("\\b(?:import|export)\\b([^;\"']*?)\\bfrom\\s*[\"']" + quoted + "[\"']", "g");
    for (let m = statement.exec(source); m !== null; m = statement.exec(source)) {
      if (m[1].includes("*")) names.add("*");
      const braces = /\{([^}]*)\}/.exec(m[1]);
      if (braces === null) continue;
      for (const part of braces[1].split(",")) {
        const name = part.trim().split(/\s+as\s+/)[0].trim();
        if (name !== "") names.add(name);
      }
    }
    return names;
  };
  // An ES module that imports a builtin's member by name gets a copy of its
  // value, which no accessor here sees being read: the import is the read.
  const builtinImported = (id, specifier, parent) => {
    builtinLoaded(id, parent === null ? "its load" : parent);
    const target = builtinById.get(id);
    const keys = target === undefined ? undefined : trapped.get(target);
    if (parent === null || keys === undefined) return;
    let source = "";
    try { source = rawReadFile(parent, "utf8"); } catch {}
    const names = importedNames(source, specifier);
    if (names.size === 0) return;
    forcedCaller = parent;
    try {
      internalCaller();
      for (const k of names.has("*") ? keys : names) {
        if (!keys.has(k)) continue;
        // The streams' accessor answers Node's own code with the stream itself.
        if (target === process && (k === "stdin" || k === "stdout" || k === "stderr"))
          add(inputs, "process." + k + " imported by name" + NOT);
        else void target[k];
      }
    } finally { forcedCaller = null; }
  };
  wrapFn(require("worker_threads"), "Worker", effects, "new Worker()");
  // Async resources the load creates. A promise alone is no work (an async
  // function that returns at once creates one); a reaction to a promise
  // the load created (then/catch/finally, an await) is.
  const loadPromises = new Set();
  // The promises themselves, for their state once the load returns.
  const madePromises = [];
  const inspect = require("node:util").inspect;
  const rejected = (p) => {
    try { return /^[^{]*\{\s*<rejected>/.test(inspect(p, { depth: 0, customInspect: false })); } catch { return false; }
  };
  const hook = asyncHooks.createHook({
    init(id, type, trigger, resource) {
      if (!recording) return;
      // Timers and immediates are the timer wrappers' to account for, except
      // one Node set for the module by another way (AbortSignal.timeout(),
      // timers/promises).
      if (type === "Timeout" || type === "Immediate") {
        if (ownTimer === 0 && !internalCaller()) effects.push("a timer (" + lastCaller + ")");
        return;
      }
      if (type === "PROMISE") {
        if (loadPromises.has(trigger)) {
          internalCaller();
          effects.push("a promise reaction (" + lastCaller + ")");
        } else if (!internalCaller()) {
          loadPromises.add(id);
          // The module's own promise (not the loader's for the module's
          // evaluation, which a throw rejects: that is the load's throw).
          if (types.isPromise(resource)) madePromises.push(resource);
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
  // The probe evaluates installed packages only: a file outside every
  // node_modules directory is the program's own source (a program module,
  // or a project file a package requires), and its load throws before the
  // file evaluates, so the module that asked for it stays eager. The
  // program's own modules the build admits (own) are the exception: what
  // their code would do to the machine is withheld (note).
  const hooks = Module.registerHooks({
    resolve(specifier, context, nextResolve) {
      const result = nextResolve(specifier, context);
      if (recording && typeof result.url === "string" && result.url.startsWith("node:"))
        builtinImported(result.url.slice(5), specifier, parentFile(context));
      if (recording && typeof result.url === "string" && result.url.startsWith("file:")) {
        const file = require("node:url").fileURLToPath(result.url);
        if (!/[\\/]node_modules[\\/]/.test(file) && !own.has(file)) {
          if (refused === null) refused = file;
          throw new Error("the build does not evaluate " + file + ", a file of the program");
        }
        files.add(file);
        // A file an earlier load of this probe evaluated comes from the
        // module cache: its exports are what that load computed, its
        // environment reads included, so those keys are this load's too,
        // and the keys of the file that required it for the next one.
        if (require.cache[file] !== undefined) {
          const keys = envFiles.get(file);
          if (keys !== undefined) {
            const parent = parentFile(context);
            for (const k of keys) {
              if (!envKeys.has(k)) envKeys.set(k, realEnv[k] === undefined ? null : String(realEnv[k]));
              saveEnvFile(parent, k);
            }
          }
        }
      }
      return result;
    },
  });
  undo.push(() => hooks.deregister());
  // The ES module namespaces of the builtins copy their members: from here
  // on, the functions as wrapped above.
  try { Module.syncBuiltinESMExports(); } catch {}
  undo.push(() => { try { Module.syncBuiltinESMExports(); } catch {} });
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

  // What a member of a module value reads now: a data property's value, or
  // a binding getter's (esbuild's and tsc's export getters). Any other
  // accessor can run code, so it is not part of a shape.
  const MISSING = {};
  const memberValue = (o, k) => {
    const d = Object.getOwnPropertyDescriptor(o, k);
    if (d === undefined) return MISSING;
    if ("value" in d) return d.value;
    if (typeof d.get !== "function" || !bindingGetter(d.get)) return MISSING;
    try { return d.get.call(o); } catch { return MISSING; }
  };

  // What the snapshot answers of a function besides its identity: its
  // name and length, and whether 'instanceof' against it is the ordinary
  // prototype walk (plainClass).
  const PLAIN = Symbol("plain");
  const answered = (o, k) => (k === PLAIN ? plainClass(o) : memberValue(o, k));
  const functionShape = (shape, f) => {
    if (types.isProxy(f)) return;
    for (const k of ["name", "length", PLAIN]) shape.push([f, k, answered(f, k)]);
  };
  // A module's exported values right after its load, at the depth the
  // snapshot covers (the module value's members, and theirs for objects),
  // with what it answers of the functions among them.
  const exportShape = (v) => {
    const shape = [];
    if (v === null || (typeof v !== "object" && typeof v !== "function")) return shape;
    if (typeof v === "function" && !types.isProxy(v)) shape.push([v, PLAIN, plainClass(v)]);
    for (const k of Reflect.ownKeys(v)) {
      const m = memberValue(v, k);
      if (m === MISSING) continue;
      shape.push([v, k, m]);
      if (typeof m === "function") functionShape(shape, m);
      else if (m !== null && typeof m === "object")
        for (const k2 of Reflect.ownKeys(m)) {
          const m2 = memberValue(m, k2);
          if (m2 === MISSING) continue;
          shape.push([m, k2, m2]);
          if (typeof m2 === "function") functionShape(shape, m2);
        }
    }
    return shape;
  };
  const shapes = new Map();
  const results = [];
  for (const path of input.modules) {
    inputs.length = volatile.length = effects.length = 0;
    pendingTimers.clear();
    loadPromises.clear();
    madePromises.length = 0;
    tty.clear(); envKeys.clear(); files.clear(); fired.clear();
    refused = null;
    withholding = own.has(path);
    withheld = null;
    files.add(path);
    currentFiles = files;
    currentPackageDir = null;
    for (let d = require("node:path").dirname(path); d !== require("node:path").dirname(d); d = require("node:path").dirname(d)) {
      if (rawExists(d + "/package.json")) { currentPackageDir = d; break; }
    }
    const before = shot();
    let exportsValue, threw;
    recording = true;
    try { exportsValue = createRequire(path)(path); } catch (e) { threw = String((e && e.message) || e); }
    recording = false;
    // A promise the load made and left rejected: Node reports it unhandled
    // when the turn of the import ends, which no later evaluation repeats.
    if (madePromises.some(rejected)) effects.push("a promise the load leaves rejected");
    madePromises.length = 0;
    // The load's closure also holds what it was handed without the resolve
    // hook being asked: Node answers a relative request that another module
    // of the same directory already made from a cache of its own, and a
    // cached module's own requires do not run again. The modules a module
    // required are its children, whoever evaluated them first, and what
    // those files read when they evaluated is in what this load exports.
    {
      const reached = new Set();
      const reach = (m) => {
        if (m === undefined || m === null || reached.has(m)) return;
        reached.add(m);
        const file = m.filename;
        if (typeof file === "string" && !files.has(file)) {
          files.add(file);
          const keys = envFiles.get(file);
          if (keys !== undefined)
            for (const k of keys) if (!envKeys.has(k)) envKeys.set(k, realEnv[k] === undefined ? null : String(realEnv[k]));
        }
        for (const child of m.children) reach(child);
      };
      for (const f of [...files]) reach(require.cache[f]);
    }
    // What this load read is in what it exports: a later load that gets the
    // file from the module cache inherits the keys.
    for (const k of envKeys.keys()) saveEnvFile(path, k);
    // A load that catches the refusal evaluates a fallback the executable
    // never runs: its exports are not the module's, and neither are those of
    // a later load that reaches one of its files through the module cache.
    if (refused === null)
      for (const f of files) if (refusedBy.has(f)) { refused = refusedBy.get(f); break; }
    if (refused !== null) {
      threw = "the build does not evaluate " + refused + ", a file of the program";
      for (const f of files) if (!refusedBy.has(f)) refusedBy.set(f, refused);
    }
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
        try { if (rawReadFile(f, "utf8").includes(key)) return true; } catch {}
      }
      return false;
    };
    for (let i = mutations.length - 1; i >= 0; i--) {
      const m = /^globalThis\.Symbol\((undici\.globalDispatcher\.\d+)\)$/.exec(mutations[i]);
      if (m !== null && !names("undici.globalDispatcher")) mutations.splice(i, 1);
    }
    // A member the recorder cannot observe: read, if a file of the load
    // names it as a member or takes it out of an object.
    if (untrappable.length > 0) {
      const member = untrappable.map((u) => new RegExp("(?:[.]\\s*|[{,]\\s*)" + u.key + "\\s*(?:[,}=;)\\]\\s]|$)"));
      const named = new Set();
      for (const f of files) {
        let text;
        try { text = rawReadFile(f, "utf8"); } catch { continue; }
        untrappable.forEach((u, i) => { if (member[i].test(text)) named.add(u.label); });
      }
      for (const label of named) inputs.push(label + ", which the recorder cannot observe and the load's files name");
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
    // A generated module that catches a withheld call goes on with the
    // fallback its catch block produces, and its export shape, which the
    // executable never runs: neither the value nor what it does next is the
    // module's, so it does not defer.
    if (withheld !== null) {
      record.reason = "its evaluation has effects or reads inputs: " + withheld + ", which the build does not perform";
      results.push(record);
      continue;
    }
    if (threw !== undefined) { record.throws = threw; results.push(record); continue; }
    if (!("o" in root)) { record.reason = "its value is not an object"; results.push(record); continue; }
    record.root = root.o;
    // This load changed what an earlier module exports: neither defers (the
    // earlier snapshot no longer holds, and this load's change has to happen
    // where the program imports it).
    for (const [earlier, shape] of shapes) {
      const changed = shape.some(([o, k, v]) => !Object.is(answered(o, k), v));
      if (!changed) continue;
      delete earlier.root;
      earlier.reason = "a later island module's load changes its exports";
      delete record.root;
      record.reason = "its load changes another island module's exports";
      shapes.delete(earlier);
    }
    if (record.root !== undefined) shapes.set(record, exportShape(exportsValue));
    results.push(record);
  }
  for (const u of undo.reverse()) u();
  return { results, objects, untrappable: untrappable.map((u) => u.label) };
};
`;
