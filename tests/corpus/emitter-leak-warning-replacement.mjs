// A replaced process.emitWarning receives the leak warning itself:
// _addListener calls process.emitWarning(warning) with the
// MaxListenersExceededWarning error, so the replacement sees one argument,
// an Error carrying `emitter`, `type` and `count`, and the default report
// does not run. The replacement output is observed after the warning's
// delivery point so the turn's own statements do not interleave.
import { EventEmitter } from "node:events";

function noop() {}

const bus = new EventEmitter();
bus.setMaxListeners(1);
let seen = 0;
process.emitWarning = function (warning, type, code) {
  seen++;
  console.log("replacement", typeof warning, warning instanceof Error, warning.name);
  console.log("arguments", arguments.length, type, code);
  console.log("fields", String(warning.type), warning.count, warning.emitter === bus);
};

bus.on("data", noop);
bus.on("data", noop);
setTimeout(() => console.log("seen", seen), 0);
