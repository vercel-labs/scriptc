// The RegExp constructor reached through a stored value: calling it builds
// what `new RegExp(...)` builds, and with no flags answers the pattern
// itself when that pattern is a RegExp (ECMA-262 22.2.3.1 step 2).
const R = RegExp;

const called = R("^a+$", "i");
console.log(called.source, called.flags, called.test("AAA"), called instanceof RegExp);

const constructed = new R("b", "g");
console.log(constructed.source, constructed.flags, constructed.test("abc"), String(constructed));

const pattern = /x/;
console.log("identity", R(pattern) === pattern, R(pattern, undefined) === pattern);
console.log("flags copy", R(pattern, "g") === pattern, R(pattern, "g").flags);
console.log("new copies", new R(pattern) === pattern, new R(pattern).flags);

const empty = R();
console.log("empty", empty.source, empty.flags, new R().source);

const coerced = R(123, "g");
console.log("coerced", coerced.source, coerced.flags);

for (const flags of ["gg", "z"]) {
  try {
    R("a", flags);
  } catch (error) {
    console.log("invalid flags", flags, error.name, error.message);
  }
}

console.log("spellings", globalThis.RegExp === R, RegExp("^x$").test("x"));
