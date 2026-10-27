// `RegExp(pattern, flags)` called without `new` constructs the same regex
// `new RegExp` does when the pattern is a string or undefined.
var attributeName = RegExp("^[:A-Z_a-z][:A-Z_a-z\\-.0-9]*$"),
  cache = {};
console.log(attributeName.test("data-id"), attributeName.test("1bad"), typeof cache);

const global = RegExp("b+", "g");
console.log("abbcb".replace(global, "_"), global.flags, global.source, global.lastIndex);

const empty = RegExp();
const flagged = RegExp(undefined, "gi");
console.log(String(empty), String(flagged), flagged.global, flagged.ignoreCase);

const fresh = [RegExp("x"), RegExp("x")];
console.log(fresh[0] === fresh[1], fresh[0] instanceof RegExp);

try {
  RegExp("(");
} catch (e) {
  console.log(e instanceof SyntaxError);
}
