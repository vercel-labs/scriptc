// The control for the fatal exit: an 'uncaughtException' listener that
// returns handles the error, the program goes on, and the 'exit' listeners
// run with the code the program ends with.
process.on("exit", (code) => console.log("exit", code));
process.on("uncaughtException", (error, origin) => console.log("listener", error.message, origin));
setTimeout(() => console.log("later timer"), 20);
setTimeout(() => {
  throw new Error("thrown by a timer");
}, 1);
console.log("started");
