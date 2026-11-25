// Untyped variadic functions of a JavaScript module, stored in slots the
// program declares and registered as listeners: each call hands them the
// slot's arguments, and an event hands them every argument it carries.
import { EventEmitter } from "node:events";
import { counted, lead, quiet, rest, tally } from "./variadic.mjs";

const two: (a: number, b: string) => void = rest;
two(1, "two");
const none: () => void = counted;
none();
const three: (a: number, b: string, c: boolean) => void = lead;
three(1, "two", true);
function run(f: (a: number, b: string) => void): void {
  f(3, "four");
}
run(rest);
run(counted);
class Box {
  act: (a: number) => void;
  constructor(act: (a: number) => void) {
    this.act = act;
  }
}
new Box(rest).act(5);
const record: { act: (a: number, b: number) => void } = { act: counted };
record.act(6, 7);
const acts: ((a: number) => void)[] = [rest, counted];
for (const act of acts) act(8);

// Listeners receive what the event carries, however many parameters they
// name, and are removed by identity.
const emitter = new EventEmitter();
emitter.on("pair", rest);
emitter.on("pair", counted);
emitter.once("pair", lead);
emitter.emit("pair", 9, "ten");
emitter.off("pair", rest);
emitter.emit("pair", 11, "twelve");
console.log(emitter.listenerCount("pair"));
emitter.on("none", rest);
emitter.emit("none");

// Timers pass their extra arguments. One runs after the other, so the
// order of the lines does not depend on how the two kinds of timer race.
setTimeout(quiet, 0, 13, "fourteen");
setTimeout(tally, 5);
setTimeout(() => setImmediate(tally, 15), 10);
process.nextTick(lead, 16, 17, 18);
