// Duplex.from over a compiled generator reaches the generator's members
// through the program's getters, so its first chunk reads.
import { Duplex } from "node:stream";

const iterable = {
  *[Symbol.iterator]() {
    yield "a";
    yield "b";
  },
};

function open(source) {
  return source[Symbol.iterator]();
}

const out = [];
for await (const chunk of Duplex.from(open(iterable))) out.push(String(chunk));
console.log(`out ${out.join(",")}`);
