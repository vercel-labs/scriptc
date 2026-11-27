// The explicit Symbol.asyncIterator member dispatches on the instance: a
// Readable subclass that overrides it runs its own iterator when a
// Readable-typed helper receives it, while an exact Readable takes the
// stream's own iterator.
import { Readable } from "node:stream";

class Filtering extends Readable {
  private pending: number[];
  constructor(chunks: number[]) {
    super({ objectMode: true });
    this.pending = chunks;
  }
  _read(): void {
    const next = this.pending.shift();
    this.push(next === undefined ? null : next);
  }
  async *[Symbol.asyncIterator](): AsyncIterableIterator<number> {
    const iterator = this.iterator();
    for (;;) {
      const step = await iterator.next();
      if (step.done) return;
      const value = step.value as number;
      if (value % 2 === 1) yield value;
    }
  }
}

async function collect(source: Readable): Promise<number[]> {
  const iterator = source[Symbol.asyncIterator]();
  const out: number[] = [];
  for (;;) {
    const step = await iterator.next();
    if (step.done) break;
    out.push(step.value as number);
  }
  return out;
}

const filtered = await collect(new Filtering([1, 2, 3, 4]));
console.log("filtered", filtered.join(","));
const plain = await collect(Readable.from([1, 2, 3, 4]));
console.log("plain", plain.join(","));
