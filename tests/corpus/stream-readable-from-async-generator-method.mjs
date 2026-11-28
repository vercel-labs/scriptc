// Readable.from over an object whose async iterator method is a compiled
// async generator reads the values it yields.
import { Readable } from "node:stream";

const iterable = {
  async *[Symbol.asyncIterator]() {
    yield "a";
    yield "b";
  },
};

function open(source) {
  return source[Symbol.asyncIterator]();
}

const out = [];
for await (const chunk of Readable.from(open(iterable))) out.push(String(chunk));
console.log(`out ${out.join(",")}`);
