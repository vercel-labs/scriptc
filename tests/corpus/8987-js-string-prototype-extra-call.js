// `String.prototype.<method>.call(receiver, …)` for the methods the typed
// string lowering covers beyond the core set: the Annex B CreateHTML
// methods, substr, concat and the locale-cased pair. `Function.call`
// evaluates the receiver and every argument before the method coerces its
// receiver, the tag and its attribute escape as CreateHTML specifies, and a
// nullish receiver throws the method's TypeError.

const s = "Ab";

console.log(String.prototype.big.call(s), String.prototype.bold.call(s));
console.log(String.prototype.blink.call("x"), String.prototype.fixed.call("x"));
console.log(String.prototype.italics.call("x"), String.prototype.small.call("x"));
console.log(String.prototype.strike.call("x"), String.prototype.sub.call("x"));
console.log(String.prototype.sup.call("x"));
// The attribute value is ToString'd, then its double quotes are escaped.
console.log(String.prototype.anchor.call(s, 'x"<y'));
console.log(String.prototype.link.call(s, "u"));
console.log(String.prototype.fontcolor.call(0x2a, "red"));
console.log(String.prototype.fontsize.call(0x2a, 7));
// An omitted attribute is the string "undefined"; a null one too.
console.log(String.prototype.anchor.call("x"), String.prototype.anchor.call("x", null));
// CreateHTML ignores arguments past the attribute, but still evaluates them.
const seen = [];
console.log(String.prototype.big.call("x", (seen.push("a"), 1), (seen.push("b"), 2)), seen.join(","));

// Scalar receivers convert through ToString.
console.log(String.prototype.sub.call(42), String.prototype.sub.call(true), String.prototype.sub.call(10n));
console.log(String.prototype.substr.call("abcdef", 1, 3), String.prototype.substr.call("abcdef", -2));
console.log(String.prototype.substr.call("abcdef"), String.prototype.substr.call("abcdef", 2, undefined));
console.log(String.prototype.concat.call("a", "b", 1, true, null, undefined));
console.log(String.prototype.toLocaleLowerCase.call("AB"), String.prototype.toLocaleUpperCase.call("ab"));

// A receiver that only the dynamic tier knows.
const dyn = JSON.parse('"Dy"');
console.log(String.prototype.big.call(dyn), String.prototype.big.call(dyn.length));

for (const value of [undefined, null]) {
  try {
    String.prototype.link.call(value, "x");
  } catch (e) {
    console.log(e.name, e.message);
  }
}
