// `new RegExp(pattern, flags)` reaches ToString on both arguments, so a
// static value the compiler cannot spell as a string (a number, a boolean,
// null, an object) is Node's own coercion: a flags argument that spells an
// invalid flag list throws the catchable SyntaxError, and a valid one
// constructs the regex.
function report(label, build) {
  try {
    const value = build();
    console.log(label, value.source, value.flags);
  } catch (error) {
    console.log(label, "throws", error.name, error instanceof SyntaxError);
  }
}
report("null flags", () => new RegExp(".", null));
report("number flags", () => new RegExp("^", 1.0));
report("boolean flags", () => new RegExp("|", true));
report("object flags", () => new RegExp("$sup", { toString: function () { return ""; } }));
report("plain object flags", () => new RegExp("a", {}));
report("number pattern", () => new RegExp(12));
report("boolean pattern", () => new RegExp(true));
report("null pattern", () => new RegExp(null));
report("undefined flags", () => new RegExp("a", undefined));
report("string pattern", () => new RegExp("a"));
