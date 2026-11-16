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
