// The arguments object is an object that is not an array. The tests that ask
// what it is answer so, for the name and for a constant that holds it, while
// the uses that take it as a list read the call's arguments.

function describe(first) {
  const held = arguments;
  return [
    Array.isArray(arguments),
    Array.isArray(held),
    arguments instanceof Array,
    held instanceof Array,
    arguments instanceof Object,
    Object.prototype.toString.call(arguments),
    {}.toString.call(held),
    arguments.length,
    first === arguments[0],
  ].join(" ");
}
console.log(describe("oak", "elm", "ash"));

// A copy of the arguments is an array.
function copies() {
  const sliced = Array.prototype.slice.call(arguments);
  const spread = [...arguments];
  const made = Array.from(arguments);
  return [
    Array.isArray(sliced),
    Array.isArray(spread),
    Array.isArray(made),
    sliced instanceof Array,
    Object.prototype.toString.call(spread),
    ["start"].concat(sliced, made).join("+"),
  ].join(" ");
}
console.log(copies("oak", "elm"));

// An arrow reads the arguments of the function around it.
function throughArrow() {
  const ask = () => [Array.isArray(arguments), Object.prototype.toString.call(arguments)];
  return ask().join(" ");
}
console.log(throughArrow(1, 2));

// The argument list of `apply` is a list, whatever holds it.
function total() {
  return Math.max.apply(null, arguments) + Array.prototype.concat.apply([], arguments).length;
}
console.log(total(3, 9, 4));

// A function that makes its arguments object spreadable gets it spread.
function spreadable() {
  arguments[Symbol.isConcatSpreadable] = true;
  return ["start"].concat(arguments).join("+");
}
console.log(spreadable("oak", "elm"));

// A function that changes what its arguments object is gets the answer for
// what it made: the prototype decides `instanceof`, and nothing makes the
// object an array.
function reshaped() {
  Object.setPrototypeOf(arguments, Array.prototype);
  return [arguments instanceof Array, Array.isArray(arguments)].join(" ");
}
console.log(reshaped("oak"));
