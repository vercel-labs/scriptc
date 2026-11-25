// An exception-event emit with no listener registered answers false; the
// program still links the runtime unit that defines the dispatch. The special
// 'error' event throws instead, since no 'error' listener can be registered.
console.log("uncaught", process.emit("uncaughtException", new Error("x")));
console.log("monitor", process.emit("uncaughtExceptionMonitor", new Error("y")));
try {
  process.emit("error", new Error("boom"));
} catch (error) {
  console.log("error", error.message);
}
