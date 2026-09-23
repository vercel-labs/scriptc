import { EventEmitter } from "node:events";

const emitter = new EventEmitter();
emitter.on("newListener", (name: string) => console.log(name));
const suffix = process.argv[2] ?? "Listener";
emitter.emit(`new${suffix}`, "topic");
