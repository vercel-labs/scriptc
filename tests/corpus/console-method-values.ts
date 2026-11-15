// console's output methods as values: each is one function, callable
// without a receiver and with whatever arguments its caller passes. The
// positions are the ones ordinary programs use: an array iteration
// callback (which receives value, index and array), a destructured or
// aliased binding, bind, a typed function slot, a default parameter, a
// conditional pick, a fallback, an object member, a class field, a
// collection, an event listener and a timer.
import { EventEmitter } from "node:events";

["a", "b"].forEach(console.log);
[1, 2].forEach(console.error);

const { log, error, warn, info, debug } = console;
log("destructured", 1, { a: 1 });
error("to stderr", [1, 2]);
warn("warned", true);
info("info", null);
debug("debug", undefined);

const alias = console.log;
alias("alias", 2);

const bound = console.log.bind(console);
bound("bound", 3);
const tagged = console.error.bind(console, "[tag]");
tagged("bound with an argument", 4);

const typed: (...args: unknown[]) => void = console.warn;
typed("typed slot", 5, false);
type Sink = (message: string) => void;
const sink: Sink = console.log;
sink("one argument");

function each(values: number[], visit: (value: number) => void): void {
  for (const value of values) visit(value);
}
each([6, 7], console.log);

function report(message: string, write: (message: string) => void = console.error): void {
  write(message);
}
report("default parameter");
report("explicit sink", console.log);

function pick(failed: boolean): (...args: unknown[]) => void {
  return failed ? console.error : console.log;
}
pick(false)("picked log");
pick(true)("picked error");

function fallback(write?: (message: string) => void): void {
  const out = write ?? console.log;
  out("fallback");
}
fallback();
fallback((message) => console.log("custom", message));

const sinks = { out: console.log, err: console.error };
sinks.out("member out", 8);
sinks.err("member err", 9);

class Reporter {
  write: (message: string) => void = console.log;
  run(): void {
    this.write("class field");
  }
}
new Reporter().run();

const byLevel = new Map<string, (...args: unknown[]) => void>([
  ["info", console.info],
  ["error", console.error],
]);
byLevel.get("info")!("from a map", 11);
byLevel.get("error")!("from a map", 12);
const list = [console.log, console.warn];
for (const write of list) write("from an array", list.length);

console.log(typeof console.log, typeof console.error === "function", typeof alias);
console.log(console.log === console.log, console.log === console.error, alias === log);
console.log(console.log.name, console.error.name, console.log.length);

const emitter = new EventEmitter();
emitter.on("message", console.log);
emitter.on("failure", console.error);
emitter.emit("message", "event", 13);
emitter.emit("failure", "event", 14);

Promise.resolve("then").then(console.log);
Promise.reject("rejected").then(undefined, console.error);
setTimeout(console.log, 0, "timer", 15);
