// A discarded negation of a void-typed call (TS1345): Node evaluates the
// operand once and throws the boolean away. The negation's result is unused
// in statement position, so the call's side effects (and any exception) are
// the whole observable behavior.
function register() {
  console.log("registered");
}
!register();
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
!first();
!second();
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
