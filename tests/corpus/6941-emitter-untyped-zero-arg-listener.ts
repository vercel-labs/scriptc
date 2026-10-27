// Emitting through an `any` reference reaches listeners that typed code
// registered with no parameters, for an event no typed code emits: they
// run once per emit, whatever arguments the untyped emit passes.

import { EventEmitter } from "node:events";

const emitter = new EventEmitter();
let ready = 0;
emitter.on("ready", () => {
  ready++;
  console.log("ready", ready);
});
emitter.once("closed", function () {
  console.log("closed once");
});

const loose: any = emitter;
console.log(loose.emit("ready"));
console.log(loose.emit("ready", 1, "two"));
console.log(loose.emit("closed", { reason: "done" }));
console.log(loose.emit("closed"));
console.log(loose.emit("missing"));
console.log(emitter.listenerCount("ready"), emitter.listenerCount("closed"), ready);
