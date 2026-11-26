import { EventEmitter } from "node:events";
const e = new EventEmitter();
function a(): void {}
function b(): void {}
e.on("x", a);
e.once("x", b);
const ls = e.listeners("x");
console.log("copy", ls.length, ls[0] === a, ls[1] === b, e.listeners("x") !== ls);
const raw = e.rawListeners("x");
console.log("raw", raw.length, raw[0] === a, typeof raw[1]);
const sym = Symbol("s");
e.on(sym, a);
console.log("symbol", e.listeners(sym).length, e.listenerCount(sym));
const order: string[] = [];
const e2 = new EventEmitter();
e2.on("newListener", (name: unknown) => {
  order.push("new:" + String(name));
  if (String(name) === "trigger") e2.on("added", a);
});
e2.on("removeListener", (name: unknown) => order.push("remove:" + String(name)));
e2.on("trigger", a);
console.log("inside", e2.listeners("added").length, order.join(","));
e2.removeAllListeners("trigger");
console.log("removed", e2.listeners("trigger").length);
const e3 = new EventEmitter();
let fired = 0;
e3.once("once", () => {
  fired += 1;
});
e3.on("removeListener", (name: unknown) => order.push("onceRemove:" + String(name)));
e3.emit("once");
console.log("once", fired, e3.listeners("once").length, order.includes("onceRemove:once"));
