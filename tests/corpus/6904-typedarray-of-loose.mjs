// TypedArray.of over values that are not numbers: each argument goes through
// ToNumber (valueOf / toString) in argument order, after all arguments are
// evaluated, and a Symbol throws a TypeError.
console.log(Array.from(Float64Array.of("12", "", " 0x10 ", "abc", true, false, null, undefined)).join(","));
console.log(Array.from(Float64Array.of([7], [], {}, [1, 2])).join(","));
const strings = ["12", " 0x10 ", "abc"];
console.log(Array.from(Float64Array.of(...strings, 1)).join(","));
console.log(Array.from(Uint8Array.of("300", true, [2])).join(","));

let calls = "";
const a = { valueOf: () => ((calls += "a"), 9) };
const b = { toString: () => ((calls += "b"), "8") };
console.log(Array.from(Uint8Array.of(a, b, 7)).join(","), calls);

let order = "";
const v = (n) => ({ valueOf: () => ((order += "v" + n), n) });
const e = (n) => ((order += "e" + n), v(n));
console.log(Array.from(Int16Array.of(e(1), e(2))).join(","), order);

try {
  Uint8Array.of(1, Symbol("s"));
} catch (err) {
  console.log(err instanceof TypeError);
}

const dyn = JSON.parse("[1, 2, 300]");
console.log(Array.from(Uint8Array.of(...dyn)).join(","));
console.log(Array.from(Uint8Array.of(...dyn, "7", ...[8, 9], ..."12")).join(","));

for (const text of ["5", "null", "{}"]) {
  const value = JSON.parse(text);
  try {
    Uint8Array.of(...value);
  } catch (err) {
    console.log(err instanceof TypeError, err.message);
  }
}
