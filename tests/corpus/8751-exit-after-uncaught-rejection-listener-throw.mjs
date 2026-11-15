// @exit: 7
// The same fatal exit when the error reaches the 'uncaughtException'
// listener from an unhandled rejection: no 'exit' event.
process.on("exit", (code) => console.log("exit", code));
process.on("uncaughtException", (error, origin) => {
  console.log("listener", error.message, origin);
  throw new Error("thrown by the listener");
});
Promise.reject(new Error("rejected"));
console.log("started");
