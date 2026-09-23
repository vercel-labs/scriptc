import { EventEmitter } from "node:events";

const emitter = new EventEmitter();
const middle = process.argv[2] ?? "";
emitter.on(`pre${middle}finish`, () => {});
