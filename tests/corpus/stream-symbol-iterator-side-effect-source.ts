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

const wrapped = new Base([1, 2]);
const anyWrapped = wrapped as any;
anyWrapped[Symbol.asyncIterator] = () => {
  throw new Error("denied");
};

let calls = 0;
function make(): Readable {
  calls += 1;
  return new Base([7, 8]);
}

async function takeDirect(): Promise<number[]> {
  const out: number[] = [];
  for await (const value of make()) out.push(value as number);
  return out;
}

console.log("loop", (await takeDirect()).join(","));
console.log("calls", calls);
try {
  for await (const value of wrapped) console.log("wrapper", value);
} catch (e) {
  console.log("threw", (e as Error).message);
}
