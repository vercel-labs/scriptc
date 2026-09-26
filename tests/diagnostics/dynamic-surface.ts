// The island-backed ambient surface (number methods, string-pattern
// replace, the Number statics, ...)
// typechecks against real static types but executes in the embedded
// engine: in a static build every use site is its own SC2012 naming the
// flag — never an ICE, never a link error. Static Math methods include
// the scalar functions and variadic Math.hypot. The .split(string),
// trim/pad variants, parseInt, isNaN, and the global parseFloat/isFinite
// over exactly-typed arguments compile statically now and no longer
// appear here.)
const up = Math.cbrt(2);
const tau = Math.PI * 2;
const price = (19.99).toPrecision(4);
const swapped = "banana".replace("an", "AN");
const n = Number.parseFloat("3.14");
