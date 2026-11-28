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

const source = new Base([1, 2, 3]);
const anySource = source as any;
anySource[Symbol.asyncIterator] = () => {
  let step = 0;
  return {
    next: async () => {
      step += 1;
      return step === 1 ? { value: 42, done: false } : { value: undefined, done: true };
    },
  };
};

const out: number[] = [];
for await (const value of source) out.push(value as number);
console.log("next-only", out.join(","));
