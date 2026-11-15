// Every util.types predicate over the values a compiled program can make:
// the brand each value carries in a checked-dynamic slot, plus the brands no
// constructible value has (boxed primitives, CryptoKey, external values).
import { types } from "node:util";
import * as direct from "node:util/types";
import { createSecretKey } from "node:crypto";

function* numbers(): Generator<number> {
  yield 1;
}
async function asynchronous(): Promise<void> {}
function plain(): void {}
const map = new Map<string, number>([["a", 1]]);
const set = new Set<number>([1]);
const proxy = new Proxy({}, {});
const buffer = new ArrayBuffer(8);

// A subclass instance keeps its parent's brand, and a value shaped like a
// branded object (an Error prototype, a thenable) has none.
class SubDate extends Date {}
// A Map, Set, Promise, RegExp, ArrayBuffer or typed-array subclass has no
// compiled layout (SC1090), so those brands are covered by base instances.
class SubError extends Error {}
class SubArray extends Array<number> {}
// A BigInt64Array/BigUint64Array cannot be constructed here (their
// constructors have no lowering); 5831 checks those two brands answer false.
const values: [string, unknown][] = [
  ["date", new Date(0)],
  ["array buffer", buffer],
  ["shared buffer", new SharedArrayBuffer(8)],
  ["data view", new DataView(buffer)],
  ["int8", new Int8Array(1)],
  ["uint8", new Uint8Array(1)],
  ["uint8 clamped", new Uint8ClampedArray(1)],
  ["int16", new Int16Array(1)],
  ["uint16", new Uint16Array(1)],
  ["int32", new Int32Array(1)],
  ["uint32", new Uint32Array(1)],
  ["float16", new Float16Array(1)],
  ["float32", new Float32Array(1)],
  ["float64", new Float64Array(1)],
  ["buffer", Buffer.from("x")],
  ["map", map],
  ["set", set],
  ["weak map", new WeakMap<object, number>()],
  ["weak set", new WeakSet<object>()],
  ["map keys", map.keys()],
  ["map values", map.values()],
  ["map entries", map.entries()],
  ["set values", set.values()],
  ["array values", [1, 2].values()],
  ["promise", Promise.resolve(1)],
  ["regexp", /x/],
  ["error", new Error("x")],
  ["type error", new TypeError("x")],
  ["key object", createSecretKey(Buffer.from("secret"))],
  ["proxy", proxy],
  ["generator object", numbers()],
  ["generator function", numbers],
  ["async function", asynchronous],
  ["function", plain],
  ["object", { getTime: () => 0 }],
  ["array", [1, 2]],
  ["url", new URL("http://example.test/")],
  ["search params", new URLSearchParams("a=1")],
  ["blob", new Blob(["x"])],
  ["date subclass", new SubDate(0)],
  ["error subclass", new SubError("x")],
  ["aggregate error", new AggregateError([], "x")],
  ["dom exception", new DOMException("x")],
  ["error prototype", Object.create(Error.prototype)],
  ["thenable", { then: () => {} }],
  ["array subclass", new SubArray(1, 2)],
  ["string", "s"],
  ["number", 1],
  ["bigint", 1n],
  ["boolean", true],
  ["symbol", Symbol("s")],
  ["null", null],
  ["undefined", undefined],
];

function brands(value: unknown): string {
  const hits: string[] = [];
  if (types.isAnyArrayBuffer(value)) hits.push("isAnyArrayBuffer");
  if (types.isArrayBufferView(value)) hits.push("isArrayBufferView");
  if (types.isArrayBuffer(value)) hits.push("isArrayBuffer");
  if (types.isAsyncFunction(value)) hits.push("isAsyncFunction");
  if (types.isBigInt64Array(value)) hits.push("isBigInt64Array");
  if (types.isBigIntObject(value)) hits.push("isBigIntObject");
  if (types.isBigUint64Array(value)) hits.push("isBigUint64Array");
  if (types.isBooleanObject(value)) hits.push("isBooleanObject");
  if (types.isBoxedPrimitive(value)) hits.push("isBoxedPrimitive");
  if (types.isCryptoKey(value)) hits.push("isCryptoKey");
  if (types.isDataView(value)) hits.push("isDataView");
  if (types.isDate(value)) hits.push("isDate");
  if (types.isExternal(value)) hits.push("isExternal");
  if (types.isFloat16Array(value)) hits.push("isFloat16Array");
  if (types.isFloat32Array(value)) hits.push("isFloat32Array");
  if (types.isFloat64Array(value)) hits.push("isFloat64Array");
  if (types.isGeneratorFunction(value)) hits.push("isGeneratorFunction");
  if (types.isGeneratorObject(value)) hits.push("isGeneratorObject");
  if (types.isInt8Array(value)) hits.push("isInt8Array");
  if (types.isInt16Array(value)) hits.push("isInt16Array");
  if (types.isInt32Array(value)) hits.push("isInt32Array");
  if (types.isKeyObject(value)) hits.push("isKeyObject");
  if (types.isMap(value)) hits.push("isMap");
  if (types.isMapIterator(value)) hits.push("isMapIterator");
  if (types.isModuleNamespaceObject(value)) hits.push("isModuleNamespaceObject");
  if (types.isNativeError(value)) hits.push("isNativeError");
  if (types.isNumberObject(value)) hits.push("isNumberObject");
  if (types.isPromise(value)) hits.push("isPromise");
  if (types.isProxy(value)) hits.push("isProxy");
  if (types.isRegExp(value)) hits.push("isRegExp");
  if (types.isSet(value)) hits.push("isSet");
  if (types.isSetIterator(value)) hits.push("isSetIterator");
  if (types.isSharedArrayBuffer(value)) hits.push("isSharedArrayBuffer");
  if (types.isStringObject(value)) hits.push("isStringObject");
  if (types.isSymbolObject(value)) hits.push("isSymbolObject");
  if (types.isTypedArray(value)) hits.push("isTypedArray");
  if (types.isUint8Array(value)) hits.push("isUint8Array");
  if (types.isUint8ClampedArray(value)) hits.push("isUint8ClampedArray");
  if (types.isUint16Array(value)) hits.push("isUint16Array");
  if (types.isUint32Array(value)) hits.push("isUint32Array");
  if (types.isWeakMap(value)) hits.push("isWeakMap");
  if (types.isWeakSet(value)) hits.push("isWeakSet");
  return hits.join(",") || "-";
}

for (const [label, value] of values) console.log(label, brands(value));

// A Date-typed argument answers from its static type; the node:util/types
// spelling shares the lowering, and the answering predicates narrow.
const date = new Date(0);
console.log("date typed", types.isDate(date), direct.isDate(date), types.isMap(date));
const maybe: unknown = map;
if (types.isMap(maybe)) console.log("narrowed map", maybe.size);
const instance: unknown = numbers();
console.log("generator object", types.isGeneratorObject(instance), direct.isGeneratorObject(instance));
if (direct.isArrayBufferView(new Uint8Array(2))) console.log("view");
