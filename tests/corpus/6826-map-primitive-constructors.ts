// The String, Number and Boolean constructors passed as callbacks: over
// unknown arrays they convert any element, over typed arrays String converts
// each element as String(value) does, and the boxed values keep identity.
const values: unknown[] = [1, "b", true, null, undefined, Symbol("s"), [1, 2], { a: 1 }, 2n];
console.log(values.map(String).join("|"));
console.log(values.slice(0, 5).map(Number), values.map(Boolean));

function joinAll(...parts: unknown[]): string {
  return parts.map(String).join(",");
}
console.log(joinAll(1, "a", false, null));

const numbers = [1, 2.5, -0, NaN, Infinity];
console.log(numbers.map(String));
const mixed: (number | string | boolean)[] = [1, "x", false];
console.log(mixed.map(String));
const symbols: (symbol | string)[] = [Symbol("q"), "r", Symbol()];
console.log(symbols.map(String));
console.log([10n, -3n].map(String));
console.log(["1", " 2 ", "x", ""].map(Number), ["", "0", "a"].map(Boolean));

const boxed: unknown = String;
const table: { [name: string]: unknown } = { s: String, n: Number, b: Boolean };
console.log(boxed === String, table.n === Number, table.b === String, typeof boxed);
console.log(values.filter(Boolean).length, values.some(Boolean), numbers.every(Boolean));
