// A discarded negation of a void-typed call (TS1345): Node evaluates the
// operand once and throws the boolean away. The negation's result is unused
// in statement position, so the call's side effects (and any exception) are
// the whole observable behavior.
function register() {
  console.log("registered");
}
!register();
!!register();
!!!register();
!(!((register())));
((!!(register())));
!function () {
  console.log("anonymous");
}();
// Evaluation order and single evaluation are unchanged.
const order = [];
function first() {
  order.push("first");
}
function second() {
  order.push("second");
}
!!first();
!!!second();
console.log(order.join(","));
// The operand still throws when it throws.
function boom() {
  throw new Error("boom");
}
try {
  !boom();
} catch (error) {
  console.log(error.message);
}
function maybeBoom(fail) {
  console.log("before maybe boom");
  if (fail) throw new Error("maybe boom");
}
try {
  !!!maybeBoom(true);
} catch (error) {
  console.log(error.message);
}
// A parenthesized operand is the same discarded negation.
!(register());
// Only the negation whose operand the diagnostic was reported on is
// discarded: an admitted discarded negation nested inside an IIFE leaves the
// IIFE's negation around it consuming the boolean it reads.
console.log(
  !(function () {
    !register();
    return false;
  })(),
);
console.log(
  !(() => {
    !register();
    return false;
  })(),
);
if (!(function () {
  !register();
  return 0;
})())
  console.log("truthy result negated");

console.log(
  !!(() => {
    !!!register();
    return false;
  })(),
);

