// process.emit dispatches to the listeners of the exception events, answers
// whether any listener existed, and an event no listener can be registered
// for answers false.
process.on("uncaughtException", (error, origin) => {
  console.log("uncaught", error.message, origin);
});
console.log("emit-uncaught", process.emit("uncaughtException", new Error("boom"), "custom"));
console.log("repeat", process.emit("uncaughtException", new Error("again"), "custom"));

process.on("uncaughtExceptionMonitor", (error) => {
  console.log("monitor", error.message);
});
console.log("emit-monitor", process.emit("uncaughtExceptionMonitor", new Error("mon")));

// A spread builds a fresh argument vector in source order: a listener that
// mutates the caller's array does not change what the next listener sees.
const forwarded = ["value", "first"];
function observe(error, origin) {
  console.log("observe", error, origin);
  forwarded[0] = "mutated";
}
function after(error, origin) {
  console.log("after", error, origin);
}
process.on("uncaughtExceptionMonitor", observe);
process.on("uncaughtExceptionMonitor", after);
console.log("spread", process.emit("uncaughtExceptionMonitor", ...forwarded));
process.removeListener("uncaughtExceptionMonitor", observe);
process.removeListener("uncaughtExceptionMonitor", after);
console.log("caller", forwarded[0]);

// A listener's throw reaches the caller of the emit, as the EventEmitter's
// emit propagates it.
process.on("uncaughtExceptionMonitor", () => {
  throw new Error("listener-throw");
});
try {
  process.emit("uncaughtExceptionMonitor", new Error("throwing"));
} catch (error) {
  console.log("threw", error.message);
}

// The special 'error' event throws: no 'error' listener can be registered
// here. An Error payload throws itself; any other payload throws
// ERR_UNHANDLED_ERROR quoting it.
const thrown = new Error("boom-error");
try {
  process.emit("error", thrown);
} catch (error) {
  console.log("error-same", error === thrown);
}
try {
  process.emit("error", "value");
} catch (error) {
  console.log("error-non", error.code, error.message, error.context);
}
try {
  process.emit("error");
} catch (error) {
  console.log("error-none", error.code, error.message, error.context);
}

console.log("emit-custom", process.emit("custom-event", 1, 2));
console.log("emit-missing", process.emit());
