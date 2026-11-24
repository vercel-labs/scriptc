// 'rejectionHandled' follows the listeners registered when it is
// delivered: one registered inside the 'unhandledRejection' report itself
// still receives it, and the promise it receives is a promise.
const late = Promise.reject(new Error("late"));
process.on("unhandledRejection", () => {
  console.log("unhandled");
  process.on("rejectionHandled", (promise: any) => {
    console.log("late listener ran:", promise instanceof Promise);
  });
  late.catch(() => console.log("caught"));
});
setTimeout(() => console.log("timer"), 0);
