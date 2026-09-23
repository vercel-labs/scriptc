import { EventEmitter } from "node:events";

const emitter = new EventEmitter();
const name = process.argv[2] ?? "topic";
emitter.on(name, () => {});
