// The assert surface's honest fences: loose deep equality over recursive
// types (equal/notEqual, deepEqual/notDeepEqual and assert/strict's aliases lower),
// reference-equality strictEqual on objects,
// union operands (narrow first), mismatched or uncomparable deep types
// (typed arrays, class instances), namespace-object calls, unsupported
// throws/rejects expectations (properties outside the static error
// surface, empty shapes, non-literal objects, doesNotReject shapes —
// Node's own TypeError), ifError over uncomparable types, and assert.throws
// as a value. Every reached site terminates in a named
// diagnostic — never a miscompare, never silence.
import assert from "node:assert";
import * as assertNs from "node:assert";

assert.equal(1, 1); // shallow legacy equality lowers for primitives
assert.notEqual(1, 2);
assert.deepEqual([1], [1]); // loose deep equality lowers
assert.notDeepEqual([1], [2]);

const box = { n: 1 };
assert.strictEqual(box, box); // reference equality — deepStrictEqual hint

let maybe: string | undefined = "x";
if ("x".length === 0) maybe = undefined;
assert.strictEqual(maybe, "x"); // union operand — narrow first

const unk: unknown = JSON.parse("{}");
assert.strictEqual(unk, { n: 1 }); // strict + composite static side: reference identity does not survive the unknown boundary
assert.deepStrictEqual(unk, new Uint8Array([1])); // bytes static side: the dyn copy cannot carry the brand
assert.deepStrictEqual(unk, new Map<string, number>()); // not dyn-convertible

assert.deepStrictEqual([1, 2], ["a", "b"]); // different static types
assert.deepStrictEqual([new Uint8Array([1])], [new Uint8Array([1])]); // NESTED typed arrays fence (no brand in the element type)
class Point {
  x: number;
  constructor(x: number) {
    this.x = x;
  }
}
assert.deepStrictEqual(new Point(1), new Point(1)); // class instances fence

assertNs(true); // namespace objects are not callable in Node

assert.throws(() => { throw new Error("x"); }, { errno: -2 }); // properties outside the static error surface
assert.throws(() => { throw new Error("x"); }, {}); // Node rejects the empty shape
// (a convertible record VARIABLE as the expected shape lowers now — the
// errValue key walk; corpus 2556 pins it)
void assert.doesNotReject(async () => {}, { name: "TypeError" }); // Node's own TypeError (function or RegExp only)
assert.ifError(new Map<string, number>()); // no honest ifError rendering for this type

const throwsFn = assert.throws; // assert.throws as a value: it takes the function to run
throwsFn(() => {});

interface Tree { label: string; kids: Tree[] }
const tree: Tree = { label: "t", kids: [] };
assert.deepEqual(tree, tree); // recursive type: the failure message needs a deep copy
const handler = { run: () => 1 };
assert.deepEqual(handler, handler); // functions inside a structure: the boxes carry no source names
assert.partialDeepStrictEqual(tree, { label: "t" }); // recursive type: the failure message needs a deep copy
