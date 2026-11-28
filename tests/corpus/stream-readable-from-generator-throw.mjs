// Destroying a stream read from a compiled generator with an error throws
// that error into the generator, so its catch and finally run, as Node's
// iterator.throw does.
import { Readable } from "node:stream";

const events = [];
const iterable = {
  *[Symbol.iterator]() {
    try {
      yield "a";
      yield "b";
    } catch (error) {
      events.push(`caught ${error.message}`);
    } finally {
      events.push("finally");
    }
  },
};

function open(source) {
  return source[Symbol.iterator]();
}

const stream = Readable.from(open(iterable));
stream.on("error", (error) => events.push(`error ${error.message}`));
stream.once("data", () => stream.destroy(new Error("boom")));
await new Promise((resolve) => stream.on("close", resolve));
console.log(`events ${events.join(",")}`);
