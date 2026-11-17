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

console.log("emit-custom", process.emit("custom-event", 1, 2));
console.log("emit-missing", process.emit());
