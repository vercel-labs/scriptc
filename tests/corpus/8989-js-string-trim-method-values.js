// String.prototype's trim family read as values: the Annex B aliases are the
// standard functions themselves (trimLeft IS trimStart, trimRight IS trimEnd),
// every spelling shares one object with the method value read off a string,
// and Function.prototype's call/apply run the method generically —
// RequireObjectCoercible then ToString — so primitives coerce, an object's
// toString is observed, and null, undefined and Symbols are the TypeError
// Node throws. A direct call keeps its own intrinsic lowering.

function report(label, fn) {
  try {
    console.log(label, "value=" + String(fn()));
  } catch (e) {
    console.log(label, e.name, e.constructor === TypeError);
  }
}

const trim = String.prototype.trim;
const trimStart = String.prototype.trimStart;
const trimEnd = String.prototype.trimEnd;

console.log("types", typeof trim, typeof trimStart, typeof trimEnd);
console.log("names", trim.name, trimStart.name, trimEnd.name);
console.log("lengths", trim.length, trimStart.length, trimEnd.length);
console.log("aliases", String.prototype.trimLeft === trimStart, String.prototype.trimRight === trimEnd);
console.log("stable", trim === String.prototype.trim, trimStart === String.prototype.trimStart);
console.log(
  "receiver-values",
  "  x  ".trim === trim,
  "  x  ".trimStart === trimStart,
  "  x  ".trimEnd === trimEnd,
);
console.log("alias-values", "  x  ".trimLeft === trimStart, "  x  ".trimRight === trimEnd);

report("call-string", () => trim.call("  trim  "));
report("call-number", () => trim.call(42));
report("call-boolean", () => trim.call(true));
report("call-array", () => trim.call([1, 2]));
report("call-object", () => trim.call({ toString: () => " obj　" }));
report("apply-start", () => trimStart.apply("\t\n x \r\n", []));
report("call-undefined", () => trim.call(undefined));
report("call-null", () => trim.call(null));
report("call-symbol", () => trim.call(Symbol("s")));
report("call-no-this", () => trim());
report("start-string", () => trimStart.call("  x  "));
report("end-string", () => trimEnd.call("  x  "));
report("left-string", () => String.prototype.trimLeft.call("  x  "));
report("right-string", () => String.prototype.trimRight.call("  x  "));
report("unicode", () => trim.call("  y ﻿"));

console.log("direct", JSON.stringify("  direct  ".trim()), JSON.stringify("  direct  ".trimStart()));
