// `yield*` between generic generator methods, over arrays, and from a generic generator
// function; the delegate's return value is the `yield*` expression's value.
function* range<T>(xs: T[]): Generator<T, number> {
  for (const x of xs) yield x;
  return xs.length;
}
class Tree {
  label = "t";
  *leaves<T>(xs: T[]): Generator<T, number> {
    const n = yield* range(xs);
    yield* xs;
    return n * 2;
  }
  *twice<T>(xs: T[]): Generator<T, string> {
    const a = yield* this.leaves(xs);
    const b = yield* this.leaves(xs);
    return `${this.label} ${a + b}`;
  }
  async *slow<T>(xs: T[]): AsyncGenerator<T, number> {
    for (const x of xs) {
      await Promise.resolve();
      yield x;
    }
    return xs.length;
  }
  async *both<T>(xs: T[]): AsyncGenerator<T, string> {
    const n = yield* this.slow(xs);
    yield* xs;
    return `async ${n}`;
  }
}
const t = new Tree();
const it = t.twice([1, 2]);
const out: number[] = [];
let step = it.next();
while (!step.done) {
  out.push(step.value);
  step = it.next();
}
console.log(out.join(","), step.value);
console.log([...t.leaves(["a", "b"])].join(""));
const ait = t.both(["x", "y"]);
const aout: string[] = [];
let astep = await ait.next();
while (!astep.done) {
  aout.push(astep.value);
  astep = await ait.next();
}
console.log(aout.join(","), astep.value);
