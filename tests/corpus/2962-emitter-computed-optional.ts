import { EventEmitter } from "node:events";

const emitter: EventEmitter | undefined = process.argv.length > 100 ? undefined : new EventEmitter();
const suffix = process.argv[2] ?? "x";
emitter?.on(`topic:${suffix}`, (value: string) => console.log(value));
console.log(emitter?.emit("topic:x", "payload"));
