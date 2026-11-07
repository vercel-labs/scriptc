#!/usr/bin/env node
// What the compiler knows about the members of ECMAScript's built-in objects,
// taken from the pinned Node release by running it:
//
//  - the census: the own members of each global a bare V8 context defines
//    (the language's own globals, without Node's additions), of each
//    constructor's `prototype`, and of the global object itself;
//  - which of a prototype's members an instance holds itself (an array's
//    `length`), so that a read through an instance never reaches the
//    prototype's;
//  - the readers: for every language construct that converts, iterates,
//    awaits or serializes a value, for every built-in member and for every
//    built-in function called with an argument, the members Node reads from
//    built-in objects while it runs (`String(array)` reads `toString` and
//    `join`; `promise.catch()` reads `then`; `Promise.all` reads
//    `Promise.resolve`).
//
// The compiler reads the census to tell a write that replaces an existing
// built-in member from one that adds a new member and to decide a feature
// test of an existing member (`if (!Array.prototype.at)`), and the readers
// to tell whether a program that replaces a member also uses it through
// code that never looks at the object (builtin-member-readers.ts).
//
//   node scripts/gen-builtin-object-members.mjs          regenerate the table
//   node scripts/gen-builtin-object-members.mjs --check  verify only
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import vm from "node:vm";

const root = fileURLToPath(new URL("..", import.meta.url));
const out = join(
  root,
  "packages/compiler/src/frontend/lowering/builtin-object-members.generated.ts",
);
const checkOnly = process.argv.includes("--check");
const pinned = readFileSync(join(root, ".node-version"), "utf8").trim();
if (process.version !== `v${pinned}`) {
  throw new Error(`run with Node v${pinned} (this is ${process.version})`);
}
// A measured call may leave a rejected promise nobody handles (a built-in
// called with an argument it refuses): that is its result, not a failure.
process.on("unhandledRejection", () => {});

