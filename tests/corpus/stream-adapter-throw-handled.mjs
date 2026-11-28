// A checked-dynamic iterator flows into a generator-typed slot, which the
// compiler adapts. A destroy error the source's throw() handles and completes
// must not then be closed with return(): Node throws into the source once.
import { Readable } from "node:stream";

const events = [];
function makeSource() {
  return {
    next() {
      events.push("next");
      return { value: "a", done: false };
    },
    throw(error) {
      events.push(`throw ${error.message}`);
      return { value: undefined, done: true };
    },
    return() {
      events.push("return");
      return { value: undefined, done: true };
    },
    [Symbol.iterator]() {
      return this;
    },
  };
}
const dynSource = makeSource();
/** @type {Generator<string>} */
const typed = dynSource;
const stream = Readable.from(typed);
stream.on("error", (error) => events.push(`error ${error.message}`));
stream.once("data", () => stream.destroy(new Error("boom")));
await new Promise((resolve) => stream.on("close", resolve));
console.log(`events ${events.join(",")}`);
