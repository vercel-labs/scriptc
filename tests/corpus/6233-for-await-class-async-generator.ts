// `for await` over a class instance whose [Symbol.asyncIterator] is an
// async generator method — pi-ai's EventStream, which is how every
// provider stream is consumed: a generic push/end queue, a subclass, the
// protocol-interface return annotations, producers that run between
// iterations, early exit (the generator's finally runs), and errors.
class FifoQueue<T> {
  private incoming: T[] = [];
  private outgoing: T[] = [];

  get length(): number {
    return this.incoming.length + this.outgoing.length;
  }

  enqueue(value: T): void {
    this.incoming.push(value);
  }

  dequeue(): T | undefined {
    if (this.outgoing.length === 0) {
      while (this.incoming.length > 0) {
        this.outgoing.push(this.incoming.pop()!);
      }
    }
    return this.outgoing.pop();
  }
}

class EventStream<T, R = T> implements AsyncIterable<T> {
  private queue = new FifoQueue<T>();
  private waiting = new FifoQueue<(value: IteratorResult<T>) => void>();
  protected done = false;
  private finalResultPromise: Promise<R>;
  private resolveFinalResult!: (result: R) => void;
  private isComplete: (event: T) => boolean;
  private extractResult: (event: T) => R;

  constructor(isComplete: (event: T) => boolean, extractResult: (event: T) => R) {
    this.isComplete = isComplete;
    this.extractResult = extractResult;
    this.finalResultPromise = new Promise((resolve) => {
      this.resolveFinalResult = resolve;
    });
  }

  push(event: T): void {
    if (this.done) return;
    if (this.isComplete(event)) {
      this.done = true;
      this.resolveFinalResult(this.extractResult(event));
    }
    const waiter = this.waiting.dequeue();
    if (waiter) {
      waiter({ value: event, done: false });
    } else {
      this.queue.enqueue(event);
    }
  }

  end(result?: R): void {
    this.done = true;
    if (result !== undefined) {
      this.resolveFinalResult(result);
    }
    while (this.waiting.length > 0) {
      const waiter = this.waiting.dequeue()!;
      waiter({ value: undefined as any, done: true });
    }
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    while (true) {
      if (this.queue.length > 0) {
        yield this.queue.dequeue()!;
      } else if (this.done) {
        return;
      } else {
        const result = await new Promise<IteratorResult<T>>((resolve) => this.waiting.enqueue(resolve));
        if (result.done) return;
        yield result.value;
      }
    }
  }

  result(): Promise<R> {
    return this.finalResultPromise;
  }
}

type Event = { type: "text"; delta: string } | { type: "done"; text: string };

class TextStream extends EventStream<Event, string> {
  constructor() {
    super(
      (event) => event.type === "done",
      (event) => (event.type === "done" ? event.text : ""),
    );
  }
}

function produce(stream: TextStream, words: string[]): void {
  let i = 0;
  const step = (): void => {
    if (i < words.length) {
      stream.push({ type: "text", delta: words[i]! });
      i++;
      setTimeout(step, 1);
    } else {
      stream.push({ type: "done", text: words.join("") });
    }
  };
  step();
}

class Ticker {
  log: string[] = [];
  async *[Symbol.asyncIterator](): AsyncIterableIterator<number> {
    try {
      for (let n = 1; n <= 5; n++) {
        this.log.push(`yield ${n}`);
        yield n;
      }
    } finally {
      this.log.push("closed");
    }
  }
}

class Failing {
  async *[Symbol.asyncIterator](): AsyncGenerator<string> {
    yield "first";
    throw new Error("stream failed");
  }
}

async function main(): Promise<void> {
  const stream = new TextStream();
  produce(stream, ["Hello", " from", " the", " stub"]);
  let text = "";
  for await (const event of stream) {
    if (event.type === "text") text += event.delta;
    else console.log("done event", event.text);
  }
  console.log("streamed", JSON.stringify(text), "result", await stream.result());

  // Events queued before iteration starts, then end() with no consumer waiting.
  const early = new TextStream();
  early.push({ type: "text", delta: "a" });
  early.push({ type: "text", delta: "b" });
  early.end("ab");
  const seen: string[] = [];
  for await (const event of early) seen.push(event.type === "text" ? event.delta : "?");
  console.log("queued", seen.join(","), await early.result());

  // break closes the generator: its finally runs before the loop exits.
  const ticker = new Ticker();
  for await (const n of ticker) {
    if (n === 3) break;
  }
  console.log("ticker", ticker.log.join(" | "));

  // A throw from the generator rejects the loop.
  try {
    for await (const s of new Failing()) console.log("got", s);
  } catch (e) {
    console.log("caught", (e as Error).message);
  }
}
main();
