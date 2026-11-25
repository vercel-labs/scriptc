// Writes to members of built-in objects that nothing in the program reads
// natively: each one is seen by the readers the runtime serves from the
// object, and the program prints what Node prints. A program that also used
// one of these members through a native call, conversion or iteration would
// be refused when it is built (tests/diagnostics/builtin-member-write*).

// A replaced method read back through the prototype object.
var originalPush = Array.prototype.push;
var pushes = 0;
Array.prototype.push = function () {
  pushes++;
  return originalPush.apply(this, arguments);
};
console.log("push", typeof Array.prototype.push, Array.prototype.push === originalPush, pushes);

// A replaced method read as a value through an untyped array, then called.
var replacedSlice = function () {
  return "patched";
};
Array.prototype.slice = replacedSlice;
var list = JSON.parse("[1,2]");
console.log("slice", list.slice === replacedSlice, typeof list.slice);
var readSlice = list.slice;
console.log("slice call", String(readSlice.call(list, 0)));

// A replaced iterator: for...of, array spread and Array.from over untyped
// values run it.
var savedIterator = Array.prototype[Symbol.iterator];
Array.prototype[Symbol.iterator] = function () {
  return {
    next() {
      return { done: true };
    },
  };
};
function count(values) {
  var n = 0;
  for (var value of values) n++;
  return n;
}
function spread(values) {
  return [...values].length;
}
function copy(values) {
  return Array.from(values).length;
}
console.log("iterate", count(JSON.parse("[1,2]")), count([1, 2]), spread(JSON.parse("[1,2]")), copy([1, 2]));
console.log("from", Array.from([1, 2]).length);
Array.prototype[Symbol.iterator] = savedIterator;
console.log("restored", count([1, 2]), spread([3]), copy([4, 5]));

// A constructor's member read before it is replaced, and reached through an
// untyped value that holds the constructor.
var originalIsArray = Array.isArray;
Array.isArray = function (value) {
  return "patched:" + originalIsArray(value);
};
function identity(value) {
  return value;
}
var holder = identity(Array);
console.log("static", typeof originalIsArray, String(holder.isArray([])));

// An array holds its own length, so a write to the prototype's is not read
// through an array.
Array.prototype.length = 0;
var pair = [12, 11];
console.log("length", pair.length, Array.prototype.length);

// A constructor stored on Array.prototype stays one own name, after length,
// and an untyped array reads it.
function Replacement() {}
Array.prototype.constructor = Replacement;
var names = Object.getOwnPropertyNames(Array.prototype);
console.log("constructor", names[0], names[1], JSON.parse("[1]").constructor === Replacement);

// A test of a member the program may assign is evaluated when it runs, not
// decided from what the member is at startup.
Error.stackTraceLimit = 0;
if (!Error.stackTraceLimit) {
  Array.prototype.lastIndexOf = function () {
    return -2;
  };
  console.log("limit", Error.stackTraceLimit, typeof Array.prototype.lastIndexOf);
}

// A definition that only changes a member's attributes replaces nothing, in
// the singular and in the plural form: the member is still called natively.
Object.defineProperty(Math, "min", { writable: false });
Object.defineProperties(Math, { max: { writable: false } });
console.log(
  "attributes",
  Math.min(1, 2),
  Math.max(1, 2),
  Object.getOwnPropertyDescriptor(Math, "min").writable,
  Object.getOwnPropertyDescriptor(Math, "max").writable,
);
