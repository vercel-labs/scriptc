// @requires-libnode
// Island objects held by reference (scope-B NI-4): one handle per Node
// object, so identity, aliasing and mutation are shared with Node, while
// primitives, strings and BigInt cross as exact copies.
import { requireModule } from "@scriptc/node";

const lib = requireModule("./lib.cjs");

// Identity: the same Node object is the same value on both sides.
const a = lib.getShared();
const b = lib.shared;
console.log("same handle", a === b, lib.same(a, b), lib.same(a, lib.getShared()));
console.log("distinct", lib.makeCounter() === lib.makeCounter());

// Mutation is visible on both sides.
a.count = 41;
console.log("island sees", lib.read(b, "count"), "bump", lib.bump(), "native sees", a.count);
a.items.push("x");
lib.shared.items.push("y");
console.log("items", a.items.length, b.items.join("+"), lib.read(lib.shared.items, 1));
a.extra = { nested: true };
console.log("keys", lib.keysOf(a), Object.keys(b).join(","));
console.log("in", "extra" in a, "missing" in a);
delete a.extra;
console.log("deleted", "extra" in b, lib.keysOf(a));

// Closures and getters live in Node.
const counter = lib.makeCounter();
counter.inc();
counter.inc();
console.log("counter", counter.inc(), counter.value);

// Functions as values, typeof, classes, instanceof.
const add = lib.add;
console.log("call", add(2, 3), typeof add, typeof a, typeof lib.Point);
const p = new lib.Point(3, 4);
console.log("point", p.x, p.y, p.norm(), p instanceof lib.Point, a instanceof lib.Point);
console.log("describe", lib.describe(p), lib.describe(add));

// Exact numbers and BigInt.
const nums = lib.numbers();
const negZero = nums[0];
console.log("numbers", Object.is(negZero, -0), lib.isNegZero(negZero), Number.isNaN(nums[1]), nums[2], nums[3]);
console.log("bigint", nums[4], typeof nums[4], nums[4] + 1n, lib.add(nums[5], 2n));
console.log("negzero in", lib.isNegZero(-0), lib.isNegZero(0));

// Strings, lone surrogates included.
const strs = lib.strings();
for (let i = 0; i < 4; i++) {
  const s = strs[i];
  console.log("string", s.length, lib.codeUnits(s) === lib.codeUnits(strs[i]), lib.same(s, strs[i]));
}
console.log("native string", lib.codeUnits("a\ud800b"), lib.add("x", "é"));

// util.inspect of island objects is Node's own.
console.log(p);
console.log(counter, [1, 2]);
console.log("inspect", lib.makeCounter());

// ES modules load through require(esm): the namespace is a live handle.
const esm = requireModule("./esm.mjs");
console.log("esm", esm.kind, esm.default.name, esm.bump(), esm.bump(), esm.counter);
