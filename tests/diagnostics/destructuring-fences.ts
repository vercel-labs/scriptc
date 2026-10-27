// Destructuring now lowers defaults in every position (tuple, array with
// the bounds test, record fields, nested patterns, whole-pattern and
// rest-pattern parameters, getter results), rest in every declaration
// position (array slices, tuple tails pack fresh, object rest copies the
// unconsumed fields — class instances included, corpus 2539),
// assignment-position patterns over static sources — record AND
// class-instance, with nested patterns, property/element targets, and
// defaults (corpus 2536-2538) — and for-of expression heads. What stays
// fenced is the honest residue: METHOD extraction over class instances
// (a detached method loses its receiver), rest whose packed type is not
// a plain record (a class of methods only packs '{}' — 'unknown'),
// rest that would copy a NON-PUBLIC field (JS copies it; the rest type
// cannot name it), setter-only properties, union sources (narrow
// first), object patterns over arrays, index-signature rest packing,
// defaults on NESTED assignment targets (no single binding type to
// test against), and assignment targets with no static write form.

class C {
  f = 1;
  describe(): string {
    return `f=${this.f}`;
  }
  set onlyIn(v: number) {
    this.f = v;
  }
}
const { describe } = new C(); // method extraction keeps the fence
console.log(describe());
const { f, ...restOfC } = new C(); // rest over a class instance keeps the fence
console.log(f, Object.keys(restOfC).length);
const { onlyIn } = new C(); // tsc types the setter-only read; the fence names it
console.log(onlyIn);

interface E1 {
  kind: "one";
  b: string;
  count: number;
}
interface E2 {
  kind: "two";
  b: number;
  label: string;
}
function fromUnion(u: E1 | E2): string {
  const { b } = u; // union source whose arms type the field differently: narrow first
  return String(b);
}
console.log(fromUnion({ kind: "one", b: "s", count: 1 }));

const xs = [1, 2, 3];
const { push: append } = xs; // object patterns over arrays read positions and length only
console.log(typeof append);

const indexed: Record<string, number> = { a: 1 };
const { ...allOfIt } = indexed; // index-signature rest needs overflow packing
console.log(allOfIt["a"]);

const holder = { inner: { v: 1 } };
let sink = 0;
({ inner: { v: sink } = { v: 2 } } = holder); // a DEFAULT on a nested assignment target keeps the fence
console.log(sink);

class WithPrivate {
  pub = 1;
  private hidden = 2;
  also = 3;
}
const { pub, ...restOfPriv } = new WithPrivate(); // JS copies 'hidden' into the rest object; the rest type cannot name it
console.log(pub, JSON.stringify(restOfPriv));
