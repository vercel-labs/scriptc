// node:readline's prependListener and prependOnceListener register at the
// FRONT of an event's list, so they run before the listeners already there;
// a prepended once listener still leaves after its one call. The async
// iterator's own 'line', 'error' and 'close' listeners are listeners too:
// listenerCount and eventNames see them while a line is being awaited.
import * as readline from "node:readline";
import { PassThrough, Readable } from "node:stream";

const input = new PassThrough();
const rl = readline.createInterface({ input, terminal: false });
const order: string[] = [];
const first = (line: string): void => {
  order.push("first:" + line);
};
const second = (line: string): void => {
  order.push("second:" + line);
};
const prepended = (line: string): void => {
  order.push("prepended:" + line);
};
const oncePrepended = (line: string): void => {
  order.push("once:" + line);
};

rl.on("line", first);
console.log("chain", rl.prependListener("line", second).prependOnceListener("line", oncePrepended) === rl);
rl.prependListener("line", prepended);
console.log("counts", rl.listenerCount("line"), rl.listenerCount("line", oncePrepended));
console.log("names", JSON.stringify(rl.eventNames()));

input.write("one\n");
input.write("two\n");

rl.on("close", () => {
  console.log("order", JSON.stringify(order));
  console.log("counts at close", rl.listenerCount("line"), rl.listenerCount("line", oncePrepended));
});
input.end();

const src = new Readable({ read() {} });
const iterated = readline.createInterface({ input: src, terminal: false });
setTimeout(() => src.push("x\n"), 5);
for await (const line of iterated) {
  console.log(
    "iterating",
    line,
    iterated.listenerCount("line"),
    iterated.listenerCount("close"),
    iterated.listenerCount("error"),
    JSON.stringify(iterated.eventNames()),
  );
  break;
}
console.log(
  "after break",
  JSON.stringify(iterated.eventNames()),
  iterated.listenerCount("line"),
  iterated.listenerCount("close"),
);
src.push(null);
iterated.on("close", () => console.log("iterated closed", JSON.stringify(iterated.eventNames())));
