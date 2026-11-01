// Delete fences: a HYBRID index-signature shape (declared fields + overflow)
// cannot delete — overflow keys are runtime state against declared struct
// slots (pure Record<string, T> shapes and declared OPTIONAL fields delete;
// tsc itself rejects deleting required fields).
type Hybrid = { base: string; [k: string]: string };
const h: Hybrid = { base: "b", extra: "e" };
delete h["extra"];
console.log(h.base);

// An OPTIONAL checked-dynamic field (`unknown`/`any`) has no ABSENT state
// for a delete to write — the slot cannot represent "no property", and an
// omitted one already reads as present — so the refusal names that reason
// instead of calling the optional field required.
interface Dyn {
  content: string[];
  structured?: unknown;
}
const d: Dyn = { content: [] };
delete d.structured;

// The same fence on a union of records: every arm declares the field
// optional and checked-dynamic.
interface DynA {
  content: string[];
  structured?: unknown;
  extra?: any;
}
interface DynB {
  content: string[];
  structured?: unknown;
}
function drop(u: DynA | DynB): void {
  delete u.structured;
}
drop(d);

// A key of SEVERAL literals (a parameter keeps the union; a `const`
// binding narrows to its initializer's literal and folds) names no single
// slot statically; the refusal names the key form instead of claiming a
// field is required.
interface Two {
  a?: number;
  b?: number;
}
const two: Two = {};
function dropTwo(which: "a" | "b"): void {
  delete two[which];
}
dropTwo("a");

// A REQUIRED record field has no absent state to write, so the refusal
// names that reason (tsc rejects the delete itself; the fence explains
// the shape decision to a program that reaches lowering through a
// suppression).
interface StrictRecord {
  a: string;
  b: number;
}
const required: StrictRecord = { a: "a", b: 1 };
// @ts-expect-error -- a required field cannot be removed; the fence says why
delete required.b;
console.log(required.a);

// A CLASS field lives in the instance's fixed layout: nothing can make
// Object.keys, `in`, or JSON.stringify forget it, so the fence says the
// layout — not the receiver — is the obstacle.
class Point {
  x = 0;
  y = 0;
}
const pt = new Point();
// @ts-expect-error -- a class field cannot be removed; the fence says why
delete pt.x;
console.log(pt.y);
