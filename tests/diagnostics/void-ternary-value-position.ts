// A conditional expression over two `void` calls has no value — statement
// position and void-returning arrow bodies compile (corpus 2692), but a
// CONSUMED void ternary has no IR representation: fence by name instead of
// the validator's "ternary must not be void" ICE.
function a(): void {
  console.log("a");
}
function b(): void {
  console.log("b");
}
const x = process.argv.length > 99 ? a() : b();
console.log(typeof x);

// A void arm under a NON-void sibling stays consumed: the enclosing ternary
// keeps expression form, so the void arm fences too.
const flag = process.argv.length > 99;
flag ? (flag ? a() : b()) : 0;
