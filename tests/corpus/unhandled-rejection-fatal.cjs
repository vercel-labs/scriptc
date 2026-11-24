// @exit: 1
// An unhandled rejection is fatal even with referenced work keeping the loop
// alive: Node reports it and exits 1 instead of running the interval forever.
setImmediate(() => Promise.reject(new Error("boom")));
setInterval(() => {}, 1000);
setTimeout(() => {
  console.log("still running");
  process.exit(0);
}, 300);
