import { Readable } from "node:stream";

class Base extends Readable {
  private pending: number[];
  constructor(chunks: number[]) {
    super({ objectMode: true });
    this.pending = chunks;
  }
  _read(): void {
    const next = this.pending.shift();
    this.push(next === undefined ? null : next);
  }
}

const source = new Base([1, 2]);
const anySource = source as any;
anySource[Symbol.asyncIterator] = () => ({
  next: async () => ({ value: 99, done: false }),
  [Symbol.asyncIterator]() {
    throw new Error("wrapped-denied");
  },
});

try {
  for await (const value of source[Symbol.asyncIterator]()) console.log("v", value);
} catch (e) {
  console.log("threw", (e as Error).message);
}
