// A bare RegExp(...) call with no regex literal in the program: the stored
// constructor value is what links the regex engine, and the call builds the
// pattern the direct `new RegExp(...)` builds.
const pattern = RegExp("^[:A-Z_a-z]+$");
console.log(pattern.test("valid"), pattern.test("not valid"), pattern.source);

const R = RegExp;
console.log(new R("b+", "i").test("BBB"), R("c").source, R.name, R.length);
