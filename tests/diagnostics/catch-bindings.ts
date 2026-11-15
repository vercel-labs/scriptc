// A catch binding is a value of TypeScript's declared type for it, `unknown`
// or `any`: the narrowing tests answer for whatever was thrown (instanceof,
// every `typeof` kind, type guards — corpus 9363), a read under a narrowing
// the exception cell answers natively extracts the payload, and every other
// read is the binding's checked-dynamic value (corpus 1554; `const copy = e`
// compiles and is NOT in this fence corpus). A destructured catch CLAUSE
// binds through the checked-dynamic tree (corpus 8603) and is not in this
// fence corpus either. What is left must terminate in a clean fence — never
// a silent mis-read of the payload.
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
