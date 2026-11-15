// Async-iteration protocol types inside generic code, where the element type
// is the type parameter or only contains it (`T | null`, `T[]`): a class
// implementing the protocol and a compiled generator take the same generic
// functions, a generic function hands its source back through its return
// slot, and a generic class keeps one in a field.
class Feed implements AsyncIterable<number> {
  async *[Symbol.asyncIterator](): AsyncGenerator<number> {
    yield 1;
    yield 2;
  }
}

class Gaps implements AsyncIterable<number | null> {
  async *[Symbol.asyncIterator](): AsyncGenerator<number | null> {
    yield 1;
    yield null;
    yield 3;
  }
}

class Rows implements AsyncIterable<string[]> {
  async *[Symbol.asyncIterator](): AsyncGenerator<string[]> {
    yield ["a", "b"];
    yield ["c"];
  }
}

async function* numbers(): AsyncGenerator<number> {
  yield 10;
  yield 20;
}

async function* words(): AsyncGenerator<string> {
  yield "p";
  yield "q";
}

async function* gaps(): AsyncGenerator<number | null> {
  yield null;
  yield 7;
}

async function* rows(): AsyncGenerator<string[]> {
  yield ["x"];
  yield ["y", "z"];
}

async function drain<T>(source: AsyncIterable<T | null>): Promise<number> {
  let present = 0;
  for await (const item of source) if (item !== null) present++;
  return present;
}

async function firstOfEach<T>(source: AsyncIterable<T[]>): Promise<T[]> {
  const firsts: T[] = [];
  for await (const row of source) firsts.push(row[0]!);
  return firsts;
}

function forward<T>(source: AsyncIterable<T>): AsyncIterable<T> {
  return source;
}

function twice<T>(source: AsyncIterable<T>): AsyncIterable<T> {
  return forward(source);
}

async function count(source: AsyncIterable<unknown>): Promise<number> {
  let total = 0;
  for await (const _ of source) total++;
  return total;
}

function counted<T>(source: AsyncIterable<T>): Promise<number> {
  return count(source);
}

class Holder<T> {
  readonly source: AsyncIterable<T>;
  constructor(source: AsyncIterable<T>) {
    this.source = source;
  }
  async list(): Promise<T[]> {
    const items: T[] = [];
    for await (const item of this.source) items.push(item);
    return items;
  }
}

async function main(): Promise<void> {
  console.log("drain", await drain(new Gaps()), await drain(gaps()));
  console.log("first", (await firstOfEach(new Rows())).join(","), (await firstOfEach(rows())).join(","));

  for await (const item of forward(new Feed())) console.log("forward class", item);
  for await (const item of forward(numbers())) console.log("forward generator", item);
  for await (const item of twice(new Feed())) console.log("twice class", item);
  for await (const item of twice(words())) console.log("twice generator", item);

  console.log("counted", await counted(new Feed()), await counted(numbers()), await counted(words()));

  console.log("holder", (await new Holder(new Feed()).list()).join(","));
  console.log("holder", (await new Holder(numbers()).list()).join(","));
  console.log("holder", (await new Holder(words()).list()).join(","));
}

main();
