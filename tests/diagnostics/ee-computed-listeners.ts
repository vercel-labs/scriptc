import { EventEmitter } from "node:events";

const emitter = new EventEmitter();
const suffix = process.argv[2] ?? "x";
emitter.on(`topic:${suffix}`, () => {});
emitter.listeners("topic:x");
