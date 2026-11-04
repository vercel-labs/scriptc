/* The checker's opinions about legal JavaScript stay enforced for TypeScript
 * input: each construct below is admitted in a `.js` source — where the
 * runtime decides — and refused here, where an annotation is a promise.
 * Expected, in file order: 2695 (an unused comma-operand left side), 18050
 * (`null`/`undefined` in an arithmetic position) and 7057 (a `yield` used as
 * a value in a generator with no return-type annotation). */
var comma = (1, 2);
var arithmetic = null + undefined;
function* generator() {
  var sent = yield 1;
  return sent;
}
console.log(comma, arithmetic, generator);
