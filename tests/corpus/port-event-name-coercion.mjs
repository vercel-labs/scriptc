// An object event name is converted once: the string the addEventListener
// registration uses is the one that counts, lists and removes, so a toString
// that throws on a second call never sees one.
import { MessageChannel } from "node:worker_threads";

const { port1 } = new MessageChannel();
const listener = () => console.log("called");
let calls = 0;
const name = {
  toString() {
    calls++;
    if (calls > 1) throw new Error("coerced twice");
    return "obj";
  },
};
port1.addEventListener(name, listener);
console.log("calls", calls);
console.log("count", port1.listenerCount("obj"));
console.log("names", port1.eventNames().map(String).includes("obj"));
port1.removeEventListener({ toString: () => "obj" }, listener);
console.log("count after remove", port1.listenerCount("obj"));
let onCalls = 0;
const onName = {
  toString() {
    onCalls++;
    if (onCalls > 1) throw new Error("coerced twice");
    return "on-obj";
  },
};
port1.on(onName, listener);
console.log("on calls", onCalls, port1.listenerCount("on-obj"));
port1.close();
console.log("done");
