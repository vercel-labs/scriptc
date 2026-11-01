// Node erases a type assertion, so `delete (o as View).k` deletes the member
// from the object `o` names. Lowering the asserted expression instead deletes
// from the assertion's converted copy, which vanishes without a diagnostic.
// The delete now addresses the operand and lands in place when the value's
// own stored layout holds the member as a deletable slot: an optional
// field's ABSENT state, or a pure `Record<string, T>` key. A view that names
// a member the layout cannot hold has nothing to delete and is refused by
// name (tests/diagnostics/delete-asserted-view-copy.ts).
interface Opt {
  a?: number;
  b: string;
}

// Statement form: the optional field leaves `in`, Object.keys, and JSON.
const opt: Opt = { a: 1, b: "x" };
delete (opt as { a?: number }).a;
console.log("split", "a" in opt, opt.a, Object.keys(opt), JSON.stringify(opt));

// The same write rule puts the field back (present again).
(opt as { a?: number }).a = 5;
console.log("readd", "a" in opt, opt.a, Object.keys(opt), JSON.stringify(opt));

// Value position answers Node's boolean: `true` for a member that is gone,
// including a second delete of a member already absent.
const first = delete (opt as { a?: number }).a;
const second = delete (opt as { a?: number }).a;
console.log("value", first, second, "a" in opt, Object.keys(opt), JSON.stringify(opt));

// Bracket spellings name the same slot: a literal key, and a literal-typed
// binding (whose read is pure, so it is not evaluated separately).
const bracket: Opt = { a: 1, b: "x" };
delete (bracket as { a?: number })["a"];
console.log("bracket", "a" in bracket, Object.keys(bracket), JSON.stringify(bracket));
const literal: Opt = { a: 2, b: "y" };
const key = "a";
console.log("literal", delete (literal as { a?: number })[key], Object.keys(literal));

// `as unknown as T` is the same erased view in both positions.
const chained: Opt = { a: 1, b: "x" };
delete (chained as unknown as { a?: number }).a;
const chainedAgain = delete (chained as unknown as { a?: number }).a;
console.log("chain", chainedAgain, "a" in chained, Object.keys(chained), JSON.stringify(chained));

// A pure index-signature layout holds every string key, so the asserted view
// deletes the key the operand's own map holds (dot, computed, and value
// position; the computed key's ToString runs exactly once).
let keyRuns = 0;
function indexKey(): string {
  keyRuns++;
  return "a";
}
const counted: Record<string, number> = { a: 1, b: 2 };
delete (counted as Record<string, number | undefined>).a;
const computed = delete (counted as Record<string, number | undefined>)[indexKey()];
const absent = delete (counted as Record<string, number | undefined>)["zzz"];
console.log("index", computed, absent, keyRuns, "a" in counted, Object.keys(counted), JSON.stringify(counted));

// An operand with side effects is lowered once in both positions.
let calls = 0;
const shared: Opt = { a: 1, b: "x" };
function get(): Opt {
  calls++;
  return shared;
}
delete (get() as { a?: number }).a;
(shared as { a?: number }).a = 7;
const viaCall = delete (get() as { a?: number }).a;
console.log("receiver", calls, viaCall, "a" in shared, Object.keys(shared), JSON.stringify(shared));

// A frozen record keeps its member: strict code throws Node's TypeError for
// the delete of a present field, and a delete of a field that is not there
// still answers `true`.
interface FrozenView {
  a?: number;
  b?: string;
  c: string;
}
const frozen: FrozenView = { a: 1, c: "z" };
Object.freeze(frozen);
try {
  delete (frozen as { a?: number }).a;
  console.log("frozen", "no throw");
} catch (e) {
  console.log("frozen", (e as Error).message, "a" in frozen, frozen.a, Object.keys(frozen));
}
console.log(
  "frozen-absent",
  delete (frozen as { b?: string }).b,
  "b" in frozen,
  Object.keys(frozen),
);

// dyn and named-property array views keep their ordinary delete path: an
// untyped cast is an identity-preserving view, not a record conversion.
const raw: unknown = JSON.parse('{"a":1,"b":2}');
delete (raw as { a?: number }).a;
console.log("dyn", JSON.stringify(raw), (raw as { a?: number }).a);
type Bag = Record<string, unknown>;
const numbers: number[] = [1, 2, 3];
(numbers as unknown as Bag).extra = "named";
delete (numbers as unknown as Bag).extra;
console.log("array", (numbers as unknown as Bag).extra, Object.keys(numbers as unknown as Bag));
export {};
