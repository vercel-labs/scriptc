// Generic function VALUE fences, named: every shape here keeps the generic
// signature alive where static monomorphization cannot follow.

// A reassigned binding cannot resolve statically — a later write could hold
// a structurally identical function with a different body.
let flip = <T>(x: T): T => x;
flip = <T>(x: T): T => x;
console.log(flip(1));

// An ALIAS binding registers its target (calls through it monomorphize),
// but a USE with no pinning context still keeps the generic signature —
// the value fences at the reference, not the binding.
const id = <T>(x: T): T => x;
const stored = id;
console.log(typeof stored);

// An alias of a REASSIGNED binding never registers: the target's own
// fence reports, and the alias falls back to the ordinary binding story.
const flipAlias = flip;
console.log(flipAlias(5));

// Declared inside a function and reading its parameter: instances are
// module functions and cannot capture the enclosing frame.
function outer(base: number): number {
  const inner = <T>(x: T): [T, number] => [x, base];
  return inner(3)[1];
}
console.log(outer(4));

// Used as a value inside a function: each call of the enclosing function
// makes a new function object (`make() !== make()`), and the compiled
// instances are shared module functions.
function make(): (x: number) => number {
  const same = <T>(x: T): T => x;
  return same<number>;
}
console.log(make() === make());

// An ambient binding of generic function type now compiles to Node's exact
// ReferenceError at the access (the declare-erasure stance — no diagnostic
// here; the optional chain cannot guard the root's own throw).
declare const ambient: undefined | (<T>(f: (a: T) => T) => T);
console.log(ambient?.((n: number) => n) === undefined);

// A call whose RESULT is itself a generic function: the returned signature
// keeps its type parameters and would need the producing call's frame.
const curried = <T>(x: T) => <U>(y: U): string => `${x}|${y}`;
console.log(curried(1)("a"));

// Ambient `declare class` generic methods are signature-only. Through an
// AMBIENT-ROOTED receiver the call now compiles to Node's ReferenceError
// at the root (the declare-const chain stance — no diagnostic here); a
// receiver that exists at runtime keeps the fence.
declare class Amb {
  m<T>(x: T): T;
}
declare const amb: Amb;
console.log(amb.m(4));
function throughParam(a: Amb): void {
  console.log(a.m(4));
}
throughParam(amb);

// A `var` binding inside a function, declared in a branch and called from
// a closure: when the branch does not run, Node finds the binding undefined.
// The compiled instances have no per-call flag for that, so the call fences.
function branchVar(flag: boolean): number {
  if (flag) {
    var picked = <T>(x: T): T => x;
  }
  const invoke = (): number => picked(1);
  return invoke();
}
console.log(branchVar(true));
