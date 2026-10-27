// The island-backed ambient surface (number methods and Number statics)
// typechecks against real static types but executes in the embedded
// engine: in a static build every use site is its own SC2012 naming the
// flag — never an ICE, never a link error. Static Math methods include
// the scalar functions and variadic Math.hypot. The .split(string),
// trim/pad variants, parseInt, isNaN, the global parseFloat/isFinite and
// Number.parseFloat/Number.parseInt over exactly-typed arguments,
// string-pattern replacement and toPrecision compile statically now and no
// longer appear here; toLocaleString without a locale still has no
// lowering.)
const up = Math.cbrt(2);
const tau = Math.PI * 2;
const price = (19.99).toLocaleString();
const n = Number.parseFloat("3.14");
void n;