// Everything runs inside a fresh context, so the objects are the engine's
// own and nothing Node installs on its main context is counted. `console`
// is the one name V8 adds that the language does not define.
//
// The census is taken first. The measurements then turn every configurable
// member of every census object into an accessor that records its read and
// answers the original value, and give `Object.prototype` recording
// accessors for the protocol names no built-in defines there (`then`,
// `toJSON`, the well-known symbols), which answer undefined as a missing
// member does. A measurement runs one operation between `start` and
// `finish`; the host lets every pending job run in between, so reads made
// by promise reactions are recorded too. The harness itself touches
// built-ins only through functions captured before the accessors exist.
const lab = vm.runInNewContext(`(() => {
  const { apply, construct, ownKeys, getOwnPropertyDescriptor: describe, defineProperty: define, getPrototypeOf: prototypeOf } = Reflect;
  const typeErrorPrototype = TypeError.prototype;
  const create = Object.create;
  const toObject = Object;
  const stringify = JSON.stringify;
  const wellKnown = new Map();
  for (const name of Object.getOwnPropertyNames(Symbol)) {
    if (typeof Symbol[name] === "symbol") wellKnown.set(Symbol[name], "@@" + name);
  }
  const mapGet = Map.prototype.get;
  const nameOfKey = (key) => (typeof key === "symbol" ? apply(mapGet, wellKnown, [key]) : key);

  // ---- the census ----
  // f: a function; a: an accessor; t: other data that is truthy; z: other
  // data that is falsy. Then "-" for a member an assignment cannot change
  // (data that is not writable, an accessor without a setter) and "=" for
  // one that is not configurable.
  const members = (object) => {
    const row = {};
    for (const key of Reflect.ownKeys(object)) {
      const name = typeof key === "symbol" ? wellKnown.get(key) : key;
      if (name === undefined) continue;
      const d = Object.getOwnPropertyDescriptor(object, key);
      const accessor = "get" in d || "set" in d;
      const kind = accessor ? "a" : typeof d.value === "function" ? "f" : d.value ? "t" : "z";
      const assignable = accessor ? d.set !== undefined : d.writable;
      row[name] = kind + (assignable ? "" : "-") + (d.configurable ? "" : "=");
    }
    return row;
  };
  const objects = new Map([["globalThis", globalThis]]);
  for (const name of Object.getOwnPropertyNames(globalThis)) {
    if (name === "console" || name === "globalThis") continue;
    const value = globalThis[name];
    if ((typeof value !== "object" && typeof value !== "function") || value === null) continue;
    objects.set(name, value);
    // Function.prototype is itself a function; every other prototype is an object.
    const prototype = typeof value === "function" ? value.prototype : undefined;
    if ((typeof prototype === "object" && prototype !== null) || typeof prototype === "function")
      objects.set(name + ".prototype", prototype);
  }
  // The one intrinsic the typed array constructors and prototypes inherit
  // from that no global names.
  const TypedArray = Object.getPrototypeOf(Uint8Array);
  objects.set("%TypedArray%", TypedArray);
  objects.set("%TypedArray%.prototype", TypedArray.prototype);
  const nameOf = new Map([...objects].map(([name, object]) => [object, name]));
  const table = {};
  const inherits = {};
  for (const [name, object] of objects) {
    table[name] = members(object);
    const parent = Object.getPrototypeOf(object);
    if (parent !== null && nameOf.has(parent)) inherits[name] = nameOf.get(parent);
  }
  delete table.globalThis.console;
  const census = JSON.stringify({ table, inherits });

  // ---- a value of every built-in class ----
  const samples = create(null);
  samples["Object.prototype"] = () => ({});
  samples["Array.prototype"] = () => [];
  samples["Function.prototype"] = () => function () {};
  samples["String.prototype"] = () => toObject("s");
  samples["Number.prototype"] = () => toObject(1);
  samples["Boolean.prototype"] = () => toObject(true);
  samples["Symbol.prototype"] = () => toObject(Symbol("s"));
  samples["BigInt.prototype"] = () => toObject(1n);
  samples["Date.prototype"] = () => new Date(0);
  samples["RegExp.prototype"] = () => /a/g;
  samples["Promise.prototype"] = () => new Promise((resolve) => resolve(1));
  samples["ArrayBuffer.prototype"] = () => new ArrayBuffer(8);
  samples["SharedArrayBuffer.prototype"] = () => new SharedArrayBuffer(8);
  samples["DataView.prototype"] = () => new DataView(new ArrayBuffer(8));
  samples["WeakRef.prototype"] = () => new WeakRef({});
  samples["FinalizationRegistry.prototype"] = () => new FinalizationRegistry(() => {});
  samples["Iterator.prototype"] = () => new Set().values();
  for (const [name, object] of objects) {
    if (!name.endsWith(".prototype") || name in samples || name === "%TypedArray%.prototype") continue;
    const C = objects.get(name.slice(0, -".prototype".length));
    // An error made without a message reads its message from the prototype.
    for (const make of [() => new C(), () => new C(2), () => new C([])]) {
      try {
        make();
        samples[name] = make;
        break;
      } catch {}
    }
  }
  // A primitive reads its members from its wrapper's prototype, and no
  // conversion ever asks it for one.
  samples["string"] = () => "s";
  samples["number"] = () => 1;
  samples["boolean"] = () => true;
  samples["symbol"] = () => Symbol("s");
  samples["bigint"] = () => 1n;
  const PRIMITIVES = { "String.prototype": "string", "Number.prototype": "number", "Boolean.prototype": "boolean", "Symbol.prototype": "symbol", "BigInt.prototype": "bigint" };

  const instanceOwn = {};
  for (const name in samples) {
    if (!name.endsWith(".prototype")) continue;
    const own = [];
    for (const key of ownKeys(samples[name]())) {
      const text = nameOfKey(key);
      if (text !== undefined) own.push(text);
    }
    instanceOwn[name] = own;
  }

  // ---- the operations to measure ----
  const constructs = {
    // A template literal, String(v), a property key: ToString.
    string: (v) => \`\${v}\`,
    // v + "", ==: ToPrimitive without a hint.
    concat: (v) => "" + v,
    // +v, v * 1, v < 1: ToNumber.
    number: (v) => +v,
    // for…of, spread, array destructuring, yield*.
    iterate: (v) => {
      for (const x of v) break;
    },
    await: (v) => (async () => {
      await v;
    })(),
    // The value a promise is resolved with: a return from an async
    // function, a reaction's result, resolve(v).
    resolve: (v) => new Promise((resolve) => resolve(v)),
    json: (v) => stringify(v),
  };
  const originals = [];
  for (const [name, object] of objects) {
    if (name === "globalThis") continue;
    for (const key of ownKeys(object)) {
      const text = nameOfKey(key);
      if (text === undefined) continue;
      originals.push({ owner: name, object, key, text, d: describe(object, key) });
    }
  }
  const callback = function () {
    return 0;
  };
  // An entry makes its operands first, so that only the operation is
  // recorded: make() runs before recording starts, run() inside it.
  const plan = [];
  for (const c in constructs)
    for (const sample in samples)
      plan.push({ id: "construct " + c + " " + sample, make: samples[sample], run: constructs[c] });
  for (const { owner, text, d } of originals) {
    if (!owner.endsWith(".prototype") || text === "constructor") continue;
    const sample = PRIMITIVES[owner] ?? (owner === "%TypedArray%.prototype" ? "Uint8Array.prototype" : owner);
    if (!(sample in samples)) continue;
    const f = "value" in d ? d.value : d.get;
    if (typeof f !== "function") continue;
    plan.push({
      id: "member " + sample + " " + owner + " " + text,
      make: () => [samples[sample](), samples[sample]()],
      run: (receivers) => {
        try {
          return apply(f, receivers[0], []);
        } catch (e) {
          // A method that takes a callback refuses to run without one. One
          // that refuses the callback as well was given a wrong argument,
          // and what it read from that argument says nothing.
          if (prototypeOf(e) !== typeErrorPrototype || !("value" in d)) throw e;
          const before = create(null);
          for (const entry in log) before[entry] = 1;
          try {
            return apply(f, receivers[1], [callback]);
          } catch (again) {
            log = before;
            throw again;
          }
        }
      },
    });
  }
  // A built-in function called with one argument: none (what it reads
  // whatever it is given), an array, a plain object, an array of one plain
  // object, and a promise alone and in an array.
  const ARGS = {
    none: () => [],
    array: () => [[]],
    object: () => [{}],
    objects: () => [[{}]],
    promise: () => [samples["Promise.prototype"]()],
    promises: () => [[samples["Promise.prototype"]()]],
  };
  for (const [name, object] of objects) {
    if (name === "globalThis" || name.endsWith(".prototype")) continue;
    const callees = [];
    if (typeof object === "function") {
      callees.push({ id: name, run: (args) => apply(object, undefined, args) });
      callees.push({ id: "new:" + name, run: (args) => construct(object, args) });
    }
    for (const { owner, text, d } of originals) {
      if (owner !== name || !("value" in d) || typeof d.value !== "function") continue;
      callees.push({ id: name + "." + text, run: (args) => apply(d.value, object, args) });
    }
    for (const callee of callees)
      for (const kind in ARGS)
        plan.push({ id: "callee " + kind + " " + callee.id, make: ARGS[kind], run: callee.run });
  }

  // ---- recording ----
  let log = null;
  const note = (owner, text) => {
    if (log !== null) log[owner + " " + text] = 1;
  };
  for (const { owner, object, key, text, d } of originals) {
    if (!d.configurable) continue;
    if ("value" in d) {
      let value = d.value;
      define(object, key, {
        get() {
          note(owner, text);
          return value;
        },
        set(v) {
          if (this === object) value = v;
          else define(this, key, { value: v, writable: true, enumerable: true, configurable: true });
        },
        enumerable: d.enumerable,
        configurable: true,
      });
    } else {
      define(object, key, {
        get:
          d.get &&
          function () {
            note(owner, text);
            return apply(d.get, this, []);
          },
        set:
          d.set &&
          function (v) {
            return apply(d.set, this, [v]);
          },
        enumerable: d.enumerable,
        configurable: true,
      });
    }
  }
  const objectPrototype = objects.get("Object.prototype");
  const probes = ["then", "toJSON"];
  for (const symbol of wellKnown.keys()) probes[probes.length] = symbol;
  for (const key of probes) {
    if (describe(objectPrototype, key) !== undefined) continue;
    const text = nameOfKey(key);
    define(objectPrototype, key, {
      get() {
        note("Object.prototype", text);
        return undefined;
      },
      set(v) {
        define(this, key, { value: v, writable: true, enumerable: true, configurable: true });
      },
      enumerable: false,
      configurable: true,
    });
  }

  return {
    census: () => census,
    instanceOwn: () => stringify(instanceOwn),
    count: () => plan.length,
    id: (i) => plan[i].id,
    start(i) {
      const operands = plan[i].make();
      log = create(null);
      try {
        plan[i].run(operands);
      } catch {}
    },
    finish() {
      const seen = [];
      for (const entry in log) seen[seen.length] = entry;
      log = null;
      return stringify(seen);
    },
  };
})()`);

