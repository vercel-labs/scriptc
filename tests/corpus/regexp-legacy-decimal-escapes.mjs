// A decimal escape that names no capture group is a legacy octal or
// identity escape in a regex literal without the u or v flag, and its
// source can be reused in a pattern that has the group.
const fragment = /\1/;
console.log(fragment.source, fragment.test("\x01"), fragment.test("1"), fragment.test("a"));

const composed = new RegExp("(a)" + fragment.source);
console.log(composed.source, composed.test("aa"), composed.test("a\x01"), composed.test("ab"));

// \2 with one group is the octal escape \x02; \8 and \9 match the digit.
console.log(/(a)\2/.test("a\x02"), /(a)\2/.test("aa"), /\8/.test("8"), /\9x/.exec("9x")?.[0]);
// \12 with one group is the octal escape \n; with twelve groups it would
// be a reference.
console.log(/(a)\12/.test("a\n"), /\101/.test("A"), /[\1]/.test("\x01"));

// A real reference still matches its group, before and after it.
console.log(/(a)\1/.test("aa"), /(a)\1/.test("a\x01"), /\1(a)/.exec("a")?.[0]);
console.log("ab-ab".replace(/(ab)-\1/, "[$1]"), "\x01-\x01".replace(/\1/g, "x"));
console.log(/(?<word>o)\k<word>/.test("oo"), "x\x01y".split(/\1/).join("|"));

// The u and v flags make the escape a SyntaxError.
for (const flags of ["u", "v"]) {
  try {
    new RegExp("\\1", flags);
    console.log(flags, "accepted");
  } catch (err) {
    console.log(flags, err.name, err instanceof SyntaxError);
  }
}
