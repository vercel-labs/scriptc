// An Iterable<T> value holds an array, Set, Map, string or iterator. A
// class instance with its own [Symbol.iterator] and a typed array have no
// representation there, so the conversion site reports them by name.
class Countdown implements Iterable<number> {
  *[Symbol.iterator](): Iterator<number> {
    yield 2;
    yield 1;
  }
}
function sum(xs: Iterable<number>): number {
  let s = 0;
  for (const x of xs) s += x;
  return s;
}
console.log(sum(new Countdown()));
console.log(sum(new Uint8Array([1, 2])));
export const marker: number = 1;
