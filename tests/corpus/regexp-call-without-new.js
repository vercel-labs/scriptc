// `RegExp(pattern, flags)` without `new` is the same constructor call as
// `new RegExp(...)`, except that a RegExp pattern with a flags argument
// that is undefined answers the pattern itself (ECMA-262 22.2.3.1).
const pattern = "^(a+)-b$";
const direct = RegExp(pattern, "g");
const constructed = new RegExp(pattern, "g");
console.log(direct.source, direct.flags, direct.test("aa-b"), constructed.source);

const literal = /x+/;
console.log("identity", RegExp(literal) === literal, RegExp(literal, undefined) === literal);
console.log("flags copy", RegExp(literal, "i") === literal, RegExp(literal, "i").flags);
console.log("new copies", new RegExp(literal) === literal);

console.log("empty", RegExp().source, RegExp(undefined).source, RegExp("").source);
console.log("coerced", RegExp(123).source, RegExp(null).source);
console.log("flags string", RegExp("a", "gi").flags);

for (const flags of ["gg", "z"]) {
  try {
    RegExp("a", flags);
  } catch (error) {
    console.log("invalid flags", flags, error.name, error.message);
  }
}

const fromVariable = RegExp(String(7) + "+");
console.log("variable", fromVariable.test("77"), fromVariable.flags);

// A flags value that is undefined only at run time answers the pattern
// itself too, identity and lastIndex included (ECMA-262 22.2.3.1 step 2).
const target = /(a)/g;
target.lastIndex = 2;
const missingFlags = undefined;
console.log("late identity", RegExp(target, missingFlags) === target);
console.log("lastIndex", RegExp(target, missingFlags).lastIndex);
const givenFlags = "i";
const copied = RegExp(target, givenFlags);
console.log("late copy", copied === target, copied.flags, copied.lastIndex);

const maybeFlags = Math.random() >= 0 ? undefined : "g";
console.log("computed identity", RegExp(target, maybeFlags) === target);
const untypedFlags = missingFlags;
console.log("untyped identity", RegExp(target, untypedFlags) === target);

const produced = () => {
  console.log("pattern evaluated");
  return target;
};
console.log("order", RegExp(produced(), missingFlags) === target);

// Flags from an effectful expression that answers undefined, and a pattern
// the compiler cannot type: the run-time call form decides, so identity and
// lastIndex survive either way.
let asked = 0;
const askFlags = () => {
  asked += 1;
  return undefined;
};
console.log("effectful", RegExp(target, askFlags()) === target, asked, RegExp(target, askFlags()).lastIndex);

let untypedPattern = target;
console.log("untyped pattern", RegExp(untypedPattern, missingFlags) === target);
untypedPattern = "z+";
console.log("untyped string", RegExp(untypedPattern, missingFlags).source);
console.log("untyped with flags", RegExp(untypedPattern, "i").test("ZZ"));