const { table, inherits } = JSON.parse(lab.census());
const instanceOwn = JSON.parse(lab.instanceOwn());
const measured = new Map();
for (let i = 0; i < lab.count(); i++) {
  lab.start(i);
  // Every job the operation queued runs before the reads are collected.
  await new Promise((resolve) => setImmediate(resolve));
  measured.set(lab.id(i), JSON.parse(lab.finish()));
}

const PRIMITIVE_WRAPPERS = {
  string: "String.prototype",
  number: "Number.prototype",
  boolean: "Boolean.prototype",
  symbol: "Symbol.prototype",
  bigint: "BigInt.prototype",
};
/** The census objects a member read through a value of `sample` passes. */
const chainOf = (sample) => {
  const chain = [];
  for (let at = PRIMITIVE_WRAPPERS[sample] ?? sample; at !== undefined; at = inherits[at])
    chain.push(at);
  return chain;
};
/** `seen` as "keys read through `chain` | members read from other objects". */
const row = (seen, chain, except = "") => {
  const keys = new Set();
  const others = new Set();
  for (const entry of seen) {
    if (entry === except) continue;
    const at = entry.indexOf(" ");
    if (chain.includes(entry.slice(0, at))) keys.add(entry.slice(at + 1));
    else others.add(entry);
  }
  const text = [...keys].sort().join(" ");
  return others.size === 0 ? text : `${text} | ${[...others].sort().join(", ")}`;
};

