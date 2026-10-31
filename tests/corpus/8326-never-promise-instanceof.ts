// `instanceof Promise` on values that are never promises (records, arrays,
// dates, collections, regular expressions, byte arrays, null, and unions of
// them) is false, after the operand is evaluated.
let evaluated = 0;
function next(): { v: number } {
  evaluated++;
  return { v: evaluated };
}

const record = { v: 1 };
console.log("record", record instanceof Promise);
console.log("call", next() instanceof Promise, evaluated);
console.log("array", [1, 2] instanceof Promise);
console.log("date", new Date(0) instanceof Promise);
console.log("map", new Map<string, number>() instanceof Promise);
console.log("set", new Set<number>() instanceof Promise);
console.log("regex", /a/ instanceof Promise);
console.log("bytes", new Uint8Array(2) instanceof Promise);

function pick(i: number): { v: number } | number[] | null {
  return i === 0 ? { v: 0 } : i === 1 ? [i] : null;
}
for (let i = 0; i < 3; i++) console.log("union", i, pick(i) instanceof Promise);

const promised: unknown = Promise.resolve(1);
console.log("promise", promised instanceof Promise);
