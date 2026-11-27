// Readable.from over an object whose iterator method is a compiled
// generator reads the values the generator yields, in order.
import { Readable } from "node:stream";

const iterable = {
  *[Symbol.iterator]() {
    yield 1;
    yield 2;
  },
};

const out = [];
for await (const value of Readable.from(iterable)) out.push(value);
console.log(`sync ${out.join(",")}`);
