// Readable.from(obj[Symbol.iterator]()) reads the iterator the method
// returns inline, without an internal compiler error.
import { Readable } from "node:stream";

const iterable = {
  *[Symbol.iterator]() {
    yield 1;
    yield 2;
  },
};

const out = [];
for await (const value of Readable.from(iterable[Symbol.iterator]())) out.push(value);
console.log(`out ${out.join(",")}`);
