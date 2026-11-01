// Emit the intrinsic member table scr_js_intrinsics.c is built from, read
// from the pinned Node release itself (run it with Node 24.22.0; the header
// records the version and refuses another one).
//   node scripts/gen-intrinsics.mjs > packages/runtime/src/scr_js_intrinsics_table.h
//   node scripts/gen-intrinsics.mjs --ts > packages/compiler/src/frontend/lowering/intrinsic-ids.generated.ts
// packages/runtime/test/intrinsics-table.test.ts reruns it and compares, so the
// table cannot drift from the Node pin. Never hand-edit either output.
// One row per own property of each intrinsic, in Reflect.ownKeys order (the
// order Object.getOwnPropertyNames answers), with the property's attributes,
// its kind, and for functions their name and length. Values that are other
// intrinsics are named, not copied, so the runtime links the same objects.
const PIN = "v24.22.0";
if (process.version !== PIN && !process.env.SCRIPTC_INTRINSICS_ANY_NODE) {
  console.error(`gen-intrinsics: run with Node ${PIN} (this is ${process.version})`);
  process.exit(2);
}
const A = (f) => {
  try {
    return f();
  } catch {
    return undefined;
  }
};
// [id, expression]. ids are the names the runtime and the frontend use.
const OBJECTS = [
  ["Object.prototype", () => Object.prototype],
  ["Function.prototype", () => Function.prototype],
  ["Array.prototype", () => Array.prototype],
  ["String.prototype", () => String.prototype],
  ["Number.prototype", () => Number.prototype],
  ["Boolean.prototype", () => Boolean.prototype],
  ["Symbol.prototype", () => Symbol.prototype],
  ["BigInt.prototype", () => BigInt.prototype],
  ["Date.prototype", () => Date.prototype],
  ["RegExp.prototype", () => RegExp.prototype],
  ["Error.prototype", () => Error.prototype],
  ...[
    "EvalError",
    "RangeError",
    "ReferenceError",
    "SyntaxError",
    "TypeError",
    "URIError",
    "AggregateError",
    "SuppressedError",
  ].map((n) => [`${n}.prototype`, () => globalThis[n]?.prototype]),
  ["Map.prototype", () => Map.prototype],
  ["Set.prototype", () => Set.prototype],
  ["WeakMap.prototype", () => WeakMap.prototype],
  ["WeakSet.prototype", () => WeakSet.prototype],
  ["WeakRef.prototype", () => WeakRef.prototype],
  ["FinalizationRegistry.prototype", () => FinalizationRegistry.prototype],
  ["Promise.prototype", () => Promise.prototype],
  ["ArrayBuffer.prototype", () => ArrayBuffer.prototype],
  ["SharedArrayBuffer.prototype", () => SharedArrayBuffer.prototype],
  ["DataView.prototype", () => DataView.prototype],
  ["%TypedArray%.prototype", () => Object.getPrototypeOf(Int8Array.prototype)],
  ...[
    "Int8Array",
    "Uint8Array",
    "Uint8ClampedArray",
    "Int16Array",
    "Uint16Array",
    "Int32Array",
    "Uint32Array",
    "Float16Array",
    "Float32Array",
    "Float64Array",
    "BigInt64Array",
    "BigUint64Array",
  ].map((n) => [`${n}.prototype`, () => globalThis[n]?.prototype]),
  ["Iterator.prototype", () => A(() => Iterator.prototype)],
  ["%ArrayIteratorPrototype%", () => Object.getPrototypeOf([][Symbol.iterator]())],
  ["%StringIteratorPrototype%", () => Object.getPrototypeOf(""[Symbol.iterator]())],
  ["%MapIteratorPrototype%", () => Object.getPrototypeOf(new Map().entries())],
  ["%SetIteratorPrototype%", () => Object.getPrototypeOf(new Set().values())],
  ["%RegExpStringIteratorPrototype%", () => Object.getPrototypeOf(/a/[Symbol.matchAll](""))],
  ["%GeneratorFunction.prototype%", () => Object.getPrototypeOf(function* () {})],
  ["%GeneratorPrototype%", () => Object.getPrototypeOf(function* () {}).prototype],
  ["%AsyncFunction.prototype%", () => Object.getPrototypeOf(async function () {})],
  ["%AsyncGeneratorFunction.prototype%", () => Object.getPrototypeOf(async function* () {})],
  ["%AsyncGeneratorPrototype%", () => Object.getPrototypeOf(async function* () {}).prototype],
  [
    "%AsyncIteratorPrototype%",
    () => Object.getPrototypeOf(Object.getPrototypeOf(async function* () {}).prototype),
  ],
  ["DisposableStack.prototype", () => A(() => DisposableStack.prototype)],
  ["AsyncDisposableStack.prototype", () => A(() => AsyncDisposableStack.prototype)],
];
const byValue = new Map();
for (const [id, get] of OBJECTS) {
  const v = A(get);
  if (v) byValue.set(v, id);
}
// Constructors are named by their global name; their prototypes link back.
const CTORS = [
  "Object",
  "Function",
  "Array",
  "String",
  "Number",
  "Boolean",
  "Symbol",
  "BigInt",
  "Date",
  "RegExp",
  "Error",
  "EvalError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "TypeError",
  "URIError",
  "AggregateError",
  "SuppressedError",
  "Map",
  "Set",
  "WeakMap",
  "WeakSet",
  "WeakRef",
  "FinalizationRegistry",
  "Promise",
  "ArrayBuffer",
  "SharedArrayBuffer",
  "DataView",
  "Int8Array",
  "Uint8Array",
  "Uint8ClampedArray",
  "Int16Array",
  "Uint16Array",
  "Int32Array",
  "Uint32Array",
  "Float16Array",
  "Float32Array",
  "Float64Array",
  "BigInt64Array",
  "BigUint64Array",
  "Iterator",
  "DisposableStack",
  "AsyncDisposableStack",
  "Proxy",
];
for (const n of CTORS) if (globalThis[n]) byValue.set(globalThis[n], n);
byValue.set(Object.getPrototypeOf(Int8Array), "%TypedArray%");
const keyName = (k) => (typeof k === "symbol" ? `@@${k.description.replace(/^Symbol\./, "")}` : k);
const fnInfo = (f) =>
  typeof f === "function" ? { name: A(() => f.name) ?? "", length: A(() => f.length) ?? 0 } : null;
