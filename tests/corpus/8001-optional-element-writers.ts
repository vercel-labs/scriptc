// Every way a value reaches a `(T | undefined)[]` of numbers, strings or
// booleans keeps its undefined: callbacks, generators, Array.of, rest
// packs, destructuring, class fields and copies into Sets and Maps.

const slots = new Map<string, number>([["a", 1]]);
const looked = ["x", "a", "y"].map((key) => slots.get(key));
console.log(looked[0] === undefined, looked, looked.length);
const fromMapped = Array.from(["a", "b"], (key) => slots.get(key));
console.log(fromMapped[1] === undefined, fromMapped);
const objects: { n?: number }[] = [{ n: 1 }, {}];
const fields = objects.map((o) => o.n);
function pick(o: { n?: number }): number | undefined {
  return o.n;
}
console.log(fields[1] === undefined, objects.map(pick)[1] === undefined, fields);
function wrap<T>(value: T): T[] {
  return [value];
}
console.log(wrap<number | undefined>(undefined)[0] === undefined);

function* maybe(): Generator<number | undefined> {
  yield undefined;
  yield 2;
}
const drained = [...maybe()];
console.log(drained[0] === undefined, drained, Array.from(maybe()));
const yielding = function* (): Generator<string | undefined> {
  yield "s";
  yield undefined;
};
console.log([...yielding()]);
console.log(Array.of<number | undefined>(undefined, 1), Array.of<boolean | undefined>(true));

function sum(...values: (number | undefined)[]): number {
  return values.reduce<number>((total, v) => total + (v ?? 0), 0);
}
const spread: (number | undefined)[] = [undefined, 4];
console.log(sum(1, undefined, 2), sum(...spread), sum(...spread, undefined, 1));

const [first, second = 7, third] = [3, undefined, 1] as (number | undefined)[];
console.log(first, second, third);
const strings: (string | undefined)[] = ["a", undefined, "a"];
const seen = new Set(strings);
console.log(seen.size, seen.has(undefined), [...seen]);
for (const [i, s] of strings.entries()) console.log(i, s);
for (const key in strings) console.log("key", key);

class Holder {
  values: (number | undefined)[] = [];
  add(value: number | undefined): void {
    this.values.push(value);
  }
  first(): number | undefined {
    return this.values[0];
  }
}
const holder = new Holder();
holder.add(undefined);
holder.add(2);
console.log(holder.first(), holder.values, holder.values.length);

const xs: (number | undefined)[] = [3, undefined, 1];
xs.forEach((x, i) => console.log(i, x, typeof x));
console.log(xs.findIndex((x) => x === undefined), xs.findLast((x) => x !== undefined));
console.log(xs.some((x) => x === undefined), xs.every((x) => x !== undefined));
console.log(xs.reduce<number>((acc, x) => acc + (x ?? 10), 0), xs.join("/"), xs.at(1), xs.at(-1));
console.log(xs.toSorted((a, b) => (a ?? 0) - (b ?? 0)), [...xs].sort());
xs[1] ??= 5;
console.log(xs);
const flags: (boolean | undefined)[] = [undefined, true];
console.log(flags.map((b) => !b), flags.indexOf(undefined), flags.includes(true), String(flags));
const nested: (number | undefined)[][] = [[undefined], [1]];
console.log(nested.flat(), nested[0]![0]);
const byKey = new Map<string, (number | undefined)[]>([["k", [undefined, 1]]]);
console.log(byKey.get("k")![0], byKey);

// Promise.all over `Promise<T | undefined>[]` settles on Node's turn, with
// its undefined values.
const lookup = async (key: string): Promise<number | undefined> => {
  if (key === "x") throw new Error("missing " + key);
  return slots.get(key);
};
const turns: string[] = [];
const pending: Promise<number | undefined>[] = [lookup("a"), lookup("b")];
void Promise.all(pending).then((vs) => turns.push("all " + vs.join(",") + " " + (vs[1] === undefined)));
const failing: Promise<number | undefined>[] = [lookup("a"), lookup("x")];
Promise.all(failing).then(
  () => turns.push("unexpected"),
  (error: unknown) => turns.push("rejected " + (error as Error).message),
);
void Promise.all([] as Promise<number | undefined>[]).then((vs) => turns.push("empty " + vs.length));
void Promise.resolve()
  .then(() => turns.push("t1"))
  .then(() => turns.push("t2"))
  .then(() => turns.push("t3"))
  .then(() => console.log(turns.join(" ")));

// Index reads through a union of arrays, and searches with a number
// needle, see the present undefined elements.
const pairs: ((null | undefined)[] | (number | undefined)[])[] = [[null, undefined], [undefined, 0]];
for (const pair of pairs) console.log(pair[0], pair[1], pair[2]);
const sparse: (number | undefined)[] = [1, , undefined, 1];
console.log(sparse.lastIndexOf(undefined), sparse.lastIndexOf(1, 2), sparse.indexOf(1, 1));
