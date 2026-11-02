// String.prototype.replace reached as a value (t262-da A2): the prototype the
// intrinsic table answers is the one a wrapper instance inherits from, so a
// program that copies `String.prototype.replace` (or reads it off a chain)
// calls it through the runtime's dynamic dispatch. The dispatch coerces the
// receiver with ToString and, for a replacement that is not callable, the
// replacement too — before any matching, so an object that converts to
// another object raises ToString's TypeError. A function replacement, and a
// RegExp search value (whose match loop lives in the regex unit), have no
// lowering in that dispatch yet and refuse by name, so no form here passes
// one.
// @ts-nocheck -- a String method called on a Number object is a type error in
// TypeScript and legal JavaScript.
function describe(run) {
  try {
    return String(run());
  } catch (error) {
    return error.constructor.name + ":" + error.message;
  }
}

const replacer = String.prototype.replace;
const at = (thisArg, searchValue, replaceValue) =>
  describe(() => replacer.call(thisArg, searchValue, replaceValue));

console.log("string", at("a-b-c", "-", "+"));
console.log("missing", at("ab", "z", "!"));
console.log("first-only", at("a-a-a", "-", "+"));
console.log("empty", at("ab", "", "-"));

// GetSubstitution: $$, $&, $` and $'.
console.log("dollars", at("ab", "b", "[$&]$$"));
console.log("tick", at("ab", "b", "[$`|$']"));

// The receiver coerces with ToString, as String's generic members specify.
console.log("number", at(1100.5, ".", ","));
console.log("boolean", at(true, "r", "R"));
console.log("object", at({ toString: () => "x-y" }, "-", "+"));

// The search value coerces with ToString too.
console.log("search", at("a5b6", 5, "five"));

// A replacement whose toString answers another object: ToPrimitive fails.
console.log("threw", at("a", "a", { toString: () => function () {} }));

// The same member found through a value of unknown type.
function dynamic(value) {
  return value.replace("an", "AN");
}
console.log("dynamic", dynamic("banana"));
