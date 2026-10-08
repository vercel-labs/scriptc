// @exit: 1
// An early call that reads a later numeric let is a ReferenceError, not
// the binding's default value.
console.log("before");
report();
let level = 2;
function report(): void {
  console.log("level", level);
}
