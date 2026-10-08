// Iterator-typed slots hold generators and built-in collection iterators.
// A class implementing the iterator protocol stays a pointed fence there,
// and Iterable<T> annotations have no lowering yet.

class Countdown implements Iterator<number> {
  n = 2;
  next(): IteratorResult<number> {
    return this.n > 0 ? { value: this.n--, done: false } : { value: undefined, done: true };
  }
}
function firstOf(it: Iterator<number>): void {
  console.log(it.next().value);
}
firstOf(new Countdown());

function total(values: Iterable<number>): number {
  let sum = 0;
  for (const v of values) sum += v;
  return sum;
}
console.log(total([1, 2]));
