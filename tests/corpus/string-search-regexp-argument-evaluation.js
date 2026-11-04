// String.prototype.includes, startsWith and endsWith throw a TypeError when
// the search value is a RegExp (IsRegExp, then throw). Every argument is
// evaluated first, in source order — receiver, search value, then the
// position argument and any extra arguments — so their side effects and
// exceptions happen before the TypeError. The position is not converted to an
// index: the throw comes first.
// @ts-nocheck -- passing a RegExp where the lib declares a string is a type
// error in TypeScript and legal JavaScript.
function describe(fn) {
  try {
    return "value:" + fn();
  } catch (error) {
    return error.constructor.name + ":" + error.message;
  }
}

const pattern = /b/;
const log = [];
function position(name) {
  log.push(name);
  return 1;
}

console.log("includes", describe(() => "abc".includes(pattern, position("includes"))));
console.log("startsWith", describe(() => "abc".startsWith(pattern, position("startsWith"))));
console.log("endsWith", describe(() => "abc".endsWith(pattern, position("endsWith"))));
console.log("seen", log.join(","));

// The receiver and the search value are evaluated before the position.
const order = [];
function receiver() {
  order.push("receiver");
  return "abc";
}
function needle() {
  order.push("needle");
  return pattern;
}
console.log("order", describe(() => receiver().includes(needle(), position("position"))));
console.log("order-seen", order.join(","));
console.log("order-log", log.join(","));

// An argument that throws wins over the TypeError.
function boom() {
  throw new RangeError("position threw");
}
console.log("throwing", describe(() => "abc".startsWith(pattern, boom())));

// A position whose conversion would throw is never converted.
console.log("symbol", describe(() => "abc".includes(pattern, Symbol("position"))));

// A primitive position still throws the same TypeError.
console.log("number", describe(() => "abc".includes(pattern, 2)));
console.log("undefined", describe(() => "abc".includes(pattern, undefined)));

// Without a RegExp search value the position behaves as usual.
console.log("plain", "abc".includes("b", 1), "abc".startsWith("a", 0), "abc".endsWith("c", 3));
