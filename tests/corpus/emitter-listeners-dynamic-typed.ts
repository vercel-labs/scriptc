// listeners() and rawListeners() from TypeScript of an event with a typed
// listener and a checked-dynamic one: each element is the registered
// function, called with the event's arguments.
import { EventEmitter } from "node:events";
const e = new EventEmitter();
const typed = (n: number, s: string): void => console.log("typed", n, s);
const loose = ((...args: unknown[]) => console.log("loose", args.length)) as any;
e.on("tick", typed);
e.on("tick", loose);
e.emit("tick", 1, "one");
console.log(e.listeners("tick").length, e.listeners("tick")[0] === typed, e.rawListeners("tick")[1] === loose);
for (const l of e.listeners("tick")) (l as (n: number, s: string) => void)(2, "two");
e.off("tick", typed);
e.emit("tick", 3, "three");
console.log(e.listenerCount("tick"), e.listeners("tick").length);
