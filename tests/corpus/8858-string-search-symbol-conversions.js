// String.prototype argument conversions that a Symbol makes throw: ToString
// of a Symbol is a TypeError ("Cannot convert a Symbol value to a string"),
// and so is ToNumber/ToIntegerOrInfinity ("Cannot convert a Symbol value to
// a number"). Every search method converts its needle with ToString and its
// position with ToIntegerOrInfinity, so both throw — after the operands have
// been evaluated. scriptc used to answer the refusal fence (a plain Error)
// for these sites.
// @ts-nocheck -- passing a Symbol where the lib declares a string or number
// is a type error in TypeScript and legal JavaScript.
function describe(fn) {
  try {
    return "value:" + fn();
  } catch (error) {
    return error.constructor.name + ":" + error.message;
  }
}

const symbol = Symbol("needle");

// A Symbol search value: ToString(symbol) throws.
console.log("includes", describe(() => "abc".includes(symbol)));
console.log("startsWith", describe(() => "abc".startsWith(symbol)));
console.log("endsWith", describe(() => "abc".endsWith(symbol)));
console.log("indexOf", describe(() => "abc".indexOf(symbol)));
console.log("lastIndexOf", describe(() => "abc".lastIndexOf(symbol)));

// A Symbol position: ToIntegerOrInfinity(symbol) throws.
console.log("includes-position", describe(() => "abc".includes("a", symbol)));
console.log("startsWith-position", describe(() => "abc".startsWith("a", symbol)));
console.log("endsWith-position", describe(() => "abc".endsWith("a", symbol)));
console.log("indexOf-position", describe(() => "abc".indexOf("a", symbol)));
console.log("slice-position", describe(() => "abc".slice(0, symbol)));

// Evaluation order: the receiver, then the argument, then the throw.
const order = [];
function receiver() {
  order.push("receiver");
  return "abc";
}
function needle() {
  order.push("needle");
  return symbol;
}
function position() {
  order.push("position");
  return symbol;
}
console.log("needle-order", describe(() => receiver().includes(needle())));
console.log("needle-order-seen", order.join(","));
order.length = 0;
console.log("position-order", describe(() => receiver().slice(0, position())));
console.log("position-order-seen", order.join(","));

// Ordinary arguments keep working.
console.log("plain", "abc".includes("b"), "abc".startsWith("a"), "abc".endsWith("c"));
console.log("positions", "abc".indexOf("a", 0), "abc".slice(1), "abc".slice(0, 2));
