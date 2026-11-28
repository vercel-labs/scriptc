import { Readable } from "node:stream";

class Evens extends Readable {
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
      if (value % 2 === 0) yield value;
    }
  }
}

async function firstKeeping(source: Readable): Promise<string> {
  const iterator = source.iterator({ destroyOnReturn: false });
  const out: number[] = [];
  for await (const value of iterator) {
    out.push(value as number);
    break;
  }
  return `${out.join(",")}:${source.destroyed}`;
}

async function firstDestroying(source: Readable): Promise<string> {
  const iterator = source.iterator({ destroyOnReturn: true });
  const out: number[] = [];
  for await (const value of iterator) {
    out.push(value as number);
    break;
  }
  return `${out.join(",")}:${source.destroyed}`;
}

console.log("plain-false", await firstKeeping(Readable.from([1, 2, 3])));
console.log("plain-true", await firstDestroying(Readable.from([1, 2, 3])));
console.log("subclass-false", await firstKeeping(new Evens([1, 2, 3, 4])));
console.log("subclass-true", await firstDestroying(new Evens([1, 2, 3, 4])));
const looped: number[] = [];
for await (const value of new Evens([1, 2, 3, 4])) looped.push(value as number);
console.log("symbol-loop", looped.join(","));
