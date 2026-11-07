// RegExp(pattern, flags) through a stored constructor value: the call form
// builds the pattern the `new` form builds, a native pattern answers ITSELF
// when flags is absent (RegExp ( pattern, flags ) step 2b), and the `new`
// form always builds a fresh pattern. Invalid patterns and flag sets throw
// Node's SyntaxError.
const Ctor = RegExp;
const built = Ctor("a+b", "gi");
console.log(built.source, built.flags, built instanceof RegExp, String(built));
console.log(typeof Ctor, Ctor.name, Ctor.length);

// The identity short circuit, and its two exceptions: an explicit flag list
// and the `new` form both build.
const literal = /x/i;
console.log(Ctor(literal) === literal, Ctor(literal, undefined) === literal);
console.log(Ctor(literal, "g") === literal, Ctor(literal, "g").flags);
const copy = new Ctor(literal);
console.log(copy === literal, copy.source, copy.flags);

// Missing, undefined and non-string patterns go through ToString, and an
// empty or missing pattern stores the spec's "(?:)" source.
console.log(Ctor().source, Ctor(undefined).source, Ctor(null).source);
console.log(Ctor(12).source, Ctor("").flags.length);

// A stored value's own members and its match results: exec answers null
// without a match, and its index and captures as Node's.
console.log(typeof Ctor("0").exec("1"), Ctor("l", "g").exec("hello").index);
const found = Ctor("(a)(b)").exec("ab");
console.log(found === null, found ? found[0] : "", found ? found[2] : "");
console.log(Ctor("^h", "i").test("Hello"), Ctor("^h", "i").test("hello"));

// Errors: the pattern's own SyntaxError and the constructor's flag message.
for (const [pattern, flags] of [["(", "u"], ["a", "gg"], ["a", "z"]]) {
  try {
    Ctor(pattern, flags);
    console.log("no throw");
  } catch (error) {
    console.log(error.name, error instanceof SyntaxError, error.constructor === SyntaxError);
  }
}
