// A Readable subclass whose instance installs its own [Symbol.asyncIterator]
// wrapper (the program writes the member through an untyped value): the
// explicit call and for-await both run the wrapper, as Node does.
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

function deny(source: any): void {
  source[Symbol.asyncIterator] = () => {
    throw new Error("denied");
  };
}

async function callOf(source: Readable): Promise<string> {
  try {
    const iterator = source[Symbol.asyncIterator]();
    return `call:${typeof iterator.next}`;
  } catch (e) {
    return `call-threw:${(e as Error).message}`;
  }
}

async function loopOf(source: Readable): Promise<string> {
  try {
    const out: number[] = [];
    for await (const value of source) {
      out.push(value as number);
      break;
    }
    return `loop:${out.join(",")}`;
  } catch (e) {
    return `loop-threw:${(e as Error).message}`;
  }
}

const plain = new Base([1, 2]);
console.log(await callOf(plain), await loopOf(plain));
const guarded = new Base([1, 2]);
deny(guarded);
console.log(await callOf(guarded), await loopOf(guarded));
