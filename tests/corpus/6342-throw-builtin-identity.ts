// Thrown Maps, Sets, typed arrays, Buffers and functions reach the catch
// binding as the same objects: inspection, String(), typeof, instanceof
// and typed views see the thrown value.
function report(label: string, f: () => void): void {
  try {
    f();
  } catch (e) {
    console.log(label, e, typeof e, e instanceof Map, e instanceof Set, ArrayBuffer.isView(e));
  }
}

const shared = new Map<string, number>([["a", 1]]);
try {
  throw shared;
} catch (e) {
  console.log(e === shared, String(e));
  (e as Map<string, number>).set("b", 2);
}
console.log(shared);

report("set", () => {
  throw new Set<number>([1, 2]);
});
report("u8", () => {
  throw new Uint8Array([1, 2, 3]);
});
report("f64", () => {
  throw new Float64Array([1.5, -0]);
});
report("buffer", () => {
  throw Buffer.from("hi");
});
report("function", () => {
  throw function named(): number {
    return 1;
  };
});
const twice = (x: number): number => x * 2;
try {
  throw twice;
} catch (e) {
  console.log(e, typeof e, (e as (x: number) => number)(21));
}

function pick(k: number): Map<string, number> | number[] {
  return k ? new Map([["k", k]]) : [k];
}
for (const k of [0, 3]) report(`union ${k}`, () => {
  throw pick(k);
});

try {
  throw new Set(["x"]);
} catch (e) {
  console.log([...(e as Set<string>)].join(","), (e as Set<string>).has("x"));
}
