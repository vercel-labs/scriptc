// util.types brand checks over typed values: isDate, isSharedArrayBuffer,
// isMapIterator, isSetIterator and isKeyObject answer from the value's
// internal brand, and isBoxedPrimitive (with the per-kind boxed checks),
// isBigInt64Array, isBigUint64Array, isCryptoKey and isExternal answer
// false for every value a program here can create. A Date-typed argument
// answers from its static type.
import { types } from "node:util";
import * as direct from "node:util/types";
import { createSecretKey } from "node:crypto";

const map = new Map<string, number>([["a", 1]]);
const set = new Set<number>([1, 2]);
const values: [string, unknown][] = [
  ["shared buffer", new SharedArrayBuffer(8)],
  ["array buffer", new ArrayBuffer(8)],
  ["map keys", map.keys()],
  ["map entries", map.entries()],
  ["map values", map.values()],
  ["set values", set.values()],
  ["set entries", set.entries()],
  ["array values", [1, 2].values()],
  ["map", map],
  ["set", set],
  ["key object", createSecretKey(Buffer.from("secret"))],
  ["number", 1],
  ["string", "s"],
  ["boolean", true],
  ["bigint", 1n],
  ["symbol", Symbol("s")],
  ["object", { getTime: () => 0 }],
  ["uint8", new Uint8Array(2)],
  ["null", null],
  ["undefined", undefined],
];

function brands(value: unknown): string {
  const hits: string[] = [];
  if (types.isDate(value)) hits.push("isDate");
  if (types.isSharedArrayBuffer(value)) hits.push("isSharedArrayBuffer");
  if (types.isAnyArrayBuffer(value)) hits.push("isAnyArrayBuffer");
  if (types.isMapIterator(value)) hits.push("isMapIterator");
  if (types.isSetIterator(value)) hits.push("isSetIterator");
  if (types.isKeyObject(value)) hits.push("isKeyObject");
  if (types.isBoxedPrimitive(value)) hits.push("isBoxedPrimitive");
  if (types.isNumberObject(value)) hits.push("isNumberObject");
  if (types.isStringObject(value)) hits.push("isStringObject");
  if (types.isBooleanObject(value)) hits.push("isBooleanObject");
  if (types.isBigIntObject(value)) hits.push("isBigIntObject");
  if (types.isSymbolObject(value)) hits.push("isSymbolObject");
  if (types.isBigInt64Array(value)) hits.push("isBigInt64Array");
  if (types.isBigUint64Array(value)) hits.push("isBigUint64Array");
  if (types.isFloat16Array(value)) hits.push("isFloat16Array");
  if (types.isCryptoKey(value)) hits.push("isCryptoKey");
  if (types.isExternal(value)) hits.push("isExternal");
  return hits.join(",") || "-";
}

for (const [label, value] of values) console.log(label, brands(value));

let reads = 0;
function date(ms: number): Date {
  reads++;
  return new Date(ms);
}
console.log("date", types.isDate(date(0)), types.isDate(date(Number.NaN)), direct.isDate(date(1)));
console.log("date others", types.isMap(date(0)), types.isRegExp(date(0)), types.isBoxedPrimitive(date(0)), types.isNativeError(date(0)), reads);

// The node:util/types spellings and a consumed iterator.
const it = map.keys();
for (const _ of it) {
  // drain
}
console.log("drained", direct.isMapIterator(it), direct.isSetIterator(set.keys()));