const constructReads = {};
const memberReads = {};
const calleeSeen = new Map();
for (const [id, seen] of measured) {
  const parts = id.split(" ");
  if (parts[0] === "construct") {
    const text = row(seen, chainOf(parts[2]));
    if (text !== "") (constructReads[parts[1]] ??= {})[parts[2]] = text;
  } else if (parts[0] === "member") {
    const text = row(seen, chainOf(parts[1]), `${parts[2]} ${parts[3]}`);
    if (text !== "") memberReads[`${parts[2]} ${parts[3]}`] = text;
  } else {
    const callee = parts.slice(2).join(" ");
    if (!calleeSeen.has(callee)) calleeSeen.set(callee, {});
    calleeSeen.get(callee)[parts[1]] = seen;
  }
}
// What a callee reads through its argument is what it reads from the array,
// plain object or promise it is given (or from the array's one element) and
// does not read without an argument.
const calleeReads = {};
const ARGUMENT_CHAIN = ["Promise.prototype", "Array.prototype", "Object.prototype"];
for (const [callee, runs] of calleeSeen) {
  const base = new Set(runs.none);
  const seen = new Set();
  for (const kind of Object.keys(runs)) for (const entry of runs[kind]) seen.add(entry);
  const keys = new Set();
  const others = new Set();
  for (const entry of seen) {
    const at = entry.indexOf(" ");
    if (ARGUMENT_CHAIN.includes(entry.slice(0, at)) && !base.has(entry))
      keys.add(entry.slice(at + 1));
    else others.add(entry);
  }
  const text = [...keys].sort().join(" ");
  const full = others.size === 0 ? text : `${text} | ${[...others].sort().join(", ")}`;
  if (full !== "") calleeReads[callee] = full;
}
// A member an instance holds itself, among the names its prototype chain
// defines: the others are no built-in member at all.
const instanceOwnRows = {};
for (const sample of Object.keys(instanceOwn)) {
  const chain = chainOf(sample);
  const own = instanceOwn[sample].filter((name) => chain.some((at) => name in table[at]));
  if (own.length > 0) instanceOwnRows[sample] = own.sort().join(" ");
}

const owners = Object.keys(table).sort();
const count = owners.reduce((n, owner) => n + Object.keys(table[owner]).length, 0);
const censusRow = (owner) =>
  `  ${JSON.stringify(owner)}: ${JSON.stringify(
    Object.keys(table[owner])
      .sort()
      .map((name) => `${table[owner][name]}${name}`)
      .join(" "),
  )},`;
const record = (object) =>
  Object.keys(object)
    .sort()
    .map((key) => `  ${JSON.stringify(key)}: ${JSON.stringify(object[key])},`);
