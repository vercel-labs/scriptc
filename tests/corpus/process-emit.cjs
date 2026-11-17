// @normalize-pid
// process.emit(event, ...args) with no listener: Node's EventEmitter answers
// false for an event nothing registered and runs nothing, an unhandled
// 'error' event throws (the Error itself is rethrown, anything else becomes
// ERR_UNHANDLED_ERROR), and the 'warning' channel answers true because the
// default report listener is always registered — a non-Error warning is
// ignored by that report and nothing prints.
console.log(process.emit());
console.log(process.emit(123));
console.log(process.emit("nope", 1));
console.log(process.emit("uncaughtException", new Error("quiet")));
console.log(process.emit("warning", "plain text"));
console.log(process.emit("warning", new Error("werr")));
try {
  process.emit("error", "x");
} catch (error) {
  console.log("err", error.code, error.message);
}
try {
  process.emit("error", new Error("E"));
} catch (error) {
  console.log("rethrow", error.message);
}
