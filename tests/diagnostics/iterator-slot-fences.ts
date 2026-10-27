// Iterator-typed slots hold generators and built-in collection iterators.
// A class implementing the iterator protocol stays a pointed fence there
// (Iterable<T> values: corpus 7380-7383).

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