const rows = [];
const emit = (owner, obj) => {
  for (const k of Reflect.ownKeys(obj)) {
    const d = Object.getOwnPropertyDescriptor(obj, k);
    const attrs = (d.writable ? "W" : "") + (d.enumerable ? "E" : "") + (d.configurable ? "C" : "");
    let kind,
      a = "",
      b = "";
    if ("get" in d || "set" in d) {
      kind = "ACCESSOR";
      a = d.get ? `${fnInfo(d.get).name}/${fnInfo(d.get).length}` : "";
      b = d.set ? `${fnInfo(d.set).name}/${fnInfo(d.set).length}` : "";
    } else if (byValue.has(d.value)) {
      kind = "INTRINSIC";
      a = byValue.get(d.value);
    } else if (typeof d.value === "function") {
      kind = "METHOD";
      a = `${fnInfo(d.value).name}/${fnInfo(d.value).length}`;
    } else if (typeof d.value === "number") {
      kind = "NUMBER";
      a = String(d.value);
    } else if (typeof d.value === "string") {
      kind = "STRING";
      a = d.value;
    } else if (typeof d.value === "boolean") {
      kind = "BOOL";
      a = String(d.value);
    } else if (typeof d.value === "symbol") {
      kind = "SYMBOL";
      a = d.value.description;
    } else if (k === Symbol.unscopables) {
      kind = "UNSCOPABLES";
      a = Object.keys(d.value).join(",");
    } else if (d.value === undefined) {
      kind = "UNDEFINED";
    } else if (d.value === null) {
      kind = "NULL";
    } else {
      kind = "OTHER";
      a = Object.prototype.toString.call(d.value);
    }
    rows.push([owner, keyName(k), kind, attrs, a, b]);
  }
};
for (const [id, get] of OBJECTS) {
  const v = A(get);
  if (v) emit(id, v);
}
for (const n of CTORS) if (globalThis[n]) emit(n, globalThis[n]);
emit("%TypedArray%", Object.getPrototypeOf(Int8Array));
// Every object's [[Prototype]], named.
const protos = [];
for (const [v, id] of byValue) {
  const p = Object.getPrototypeOf(v);
  protos.push([id, p === null ? "null" : (byValue.get(p) ?? "?")]);
}
const q = (s) => JSON.stringify(s);
if (process.argv.includes("--ts")) {
  // The ids the frontend may lower to dyn.intrinsic (t262-da §4.1 step 2).
  const ids = [...new Set([...byValue.values()])].sort();
  console.log(
    `/* Generated by scripts/gen-intrinsics.mjs --ts under Node ${process.version}. Do not edit. */`,
  );
  console.log(
    `export const INTRINSIC_IDS: ReadonlySet<string> = new Set([\n${ids.map((i) => `  ${q(i)},`).join("\n")}\n]);`,
  );
  process.exit(0);
}
console.log(
  `/* Generated by scripts/gen-intrinsics.mjs under Node ${process.version}. Do not edit. */`,
);
console.log("/* SCR_JS_INTRINSIC_ROW(owner, key, kind, attributes, a, b) */");
console.log("#define SCR_JS_INTRINSIC_ROWS(X) \\");
for (const r of rows) console.log(`  X(${r.map(q).join(", ")}) \\`);
console.log("");
console.log("/* SCR_JS_INTRINSIC_OBJECT(id): every object, in index order */");
console.log("#define SCR_JS_INTRINSIC_OBJECTS(X) \\");
for (const [, id] of byValue) console.log(`  X(${q(id)}) \\`);
console.log("");
console.log("/* SCR_JS_INTRINSIC_PROTO(object, [[Prototype]]) */");
console.log("#define SCR_JS_INTRINSIC_PROTOS(X) \\");
for (const p of protos) console.log(`  X(${p.map(q).join(", ")}) \\`);
console.log("");
console.error(`rows ${rows.length}, objects ${byValue.size}`);
