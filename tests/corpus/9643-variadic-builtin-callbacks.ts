// Library functions that hand a variadic callback every argument Node
// passes: event listeners get the event's whole argument list, a promise
// executor both settling functions, timers and process.nextTick their
// extra arguments, and the methods of an array of unknown values the
// element, the index and the array. A function expression that reads
// `arguments.length` where a listener or a callback is expected counts the
// arguments that slot's function type declares.
import { exec } from "node:child_process";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";

function show(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (typeof value === "number" || typeof value === "string" || typeof value === "boolean")
    return typeof value + ":" + String(value);
  if (typeof value === "function") return "function";
  if (Array.isArray(value)) return "array:" + value.length;
  return "object";
}
function seen(args: unknown[]): string {
  let out = "";
  for (let i = 0; i < args.length; i++) out += (i > 0 ? "|" : "") + show(args[i]);
  return args.length + " " + out;
}

// Event listeners: written in place, with a named first parameter, and out
// of a field and an array. Removal is by identity.
const emitter = new EventEmitter();
const held = { listener: (...args: unknown[]): void => console.log("field", seen(args)) };
const listeners = [(...args: unknown[]): void => console.log("element", seen(args))];
emitter.on("pair", (...args: unknown[]) => console.log("rest", seen(args)));
emitter.on("pair", (first: number, ...more: unknown[]) => console.log("lead", first, seen(more)));
emitter.on("pair", held.listener);
emitter.once("pair", listeners[0]!);
emitter.prependListener("pair", function (this: unknown, ...args: unknown[]) {
  console.log("first", typeof this, seen(args));
});
console.log(emitter.emit("pair", 1, "two"));
emitter.off("pair", held.listener);
console.log(emitter.emit("pair", 3, "four"), emitter.listenerCount("pair"));
emitter.on("none", (...args: unknown[]) => console.log("none", seen(args)));
emitter.emit("none");

// A stream's listeners.
const stream = Readable.from(["a", "b"]);
stream.on("data", (...args: unknown[]) => console.log("data", seen(args)));
stream.on("end", (...args: unknown[]) => console.log("end", seen(args)));

// A promise executor receives the two settling functions.
const settled = new Promise<number>((...args: unknown[]) => {
  console.log("executor", seen(args));
  (args[0] as (value: number) => void)(7);
});
settled.then((value) => console.log("settled", value));
const failed = new Promise<number>((first: unknown, ...more: unknown[]) => {
  console.log("executor lead", show(first), seen(more));
  (more[0] as (reason: Error) => void)(new Error("no"));
});
failed.catch((error: Error) => console.log("failed", error.message));

// The methods of an array of unknown values.
const values: unknown[] = JSON.parse('[3,"x",null]') as unknown[];
console.log(values.map((...args: unknown[]) => seen(args)).join(" / "));
values.forEach((...args: unknown[]) => console.log("each", seen(args)));
console.log(values.filter((...args: unknown[]) => args[1] !== 1).length);

// `arguments.length` in a function written where one function type is
// expected is that type's parameter count, also where the slot takes a
// function or something else.
const target = new EventTarget();
target.addEventListener("ping", function () {
  console.log("listener arguments", arguments.length);
});
target.dispatchEvent(new Event("ping"));
exec("echo out", function () {
  console.log("exec arguments", arguments.length);
  // Timers and process.nextTick pass their extra arguments. They start
  // here so that their lines follow the child's.
  setTimeout((...args: unknown[]) => console.log("timeout", seen(args)), 0, 5, "six");
  setTimeout((...args: unknown[]) => console.log("bare timeout", seen(args)), 5);
  process.nextTick((...args: unknown[]) => console.log("tick", seen(args)), 8, 9);
});
