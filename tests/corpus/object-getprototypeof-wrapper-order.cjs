// A primitive's prototype keeps one identity for the whole run, whichever
// comes first: reading it from Object.getPrototypeOf, or building the
// wrapper prototype with new String/new Number. Function.prototype's own
// prototype is Object.prototype, so a chain walk ends instead of cycling.
const beforeString = Object.getPrototypeOf("x");
const boxedString = new String("x");
const afterString = Object.getPrototypeOf("x");
console.log("stable-string", beforeString === afterString, typeof boxedString);

const boxedNumber = new Number(1);
const beforeNumber = Object.getPrototypeOf(1);
const afterNumber = Object.getPrototypeOf(1);
console.log("stable-number", beforeNumber === afterNumber, typeof boxedNumber);

console.log("prototypes", typeof String.prototype, typeof Number.prototype);
const fn = () => 1;
const fnPrototype = Object.getPrototypeOf(fn);
console.log(
  "function-chain",
  typeof fnPrototype,
  fnPrototype !== fn,
  Object.getPrototypeOf(fnPrototype) === Object.prototype,
  Object.getPrototypeOf(Object.getPrototypeOf(fnPrototype)) === null,
);
