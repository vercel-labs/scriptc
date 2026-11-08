// @exit: 1
// The leak warning's `emitter` property is a live reference to the emitter:
// emitting through it reaches the listeners typed code registered, with the
// arguments converted to their parameters. The default report prints the pid
// on stderr, so the @exit directive keeps stderr out of the comparison.
import { EventEmitter } from "node:events";

const bus = new EventEmitter();
bus.setMaxListeners(1);
bus.on("data", (value: number) => {
  console.log("listener", value, typeof value);
});
process.on("warning", (warning: Error) => {
  console.log("warning", warning.name);
  const emitter = (warning as any).emitter;
  console.log("fired", emitter.emit("data", 41));
});
bus.on("data", () => {});
bus.on("data", () => {});
process.exitCode = 1;
