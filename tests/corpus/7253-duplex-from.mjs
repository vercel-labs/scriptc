// Duplex.from in JavaScript: an async generator function, an array, a
// generator object and an async generator object. Over an iterable the
// result is read-only (writable false); over a function it reads what is
// written. The log records the order of the write callbacks, the reads
// and the stream events against each other.
import { Duplex } from "node:stream";

const log = [];

async function* echo(source) {
  for await (const chunk of source) {
    log.push(`echo ${chunk}`);
    yield chunk.toUpperCase();
  }
}

const fromFn = Duplex.from(echo);
fromFn.on("finish", () => log.push("fn finish"));
fromFn.on("end", () => log.push("fn end"));
fromFn.on("close", () => log.push("fn close"));
fromFn.write("one", () => log.push("fn write one cb"));
fromFn.write("two", () => log.push("fn write two cb"));
fromFn.end(() => log.push("fn end cb"));
for await (const chunk of fromFn) log.push(`fn read ${chunk}`);

const fromArray = Duplex.from(["p", "q"]);
log.push(`array ${fromArray.readable} ${fromArray.writable} ${fromArray.readableObjectMode}`);
for await (const chunk of fromArray) log.push(`array ${chunk}`);

function* gen() {
  yield "g1";
  yield "g2";
}
const fromGen = Duplex.from(gen());
log.push(`gen ${fromGen.writable}`);
for await (const chunk of fromGen) log.push(`gen ${chunk}`);

async function* agen() {
  yield 1;
  await null;
  yield 2;
}
const fromAgen = Duplex.from(agen());
fromAgen.on("data", (v) => log.push(`agen data ${v}`));
await new Promise((resolve) => fromAgen.on("end", resolve));
log.push(`agen ended ${fromAgen.readableEnded}`);

console.log(log.join("\n"));
