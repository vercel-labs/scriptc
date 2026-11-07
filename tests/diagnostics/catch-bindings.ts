// Catch bindings are deliberately NARROW: the binding is typed by what the
// exception cell can actually hold, so the supported uses are the narrowing
// tests (instanceof over native classes, typeof over selected types), reads
// under a proven narrow, rethrow, and the unknown-slot CONVERSION (an
// un-narrowed use typed `unknown` converts to a dynamic value — corpus
// 1554; `const copy = e` compiles now and is NOT in this fence corpus).
// A destructured catch CLAUSE binds through the checked-dynamic tree
// (corpus 8603) and is not in this fence corpus either; the promise
// handler parameter, whose pattern the handler cannot bind, is.
// Everything else must terminate in a clean fence — never a silent
// mis-read of the payload.
class Standalone {
  n = 1;
}
try {
  throw 2;
} catch (e) {
  const probe = (): boolean => e instanceof Error; // capture by a closure
  console.log(probe());
}
try {
  throw 3;
} catch (e) {
  if (e instanceof Standalone) {
    // Standalone classes are recognized without a vtable.
    console.log("no");
  }
}
// Destructuring catch bindings compile now. The catch CLAUSE form is corpus
// 8603. A promise handler's destructuring parameter is corpus 8747: the
// handler is then called as a function value, the way
// `p.then(undefined, handler)` calls it, and its parameter destructures
// like any other.
try {
  throw 5;
} catch (e) {
  e = "reassigned"; // the binding is read-only
}
try {
  throw 6;
} catch (e) {
  if (typeof e === "function") {
    // callable catch tests remain outside the supported narrowing set
    console.log("no");
  }
}
