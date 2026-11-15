// A timer handle's [Symbol.dispose]() clears the timer it names and answers
// undefined, unlike close(), which answers the handle for chaining. Covers
// both handle kinds, a used result (not only a discarded statement), the
// toPrimitive spelling beside it, `using`, and a mock.timers entry.
import { mock } from "node:test";

const log: string[] = [];

const timeout = setTimeout(() => log.push("timeout fired"), 20);
const timeoutResult = timeout[Symbol.dispose]();
console.log("timeout dispose", timeoutResult === undefined, typeof timeoutResult);
console.log("timeout dispose string", String(timeoutResult));

const immediate = setImmediate(() => log.push("immediate fired"));
const immediateResult = immediate[Symbol.dispose]();
console.log("immediate dispose", immediateResult === undefined, typeof immediateResult);

// close() is the handle-answering spelling beside it.
const chained = setTimeout(() => log.push("chained fired"), 20);
const chainResult = chained.close();
console.log("close returns the handle", chainResult === chained);
chained.close();

// The primitive spelling still answers the id the handle carries.
const primitive = setTimeout(() => log.push("primitive fired"), 20);
console.log("toPrimitive is number", typeof +primitive);
primitive[Symbol.dispose]();

// A `using` declaration disposes through the same member.
{
  using scoped = setTimeout(() => log.push("scoped fired"), 20);
  console.log("scoped handle is truthy", scoped !== undefined);
}

// mock.timers' entries are cleared by the member too, whatever API is
// mocked, and the result stays undefined.
mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
let ticks = 0;
const interval = setInterval(() => {
  ticks++;
}, 5);
const intervalResult = interval[Symbol.dispose]();
const pending = setTimeout(() => log.push("mock timeout fired"), 5);
const pendingResult = pending[Symbol.dispose]();
mock.timers.tick(20);
console.log("mock dispose", intervalResult === undefined, pendingResult === undefined, ticks);
mock.timers.reset();

setTimeout(() => {
  console.log("fired", log.length === 0 ? "nothing" : log.join(", "));
}, 40);
