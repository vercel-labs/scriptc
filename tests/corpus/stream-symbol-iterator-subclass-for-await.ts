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

class Guarded extends Readable {
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
    throw new Error("permission denied");
  }
}

async function take(source: Readable): Promise<number[]> {
  const out: number[] = [];
  for await (const value of source) out.push(value as number);
  return out;
}

async function takeExplicit(source: Readable): Promise<number[]> {
  const out: number[] = [];
  for await (const value of source[Symbol.asyncIterator]()) out.push(value as number);
  return out;
}

console.log("plain-loop", (await take(new Filtering([1, 2, 3, 4]))).join(","));
console.log("explicit-loop", (await takeExplicit(new Filtering([1, 2, 3, 4]))).join(","));
console.log("plain-base", (await take(Readable.from([1, 2, 3, 4]))).join(","));
try {
  await take(new Guarded([1, 2]));
  console.log("guarded", "no-throw");
} catch (e) {
  console.log("guarded", (e as Error).message);
}
