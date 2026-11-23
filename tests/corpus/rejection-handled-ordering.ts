// A handler attached after the checkpoint reported a rejection raises
// 'rejectionHandled' on a later turn of the loop, not inside the attach:
// after the ticks and reactions queued ahead of it, before the next timer.
// Two attachments raise one event, and the listener receives a promise.
process.on("unhandledRejection", (reason: any, promise: any) => {
  console.log("unhandled:", reason.message);
  promise.then(
    () => console.log("fulfilled"),
    () => console.log("first reaction"),
  );
  promise.catch(() => console.log("second reaction"));
  process.nextTick(() => console.log("tick queued in the report"));
});
process.on("rejectionHandled", (promise: any) => {
  console.log("handled once:", typeof promise);
});
Promise.reject(new Error("late"));
setTimeout(() => console.log("timer"), 0);
