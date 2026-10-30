// listeners() and rawListeners() from TypeScript of an event registered
// under a computed name: the registered functions in order.
import { EventEmitter } from "node:events";

const emitter = new EventEmitter();
const suffix = process.argv[2] ?? "x";
const onTopic = (): void => console.log("topic listener");
emitter.on(`topic:${suffix}`, onTopic);
emitter.on(`topic:${suffix}`, () => console.log("second"));
console.log(emitter.listeners("topic:x").length, emitter.listeners("topic:x")[0] === onTopic);
for (const l of emitter.listeners("topic:x")) l();
console.log(emitter.listeners("topic:y").length);
emitter.off("topic:x", onTopic);
console.log(emitter.rawListeners("topic:x").length);
