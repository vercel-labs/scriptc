// The chained whole export evaluates its value once, whatever parentheses
// wrap it: the declarator and module.exports hold that one value.
let calls = 0;
function make(value) {
  calls += 1;
  return { value };
}
var first = module.exports = (make("first"));
console.log(first.value, calls);
var second = (module.exports = ((make("second"))));
console.log(second.value, calls);
