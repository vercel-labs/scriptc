// 'unhandledRejection': the listener receives the reason and the promise
// that rejected (the same promise object the program holds), for error and
// primitive reasons alike, and handling it keeps the process alive. A
// rejected promise the program later observes still delivers exactly once.
process.on("unhandledRejection", (reason, promise) => {
  console.log(
    "rejection",
    reason instanceof Error,
    reason.message,
    promise === rejected,
    typeof promise.then,
  );
});
let rejected;
rejected = Promise.reject(new Error("first"));
Promise.reject("second");
setTimeout(() => console.log("alive"), 20);
