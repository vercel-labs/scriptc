// A record whose method takes a generator and returns the record's own type,
// checked out of an `unknown` slot. The generator parameter is accepted by a
// later rule after an earlier one declines it, and the record must stay
// marked as being checked across that.
interface Chain {
  feed: (source: Generator<number>) => Chain;
  total: number;
}

function* numbers(from: number, count: number): Generator<number> {
  for (let i = 0; i < count; i++) yield from + i;
}

function make(total: number): Chain {
  return {
    total,
    feed(source) {
      let sum = total;
      for (const n of source) sum += n;
      return make(sum);
    },
  };
}

function hold(value: unknown): unknown {
  return value;
}

const chain = hold(make(0)) as Chain;
const fed = chain.feed(numbers(1, 3)).feed(numbers(10, 2));
console.log(chain.total, fed.total);
