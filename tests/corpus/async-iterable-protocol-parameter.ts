// A parameter (or local) spelled with the async-iteration protocol
// interfaces — `AsyncIterable<T>`, `AsyncIterableIterator<T>`,
// `AsyncIterator<T>` — holds whatever object implements the protocol, as
// pi's provider layer does (`for await (const event of stream)` inside a
// function that takes the stream as an argument). The value is
// checked-dynamic and the loop runs through the runtime's source-agnostic
// protocol: a compiled async generator steps natively, a class or object
// supplies its own Symbol.asyncIterator, and a synchronous iterable is
// consumed by awaiting its values one at a time.
class Counter implements AsyncIterable<number> {
  private readonly stop: number;
  constructor(stop: number) {
    this.stop = stop;
  }
  async *[Symbol.asyncIterator](): AsyncIterator<number> {
    for (let n = 1; n <= this.stop; n++) yield n;
  }
}

async function* doubling(limit: number): AsyncIterableIterator<number> {
  for (let n = 1; n <= limit; n++) yield n * 2;
}

async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const seen: T[] = [];
  for await (const item of source) seen.push(item);
  return seen;
}

async function sum(source: AsyncIterable<number>): Promise<number> {
  let total = 0;
  for await (const n of source) total += n;
  return total;
}

async function main(): Promise<void> {
  // A class instance, an async generator function, and a bare object
  // literal all satisfy the same parameter.
  console.log("counter", (await collect(new Counter(4))).join(","));
  console.log("doubling", (await collect(doubling(3))).join(","));

  let step = 0;
  const objectSource: AsyncIterable<string> = {
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<string>> {
          step++;
          return step <= 2
            ? Promise.resolve({ value: `v${step}`, done: false })
            : Promise.resolve({ value: undefined as any, done: true });
        },
      };
    },
  };
  console.log("object", (await collect(objectSource)).join(","));
  console.log("sum", await sum(new Counter(5)), await sum(doubling(4)));

  // The protocol iterator also steps by hand when the value is spelled
  // as the iterator interface.
  const iterator: AsyncIterableIterator<number> = doubling(2);
  const first = await iterator.next();
  const second = await iterator.next();
  console.log("manual", first.done, first.value, second.value);

  // A synchronous iterable reaches the same loop: its values are awaited.
  const rejects = [1, 2, 3];
  let total = 0;
  for await (const n of rejects) total += n;
  console.log("sync", total);

  // break leaves the source closed, as it does for a native generator.
  const closed: string[] = [];
  const closing: AsyncIterable<number> = {
    [Symbol.asyncIterator]() {
      let n = 0;
      return {
        next: () => Promise.resolve(n < 10 ? { value: ++n, done: false } : { value: undefined as any, done: true }),
        return: () => {
          closed.push(`closed at ${n}`);
          return Promise.resolve({ value: undefined as any, done: true });
        },
      };
    },
  };
  for await (const n of closing) {
    if (n === 2) break;
  }
  console.log("break", closed.length === 1, closed[0] === "closed at 2");
}

await main();
