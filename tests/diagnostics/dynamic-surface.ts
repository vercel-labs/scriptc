// The island-backed ambient surface (number methods and Number statics)
// typechecks against real static types but executes in the embedded
// engine: in a static build every use site is its own SC2012 naming the
// flag — never an ICE, never a link error. Static Math methods include
// the scalar functions and variadic Math.hypot. The .split(string),
// trim/pad variants, parseInt, isNaN, the global parseFloat/isFinite and
// Number.parseFloat/Number.parseInt over exactly-typed arguments,
// string-pattern replacement and toPrecision compile statically now and no
// longer appear here; toLocaleString at an explicit non-en-US locale still
// has no lowering (the default-locale form lowers over ICU).)
const up = Math.cbrt(2);
const tau = Math.PI * 2;
const price = (19.99).toLocaleString("de-DE");
const n = Number.parseFloat("3.14");
void n;
