// The island-backed ambient surface (Math beyond the static members and
// the PI/E constants, number methods, string-pattern replace/at, the
// Number statics, ...) typechecks against real static types but executes
// in the embedded engine: in a static build every use site is its own
// SC2012 naming the flag — never an ICE, never a link error.
// (Math.floor/abs/round and the ask-4 wholeness-discharge pair
// Math.trunc/ceil, Math.PI/Math.E, .split(string), the trim/pad variants,
// parseInt, isNaN, and the global parseFloat/isFinite over
// exactly-typed arguments compile statically now and no longer appear
// here.)
const up = Math.sqrt(2);
const tau = Math.pow(Math.PI * 2, 2);
const price = (19.99).toPrecision(4);
const swapped = "banana".replace("an", "AN");
const ch = "hello".at(0);
const n = Number.parseFloat("3.14");
