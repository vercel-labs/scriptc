// Math.max/Math.min/Math.hypot spread arguments that are not arrays: a
// Map's or Set's iterator and a generator contribute every value their
// iteration yields, and each converts through ToNumber as Node's fold does.
const groups = new Map<number, string>([
  [0, "a"],
  [1, "b"],
]);
console.log("max", Math.max(-1, ...groups.keys()));
console.log("min", Math.min(10, ...groups.keys()));
console.log("both", Math.max(...groups.keys(), 7));
const set = new Set<number>([3, 5]);
console.log("set max", Math.max(-1, ...set.values()));
console.log("set min", Math.min(100, ...set.values()));
console.log("hypot", Math.hypot(3, ...groups.keys()));
console.log("hypot keys", Math.hypot(...new Set<number>([4, 12]).values(), 3));

const log: string[] = [];
function note(label: string, value: number): number {
  log.push(label);
  return value;
}
function* numbers(): Generator<number> {
  log.push("spread");
  yield 4;
  yield 9;
}
console.log("gen max", Math.max(note("first", -1), ...numbers(), note("last", 2)));
console.log("order", log.join(","));

const empty = new Map<number, string>();
console.log("empty max", Math.max(-1, ...empty.keys()));
console.log("plain max", Math.max(-1, ...[0, 1]));
const values: number[] = [8, 2];
console.log("array spread", Math.max(-1, ...values, 5));
