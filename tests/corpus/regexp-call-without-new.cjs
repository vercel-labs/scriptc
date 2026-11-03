// `RegExp(pattern, flags)` called without `new` constructs the same regex
// `new RegExp` does when the pattern and flags are strings or undefined.
var attributeName = RegExp("^[:A-Z_a-z][:A-Z_a-z\\-.0-9]*$");
console.log(attributeName.test("data-id"), attributeName.test("1bad"));

const global = RegExp("b+", "g");
console.log("abbcb".replace(global, "_"), global.flags, global.source, global.lastIndex);

const empty = RegExp();
const flagged = RegExp(undefined, "gi");
console.log(String(empty), String(flagged), flagged.global, flagged.ignoreCase);

// A flags value that may be undefined at run time.
var maybeFlags = process.argv.length > 99 ? "g" : undefined;
console.log(String(RegExp("a|b", maybeFlags)));

// Other primitives convert with ToString, as in Node.
console.log(String(RegExp(1 + 1)), String(RegExp(null)));

// A local binding named RegExp is not the builtin.
function build(RegExp) {
  return RegExp("x");
}
console.log(build((pattern) => "local " + pattern));

const fresh = [RegExp("x"), RegExp("x")];
console.log(fresh[0] === fresh[1], fresh[0] instanceof RegExp);

try {
  RegExp("(");
} catch (e) {
  console.log(e instanceof SyntaxError);
}
