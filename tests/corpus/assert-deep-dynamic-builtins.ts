// assert.deepStrictEqual over checked-dynamic values compares Node's
// built-in kinds by their intrinsic value, not by reference: a Date by its
// time (an invalid date equals another invalid one), a RegExp by source,
// flags and lastIndex, an Error by name, message, cause and errors, a Map
// or Set by its entries in any order, and a typed array by its bytes with
// its Buffer-or-Uint8Array brand. Two distinct handles that Node would
// call equal pass here, and the failure messages are Node's own.
import assert from "node:assert";

function outcome(f: () => void): string {
  try {
    f();
    return "pass";
  } catch (e) {
    return e instanceof Error ? e.message : "not an Error";
  }
}

const d0: unknown = new Date(0);
const d0b: unknown = new Date(0);
const d1: unknown = new Date(1);
const dInvalid: unknown = new Date(Number.NaN);
const dInvalid2: unknown = new Date(Number.NaN);
console.log("A", outcome(() => assert.deepStrictEqual(d0, d0b)));
console.log("B", outcome(() => assert.deepStrictEqual(d0, d1)));
console.log("C", outcome(() => assert.deepStrictEqual(dInvalid, dInvalid2)));
console.log("D", outcome(() => assert.deepStrictEqual(d0, dInvalid)));

const re1: unknown = /a/gi;
const re2: unknown = /a/gi;
const re3: unknown = /a/g;
const re4: unknown = /a/i;
const lastIndexed: any = /a/g;
lastIndexed.lastIndex = 1;
const reLast: unknown = lastIndexed;
const reFresh: unknown = /a/g;
console.log("E", outcome(() => assert.deepStrictEqual(re1, re2)));
console.log("F", outcome(() => assert.deepStrictEqual(re3, re4)));
console.log("G", outcome(() => assert.deepStrictEqual(reLast, reFresh)));

const err1: unknown = new TypeError("boom");
const err2: unknown = new TypeError("boom");
const err3: unknown = new Error("boom");
const err4: unknown = new TypeError("bash");
const coded: any = new Error("boom");
coded.code = "E_CODE";
const coded2: any = new Error("boom");
coded2.code = "E_CODE";
const errCoded: unknown = coded;
const errCoded2: unknown = coded2;
console.log("H", outcome(() => assert.deepStrictEqual(err1, err2)));
console.log("I", outcome(() => assert.deepStrictEqual(err1, err3)));
console.log("J", outcome(() => assert.deepStrictEqual(err1, err4)));
console.log("K", outcome(() => assert.deepStrictEqual(errCoded, errCoded2)));

const map1: unknown = new Map<string, unknown>([
  ["a", 1],
  ["b", { deep: [1, 2] }],
]);
const map2: unknown = new Map<string, unknown>([
  ["b", { deep: [1, 2] }],
  ["a", 1],
]);
const map3: unknown = new Map<string, unknown>([
  ["a", 1],
  ["b", { deep: [1, 3] }],
]);
console.log("L", outcome(() => assert.deepStrictEqual(map1, map2)));
console.log("M", outcome(() => assert.deepStrictEqual(map1, map3)));

const set1: unknown = new Set([1, "two", { three: 3 }]);
const set2: unknown = new Set([{ three: 3 }, 1, "two"]);
const set3: unknown = new Set([1, "two", { three: 4 }]);
console.log("N", outcome(() => assert.deepStrictEqual(set1, set2)));
console.log("O", outcome(() => assert.deepStrictEqual(set1, set3)));

const yesAB: unknown = new ArrayBuffer(2);
const yesAB2: unknown = new ArrayBuffer(2);
const noAB: unknown = new ArrayBuffer(3);
console.log("P", outcome(() => assert.deepStrictEqual(yesAB, yesAB2)));
console.log("Q", outcome(() => assert.deepStrictEqual(yesAB, noAB)));

const weak1: unknown = new WeakMap();
const weak2: unknown = new WeakMap();
console.log("R", outcome(() => assert.deepStrictEqual(weak1, weak2)));

// Sets and Maps pair object members structurally and consume each match
// once: a member already matched cannot stand in for another, and keys that
// are structurally equal may hold each other's values.
const reuseA: unknown = new Map<any, string>([
  [{ k: 1 }, "x"],
  [{ k: 2 }, "y"],
]);
const sharedKey: any = { k: 1 };
const reuseB: unknown = new Map<any, string>([
  [sharedKey, "x"],
  [{ k: 1 }, "x"],
]);
console.log("S", outcome(() => assert.deepStrictEqual(reuseA, reuseB)));
const permutedA: unknown = new Map<any, string>([
  [{ k: 1 }, "x"],
  [{ k: 2 }, "y"],
]);
const permutedB: unknown = new Map<any, string>([
  [{ k: 2 }, "x"],
  [{ k: 1 }, "y"],
]);
console.log("T", outcome(() => assert.deepStrictEqual(permutedA, permutedB)));
const setShared1: unknown = new Set<any>([sharedKey, { k: 9 }]);
const setShared2: unknown = new Set<any>([{ k: 1 }, { k: 2 }]);
console.log("U", outcome(() => assert.deepStrictEqual(setShared1, setShared2)));

// Primitive members and keys pair through the map's own lookup: order does
// not matter, and a Map with permuted primitive values is unequal.
const primSet1: unknown = new Set([1, "a", true]);
const primSet2: unknown = new Set([true, 1, "a"]);
const primSet3: unknown = new Set([1, "a", false]);
console.log("V", outcome(() => assert.deepStrictEqual(primSet1, primSet2)));
console.log("W", outcome(() => assert.deepStrictEqual(primSet1, primSet3)));
const primMap1: unknown = new Map<unknown, string>([
  [1, "x"],
  ["a", "y"],
]);
const primMap2: unknown = new Map<unknown, string>([
  ["a", "y"],
  [1, "x"],
]);
const primMap3: unknown = new Map<unknown, string>([
  ["a", "x"],
  [1, "y"],
]);
console.log("X", outcome(() => assert.deepStrictEqual(primMap1, primMap2)));
console.log("Y", outcome(() => assert.deepStrictEqual(primMap1, primMap3)));
