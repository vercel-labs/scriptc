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
// The catch CLAUSE form of this pattern compiles now (corpus 8603); a
// promise handler's destructuring parameter keeps the fence.
Promise.reject(new Error("four")).catch(({ message }: any) => {
  console.log("no", message);
});
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
