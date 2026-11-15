// A value in an `AsyncIterable<T>` slot that a type predicate narrows to
// `AsyncIterable<T> & { summary(): Promise<number> }`: the member the
// intersection adds is called on the object that reached the slot. The slot
// holds any implementor of the protocol, so the probe and the call ask the
// value itself.
type Tick = { type: "tick"; n: number } | { type: "done"; total: number };

class Feed implements AsyncIterable<Tick> {
  private items: Tick[] = [];
  private scale: number;
  constructor(scale: number) {
    this.scale = scale;
  }
  push(item: Tick): void {
    this.items.push(item);
  }
  async *[Symbol.asyncIterator](): AsyncGenerator<Tick> {
    for (const item of this.items) yield item;
  }
  summary(): Promise<number> {
    return Promise.resolve(this.items.length * this.scale);
  }
}

// A class that implements the protocol without the extra member.
class Bare implements AsyncIterable<Tick> {
  async *[Symbol.asyncIterator](): AsyncGenerator<Tick> {
    yield { type: "tick", n: 1 };
    yield { type: "done", total: 11 };
  }
}

function hasSummary(
  source: AsyncIterable<Tick>,
): source is AsyncIterable<Tick> & { summary(): Promise<number> } {
  return typeof (source as { summary?: unknown }).summary === "function";
}

async function forward(source: AsyncIterable<Tick>): Promise<number | undefined> {
  let result: number | undefined;
  for await (const item of source) {
    if (item.type === "done") result = item.total;
  }
  if (hasSummary(source)) result = await source.summary();
  return result;
}

// The narrowed value passed on and stored.
async function twice(source: AsyncIterable<Tick>): Promise<string> {
  if (!hasSummary(source)) return "no summary";
  const narrowed = source;
  const first = await narrowed.summary();
  const second = await source.summary();
  return `${first}+${second}`;
}

async function main(): Promise<void> {
  const feed = new Feed(100);
  feed.push({ type: "tick", n: 1 });
  feed.push({ type: "done", total: 3 });
  console.log(await forward(feed));
  console.log(await forward(new Bare()));
  console.log(await twice(feed), await twice(new Bare()));

  // An object literal implementing both.
  const literal = {
    async *[Symbol.asyncIterator](): AsyncGenerator<Tick> {
      yield { type: "done", total: 5 };
    },
    summary(): Promise<number> {
      return Promise.resolve(42);
    },
  };
  console.log(await forward(literal), await twice(literal));

  // A summary that rejects reaches the caller's catch.
  const failing = {
    async *[Symbol.asyncIterator](): AsyncGenerator<Tick> {
      yield { type: "tick", n: 1 };
    },
    summary(): Promise<number> {
      return Promise.reject(new Error("no total"));
    },
  };
  try {
    await forward(failing);
  } catch (error) {
    console.log(error instanceof Error ? error.message : "other");
  }
}
void main();
