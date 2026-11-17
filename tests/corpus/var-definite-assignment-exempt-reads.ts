// A non-null assertion waives tsc's definite-assignment check, not Node's
// rule: a `var` read above its declaration is still `undefined` there, and a
// binding whose reads can run that early keeps the undefined value.
function checkForward(): void {
  console.log(first! === undefined);
  var first: number = 3;
  console.log(first! + 1);
}
checkForward();

// The declaration ahead of the read changes nothing: the read runs before the
// first store, so it is still undefined, and the store is visible after it.
function checkDeclared(): void {
  var second: number;
  console.log(second! === undefined);
  second = 5;
  console.log(second! + 5);
}
checkDeclared();

// A read through a function declared above is decided by the function's own
// call sites (tsc never checks the closure): called before the store, it sees
// undefined; called after it, the store.
function checkClosure(): void {
  function read(): number {
    return third;
  }
  console.log(read() === undefined);
  var third: number;
  third = 7;
  console.log(read());
}
checkClosure();

// The declaration's own assertion waives the same check, so a read above it
// still observes undefined rather than uninitialized storage.
function checkDeclaredAssertion(): void {
  console.log(fourth === undefined);
  var fourth!: number;
  fourth = 9;
  console.log(fourth + 1);
}
checkDeclaredAssertion();
