// Concrete generic functions and classes monomorphize. Forms without a
// statically resolved body or constructor retain their specific
// diagnostics.
function id<T>(x: T): T {
  return x;
}
// These two now COMPILE (no diagnostics): alias bindings register the
// target, and a generic-signature annotation monomorphizes like the
// unannotated alias — the unpinned-VALUE fences live in
// generic-value-bindings.ts.
function useAsValue(): void {
  const alias = id;
  alias(1);
}
function storeGenericSignature(): void {
  const keep: <T>(x: T) => T = id;
  keep(1);
}
// (`const genericArrow = <T>(x: T): T => x` at module scope now COMPILES —
// the generic value-binding rule; its fences live in
// generic-value-bindings.ts.)
function outer(): void {
  function nested<T>(x: T): T {
    return x;
  }
}
// A body construct that only fails for SOME instantiations reports the
// instantiation that triggered it.
function joinAll<T>(a: T[]): string {
  return a.join(",");
}
console.log(joinAll([1, 2]));
console.log(joinAll([[1], [2]]));

// Generic CLASSES monomorphize per instantiation; the family-level fences
// are the ones with no per-instantiation story.
class Box<T> {
  v: T;
  constructor(v: T) {
    this.v = v;
  }
}
// The uninstantiated family as a value: no thunk, no single ctor ABI.
const BoxAlias = Box;
// Each specialization resolves the matching concrete base layout while
// every specialization retains the declaration's JavaScript class identity.
class Chained<T> extends Box<T> {
  constructor(v: T) {
    super(v);
  }
}
// Generic class expressions: each evaluation would mint a distinct FAMILY.
const ExprFamily = class <T> {
  x: T | undefined;
};

// Reached: unreached bodies never lower, so their rejections only exist
// when something on the entry path uses them.
useAsValue();
storeGenericSignature();
outer();

// Reached: collection defers its diagnostics until a reference makes
// them relevant; these references are what makes them count.
new Box(1);
new Chained(2);
new ExprFamily<number>();
