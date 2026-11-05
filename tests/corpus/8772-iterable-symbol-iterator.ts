// `value[Symbol.iterator]()` on an Iterable<T>: GetIterator over the
// current arm answers the canonical iterator, so `.next()` reads like any
// other iterator (the shape pi's word navigation uses).
function run<T>(source: Iterable<T>): T[] {
  const iterator = source[Symbol.iterator]();
  const out: T[] = [];
  let next = iterator.next();
  while (!next.done) {
    out.push(next.value);
    next = iterator.next();
  }
  return out;
}

console.log(run([1, 2, 3]).join(","));
console.log(run(new Set([4, 5, 5])).join(","));

function* numbers(): Generator<number> {
  yield 6;
  yield 7;
}
console.log(run(numbers()).join(","));

function words(source: Iterable<string>): string[] {
  const iterator = source[Symbol.iterator]();
  const out: string[] = [];
  let next = iterator.next();
  while (!next.done) {
    out.push(next.value);
    next = iterator.next();
  }
  return out;
}
console.log(words("a\u{1F600}b").join("|"));
console.log(words(["x", "y"]).join("|"));

// The conditional arm shape: either the caller's iterable function or the
// local array stands in the same slot.
interface Options {
  segment?: (text: string) => Iterable<number>;
}
function forward(text: string, options?: Options): number {
  const segment = options?.segment;
  const parts = segment ? segment(text) : [text.length];
  const iterator = parts[Symbol.iterator]();
  let total = 0;
  let next = iterator.next();
  while (!next.done) {
    total += next.value;
    next = iterator.next();
  }
  return total;
}
console.log(forward("abcd"));
console.log(forward("abcd", { segment: () => [1, 2, 3] }));