/** The rows of `object` grouped by their text: one `reads: names` line per
 * distinct text, the names comma-separated. */
const grouped = (object, indent) => {
  const names = new Map();
  for (const key of Object.keys(object).sort()) {
    if (!names.has(object[key])) names.set(object[key], []);
    names.get(object[key]).push(key);
  }
  return [...names.keys()]
    .sort()
    .map(
      (reads) =>
        `${indent}${JSON.stringify(reads)}: ${JSON.stringify(names.get(reads).join(", "))},`,
    );
};
const lines = [
  `/* Generated by scripts/gen-builtin-object-members.mjs from Node v${pinned}. Do not edit. */`,
  "",
  `/** The own members of every ECMAScript built-in object: ${count} members of ${owners.length}`,
  " * objects. Each row is a space-separated list of member names, each behind",
  " * one letter: `f` a function, `a` an accessor, `t` other data that is",
  " * truthy, `z` other data that is falsy; then `-` when an assignment cannot",
  " * change the member (data that is not writable, an accessor without a",
  " * setter) and `=` when it is not configurable. A well-known symbol key is",
  " * spelled `@@iterator`. */",
  "export const BUILTIN_OBJECT_MEMBERS: Readonly<Record<string, string>> = {",
  ...owners.map(censusRow),
  "};",
  "",
  "/** The built-in object each built-in object inherits from, when that is one",
  " * of the objects above (`%TypedArray%` is the intrinsic no global names). */",
  "export const BUILTIN_OBJECT_INHERITS: Readonly<Record<string, string>> = {",
  ...owners
    .filter((owner) => inherits[owner] !== undefined)
    .map((owner) => `  ${JSON.stringify(owner)}: ${JSON.stringify(inherits[owner])},`),
  "};",
  "",
  "/** The members a value of a built-in class holds itself, by the class's",
  " * prototype: a read of one through the value never reaches the prototype. */",
  "export const BUILTIN_INSTANCE_OWN_MEMBERS: Readonly<Record<string, string>> = {",
  ...record(instanceOwnRows),
  "};",
  "",
  "/* The readers. Every row is what Node was seen to read from built-in objects",
  " * while it ran one operation: the keys read through the operand's prototype",
  " * chain, then after ` | ` the members read from other objects (`Owner key`,",
  " * comma-separated). A key no built-in defines (`then`, `toJSON`,",
  " * `@@toPrimitive` on most classes) is one the operation asks the chain for. */",
  "",
  "/** What a language construct reads from its operand, by construct and then",
  " * by what is read: the value is the operand classes that read it,",
  " * comma-separated, each a prototype's name or a primitive's type. `string`",
  " * is ToString (a template literal, `String(v)`), `concat` is ToPrimitive",
  ' * without a hint (`v + ""`), `number` is ToNumber, `iterate` is for…of,',
  " * spread and array destructuring, `await` and `resolve` are an awaited",
  " * value and the value a promise is resolved with, `json` is",
  " * `JSON.stringify(v)`. */",
  "export const BUILTIN_CONSTRUCT_READS: Readonly<Record<string, Readonly<Record<string, string>>>> = {",
  ...Object.keys(constructReads)
    .sort()
    .flatMap((construct) => [
      `  ${JSON.stringify(construct)}: {`,
      ...grouped(constructReads[construct], "    "),
      "  },",
    ]),
  "};",
  "",
  "/** What calling (or, for an accessor, reading) a prototype's member reads",
  " * from its receiver besides the member itself, by `Owner key`. */",
  "export const BUILTIN_MEMBER_READS: Readonly<Record<string, string>> = {",
  ...record(memberReads),
  "};",
  "",
  "/** What calling a built-in function reads from its first argument, by what",
  " * is read: the value is the callees that read it, comma-separated, each as",
  " * a program spells it (`Array.from`, `String`), a construction as",
  " * `new:Map`. */",
  "export const BUILTIN_CALLEE_READS: Readonly<Record<string, string>> = {",
  ...grouped(calleeReads, "  "),
  "};",
  "",
];
const text = lines.join("\n");
if (checkOnly) {
  if (readFileSync(out, "utf8") !== text) {
    console.error(`${out} is stale: run node scripts/gen-builtin-object-members.mjs`);
    process.exit(1);
  }
  console.log(`${out} is current`);
} else {
  writeFileSync(out, text);
  console.log(`wrote ${out}`);
}
