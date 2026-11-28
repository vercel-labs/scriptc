// The typed spellings walk the same listener map: an on() listener and an
// addEventListener listener count together, emit reaches both, and
// removeAllListeners clears the type.
import { MessageChannel } from "node:worker_threads";

const { port1 } = new MessageChannel();
const f = () => console.log("f called");
port1.on("t", f);
port1.addEventListener("t", (event: any) => console.log("core", event.type));
console.log("count", port1.listenerCount("t"));
console.log("names", port1.eventNames().map(String).join(","));
console.log("emit", port1.emit("t", 3));
console.log("removeAll", port1.removeAllListeners("t") === port1, port1.listenerCount("t"));
console.log("done");
port1.close();
