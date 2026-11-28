// Readable.from over a class whose [Symbol.iterator] is a generator method
// calls the method on the instance and reads what it returns.
import { Readable } from "node:stream";

class Source {
  *[Symbol.iterator]() {
    yield 1;
    yield 2;
  }
}

const out = [];
for await (const value of Readable.from(new Source())) out.push(value);
console.log(`out ${out.join(",")}`);
