// @exit: 7
// An 'uncaughtException' listener that itself throws ends the process
// through Node's fatal exit (code 7), which emits no 'exit' event: the
// 'exit' listeners, later listeners of the same event, pending ticks and
// timers never run.
process.on("exit", (code) => console.log("exit", code));
process.on("uncaughtException", (error, origin) => {
  console.log("listener", error.message, origin);
  throw new Error("thrown by the listener");
});
process.on("uncaughtException", () => console.log("second listener"));
setTimeout(() => console.log("later timer"), 20);
setTimeout(() => {
  process.nextTick(() => console.log("tick queued by the throwing timer"));
  throw new Error("thrown by a timer");
}, 1);
console.log("started");
