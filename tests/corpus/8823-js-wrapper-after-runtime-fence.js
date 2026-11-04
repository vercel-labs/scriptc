// @deferred-fences: 1
"use strict";
// A statement the emitter never reaches still names a value: an assignment
// the lowerer refuses (SC1090, "assignment to non-variables" on a typed
// RegExp) lowers to a runtime fence, which always jumps, so the statements
// after it in the same block are not emitted. The closure-name table still
// lists every declared function used as a value anywhere in the program, so
// the wrapper of `positive` has to be defined even though only the
// unreachable statement mentions it; before that, the build failed with
// SC3004 invalid_ir: use of undefined value '@sc_w_positive'. The Test262
// harness shows the same shape (built-ins/Array/prototype/every/
// 15.4.4.16-1-12.js writes a RegExp's own index before passing callbackfn);
// the anonymous callback in `run` makes the emitter build the table at all.
function positive(value) {
  return value > 0;
}
function run(callback) {
  return callback;
}
const boxed = run(function (a, b, c, d) {
  return a + b + c + d;
});
function unreachable() {
  const target = new RegExp("a");
  target.length = 1;
  return [1, 0, 2].every(positive);
}
console.log(boxed(1, 2, 3, 4), typeof unreachable);
