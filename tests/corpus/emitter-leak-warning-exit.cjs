// @exit: 1
// The MaxListenersExceededWarning of an emitter that passes its limit is
// delivered before the process exits, also in a program with no other
// asynchronous work, once per event name. The 'warning' listener prints it
// (the stderr report carries the pid, so the @exit directive keeps stderr
// out of the comparison).
process.on("warning", (w) => console.log("warning:", w.name, "|", w.message));
const { EventEmitter } = require("events");

const e = new EventEmitter();
e.setMaxListeners(1);
e.on("event-type", () => {});
e.on("event-type", () => {});
e.on("event-type", () => {});
e.on("other", () => {});
e.on("other", () => {});
console.log("added", e.listenerCount("event-type"), e.listenerCount("other"));
process.exitCode = 1;
