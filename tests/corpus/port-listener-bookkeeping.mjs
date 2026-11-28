// A MessagePort keeps one listener map for its EventTarget and EventEmitter
// spellings, as Node's NodeEventTarget does: listenerCount counts both kinds
// (and ignores a listener argument), eventNames lists the types in
// first-registration order, off removes an addEventListener listener,
// removeAllListeners clears the type from both, and emit reaches both kinds
// with Node's argument shapes.
import { MessageChannel } from "node:worker_threads";

const { port1, port2 } = new MessageChannel();
const f = () => console.log("f called");
const g = () => console.log("g called");
const show = (label, fn) => {
  try {
    console.log(label, JSON.stringify(fn()));
  } catch (error) {
    console.log(label, "THROWS", error.name, error.code || "", JSON.stringify(error.message));
  }
};
port1.on("a", f);
port1.addEventListener("a", g);
show("count a", () => port1.listenerCount("a"));
show("count a f", () => port1.listenerCount("a", f));
show("count a other", () => port1.listenerCount("a", () => {}));
port1.on("b", f);
port1.addEventListener("c", g);
port1.on("d", g);
show("names", () => port1.eventNames().map(String));
port1.removeListener("a", g);
show("count a after off g", () => port1.listenerCount("a"));
port1.addEventListener("e", (event) => console.log("core e", event.type, event instanceof Event));
port1.on("e", (value) => console.log("registry e", value));
show("emit e", () => port1.emit("e", 7));
const onceEvent = new Event("w");
port1.addEventListener("w", g, { once: true });
show("names w", () => port1.eventNames().map(String));
port1.dispatchEvent(onceEvent);
show("count w after firing", () => port1.listenerCount("w"));
show("names w after firing", () => port1.eventNames().map(String));
port1.addEventListener("x", f);
port1.on("x", g);
show("count x", () => port1.listenerCount("x"));
show("removeAll x", () => port1.removeAllListeners("x") === port1);
show("count x after", () => port1.listenerCount("x"));
show("names after x", () => port1.eventNames().map(String));
port1.addEventListener("message", f);
port1.removeAllListeners("message");
show("count message after removeAll", () => port1.listenerCount("message"));
port2.postMessage("nobody hears this");
await new Promise((resolve) => setTimeout(resolve, 20));
port1.removeAllListeners();
show("names after all", () => port1.eventNames().map(String));
console.log("done");
port1.close();
port2.close();
