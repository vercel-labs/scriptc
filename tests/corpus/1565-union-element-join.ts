// Array#join over UNION elements: undefined/null arms print EMPTY (JS's
// join silences only the nullish elements); every other arm converts with
// String()'s exact formatting. The `.filter(Boolean)` idiom keeps its
// checker type `(string | undefined)[]`, so the certs error-collection
// shape joins without a cast.
function e1(x: boolean): string | undefined {
  return x ? "linux failed" : undefined;
}
const errors = [e1(true), e1(false)].filter(Boolean);
console.log(errors.join("; ") || "fallback");
const none = [e1(false), e1(false)].filter(Boolean);
console.log(none.join("; ") || "fallback");

// Unfiltered nullish elements: empty pieces, separators kept — JS-exact.
const raw: (string | undefined)[] = ["a", undefined, "b", undefined];
console.log(raw.join(","));
console.log(raw.join(""));
console.log(raw.join(" - "));

// Number/bool arms format like String(x): NaN spelled out, -0 collapses.
const mixed: (number | string | null)[] = [1, null, "x", -0, 0 / 0, 2.5];
console.log(mixed.join("|"));
const bools: (boolean | undefined)[] = [true, undefined, false];
console.log(bools.join("-"));

// Empty and single-element arrays.
const empty: (string | null)[] = [];
console.log(`[${empty.join(",")}]`);
const one: (string | null)[] = [null];
console.log(`[${one.join(",")}]`);
console.log("done");

const longText = "雪🙂\0quoted\"\\".repeat(100);
const spans: (string | number | null | undefined)[] = [longText, 100000, null, undefined, longText];
console.log(spans.join("\0separator雪"));
const checked: unknown = JSON.parse('["雪🙂",123456789,[true,null,"quoted\\\""]]');
console.log(String(checked));
const boundaries: (number | boolean | null)[] = [Infinity, -Infinity, NaN, -0, 9007199254740991, true, false, null];
console.log(boundaries.join(","));
