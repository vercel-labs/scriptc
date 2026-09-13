const xs: number[] = [];
xs[3] = 7;
xs[4_000_000_000] = 11;
xs[-1] = 21;
xs[0.5] = 22;

console.log("growth", xs.length, xs[3], xs[4_000_000_000]);
console.log("properties", xs[-1], xs[0.5]);

const slice = xs.slice(4_000_000_000, 4_000_000_001);
console.log("slice", slice.length, slice[0]);

const small: number[] = [];
small[3] = 7;
let forEachCalls = 0;
small.forEach(() => { forEachCalls++; });
const mapped = small.map((value) => value + 1);
console.log("hof", forEachCalls, mapped.length, mapped[3]);
const merged = ([] as number[]).concat(small);
console.log("concat", merged.length, merged[3]);
const reversed = small.toReversed();
console.log("reversed", reversed.length, reversed[0]);

xs.length = 4;
console.log("truncate", xs.length, xs[3], xs[-1]);
