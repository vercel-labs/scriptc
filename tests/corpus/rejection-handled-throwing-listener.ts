// @exit: 1
// A 'rejectionHandled' listener that throws is an uncaught exception: it
// reaches the program's uncaught path instead of the reactions the attach
// queued, so the timer after it never runs.
const late = Promise.reject(new Error("late"));
process.on("unhandledRejection", () => {
  console.log("unhandled");
  late.catch(() => console.log("caught"));
});
process.on("rejectionHandled", () => {
  throw new Error("listener threw");
});
setTimeout(() => console.log("timer"), 0);
