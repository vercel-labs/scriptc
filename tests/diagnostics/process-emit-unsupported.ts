// process.emit reaches the exception events and the signal family only: the
// typed listener families, the families whose emit carries default handling
// of its own, and a computed event name are refused.
process.emit("exit", 0);
process.emit("warning", new Error("w"));
const eventName = "uncaughtException";
process.emit(eventName, new Error("e"));
