// Delete fences: a HYBRID index-signature shape (declared fields + overflow)
// cannot delete — overflow keys are runtime state against declared struct
// slots (pure Record<string, T> shapes and declared OPTIONAL fields delete;
// tsc itself rejects deleting required fields).
type Hybrid = { base: string; [k: string]: string };
const h: Hybrid = { base: "b", extra: "e" };
delete h["extra"];
console.log(h.base);

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

// A key the layout does not declare has its home in the record's
// kept-source view only when the record can keep one; a checked-identity
// record with accessor slots has no source to note the key into, so the
// key has no home and the refusal names that.
const theme = {
  get color() {
    return "red";
  },
};
// @ts-expect-error -- `extra` is not a member of the literal's type
delete theme.extra;
console.log(theme.color);

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
