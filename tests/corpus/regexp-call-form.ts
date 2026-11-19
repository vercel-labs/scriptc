// `RegExp(pattern, flags?)` without `new` constructs the same expression the
// `new` form does. The one difference: an expression argument with no flags
// is returned unchanged, and `String(RegExp(...))` spells the source and
// flags exactly as Node does.
const hex = /[0-9a-f]+/g;
const same = RegExp(hex);
console.log(same === hex, String(same));
const built = RegExp("^ab+c$", "i");
console.log(String(built), built.test("ABBC"), built.flags);
const fromString = RegExp("[0-9]{4}");
console.log(fromString.source, fromString.flags, fromString.test("2026"));
console.log(String(RegExp("a+")));
try {
  RegExp("(", "");
} catch (err) {
  console.log((err as Error).name, (err as Error).message.length > 0);
}
