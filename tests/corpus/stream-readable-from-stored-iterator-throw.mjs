// Destroying a stream read from a stored iterator throws the error into the
// generator, so its catch and finally run.
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

const iterator = iterable[Symbol.iterator]();
const stream = Readable.from(iterator);
stream.on("error", (error) => events.push(`error ${error.message}`));
stream.once("data", () => stream.destroy(new Error("boom")));
await new Promise((resolve) => stream.on("close", resolve));
console.log(`events ${events.join(",")}`);
