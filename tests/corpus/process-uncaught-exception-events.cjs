// @exit: 1
// @no-node-shims
// 'uncaughtException' and its monitor: the monitor sees every uncaught
// exception first and does not handle it, the handler sees the same error
// object and keeps the process alive, and both carry Node's origin string.
// A once-registered monitor fires for the first delivery only; with the
// handler removed the next throw is fatal — the monitor still sees it and
// the 'exit' listener still runs with the fatal status.
let first;
process.once("uncaughtExceptionMonitor", (error, origin) => {
  first = error;
  console.log("monitor", error.message, origin, error instanceof Error);
});
const handler = (error, origin) => {
  console.log(
    "handler",
    error === first,
    origin,
    error.code === undefined,
    error.constructor.name,
  );
  process.exitCode = 0;
};
process.once("uncaughtException", handler);
process.once("exit", (code) => console.log("exit", code));
setTimeout(() => {
  throw new Error("first");
}, 0);
setTimeout(() => {
  console.log("alive");
  process.off("uncaughtException", handler);
}, 10);
setTimeout(() => {
  throw new Error("second");
}, 20);
