// Union support boundaries: what stays rejected, with specific messages.
type AB = { k: "a"; v: number } | { k: "b"; v: string };

function mk(): number | string {
  return 1;
}
function mkAB(): AB {
  return { k: "a", v: 1 };
}

// Union-to-union WIDENING re-tags at runtime now (corpus 965/966), and a
// width-differing RECORD arm lifts through the reshape copy when exactly
// ONE destination record arm accepts it (corpus 1556); what stays rejected
// is the AMBIGUOUS case — a source record arm that width-coerces into
// SEVERAL destination record arms has no honest single mapping.
type WideArm = { n: number; m: string };
function ambiguousArm(x: WideArm | number): { n: number } | { m: string } | number {
  return x;
}
const na = ambiguousArm(5);

// Truthiness, logical operators, === — and PRINTING — over whole unions
// now LOWER (per-union helpers; console.log dispatches per arm with
// Node's console semantics: string arms verbatim, others inspected).
const u = mk();
if (u) {
  console.log("truthy");
}
const both = mk() === mk();
const picked = mk() && mk();
console.log(both, picked === u);
console.log(u);

// Union switches evaluate computed discriminants once; their arms still need
// static equality, pure case tests, and non-final clauses that exit.
switch (mk()) {
  case 1:
    break;
}

// Field reads on a union receiver compile now even when the arm types
// differ — the keyed-read JOIN (corpus 1541); mkAB().v is no longer a
// fence. One-argument indexOf/includes lower union values with per-arm JS
// equality and correct hole handling. Calls with fromIndex remain explicitly
// fenced.
const items: (number | string)[] = [1, "two"];
console.log(items.indexOf(1));
console.log(items.includes("two"));
// Unions may contain function arms beside data arms now (typeof narrows,
// closure pointer identity per tag compares) — no pin here anymore.

// Bare undefined/null bindings compile: unit-only types ride the interned
// null|undefined union (the value is one of the two immortal unit
// instances; comparisons are tag tests).
const bareU = undefined;
const bareN = null;

// Whole-union string conversion lowers for primitive/unit arms (the
// per-union ToString helper — `${mk()}` compiles); an OBJECT arm has no
// honest text (JS prints "[object Object]") and stays fenced.
const templated = `${mkAB()}`;

// `x == null` lowers as the null-or-undefined tag test — but a union with
// BOTH unit arms needs the operand twice, so an effectful operand (a call)
// gets its own fence pointing at a const binding.
function mkNullish(): string | null | undefined {
  return null;
}
const looseCall = mkNullish() == null;

// A DECLARED `T | string` param infers nothing for T (no union
// unification); the body's use of T then fails with the instantiation.
function tagOr<T>(x: T | string): T {
  return x as T;
}
console.log(tagOr(5));

// `??` on a multi-arm union lowers now: every non-unit arm re-wraps into
// the result union through the interned %nullish.retag helper (the
// effect-free literal default pre-evaluates).
function subUnionDefault(x: number | string | undefined): number | string {
  return x ?? 0;
}
console.log(subUnionDefault(1));

// A default OUTSIDE the union re-tags too (string | number here): the
// string arm keeps its home and the literal default takes the number arm.
function mixedDefault(x: string | undefined): string | number {
  return x ?? 7;
}
console.log(mixedDefault("s"));

// `??=` writes through variables only; property targets could have
// accessors, where assign-always vs assign-when-nullish is observable.
const holder: { slot?: string } = {};
holder.slot ??= "v";

// `?.` on a multi-arm union: the guarded receiver is a sub-union.
function chainSubUnion(x: number | string | undefined): number {
  return x?.valueOf === undefined ? 0 : 1;
}
console.log(chainSubUnion(1));

// Multi-step chains over RECORD tails compile now — the undefined-armed
// receiver's keyed-read JOIN answers the short-circuit (corpus 1541);
// `o?.inner.size ?? 0` is no longer a fence.
