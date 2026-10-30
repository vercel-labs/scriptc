// A checked-dynamic listener of one meta event beside a typed listener of
// the other: both receive the event name, and the checked-dynamic one also
// the added or removed listener, as in Node.
import { EventEmitter } from "node:events";

const dynamicRemoved: any = (name: unknown, fn: unknown) =>
  console.log("removed", name, typeof fn);
const first = new EventEmitter();
first.on("newListener", (name: string) => console.log("new", name));
first.on("removeListener", dynamicRemoved);
const f = (n: number) => console.log("x", n);
first.on("x", f);
first.emit("x", 1);
first.removeListener("x", f);

const dynamicAdded: any = (name: unknown, fn: unknown) => console.log("added", name, typeof fn);
const second = new EventEmitter();
second.on("newListener", dynamicAdded);
second.on("removeListener", (name: string) => console.log("gone", name));
const g = (s: string) => console.log("y", s);
second.on("y", g);
second.emit("y", "two");
second.off("y", g);
second.removeAllListeners("y");
console.log(first.listenerCount("x"), second.listenerCount("y"));
