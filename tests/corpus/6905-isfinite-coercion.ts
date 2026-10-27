// Global isFinite applies ToNumber to its argument before the test, like
// global isNaN: strings parse as numeric literals, booleans and null are 0
// and 1, undefined is NaN, and objects convert through valueOf/toString.
// Number.isFinite stays strict and answers false for anything not a number.
const values: unknown[] = ["12", "", " 0x10 ", "abc", "1e400", true, false, null, undefined, {}, [], [7], [1, 2]];
for (const value of values) {
  console.log(JSON.stringify(value) ?? "undefined", isFinite(value as any), Number.isFinite(value));
}

const u: unknown = 12;
console.log(isFinite(u as any));

let calls = "";
const boxed: unknown = { valueOf: () => ((calls += "v"), 5) };
console.log(isFinite(boxed as any), calls);
const text: unknown = { toString: () => "Infinity" };
console.log(isFinite(text as any));

class Cache {
  #maxAge: unknown;
  constructor(maxAge?: number) {
    this.#maxAge = maxAge;
  }
  expires(): boolean {
    return isFinite(this.#maxAge as any);
  }
}
console.log(new Cache(1000).expires(), new Cache().expires());

const throwing: unknown[] = [Symbol("s"), 10n];
for (const value of throwing) {
  try {
    isFinite(value as any);
  } catch (e) {
    console.log(e instanceof TypeError);
  }
}
console.log(isFinite(1 / 0), isFinite(-1 / 0), isFinite(0 / 0), isFinite(-0));
