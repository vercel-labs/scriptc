// @exit: 1
// An unhandled rejection keeps Node 24's default throw-mode behaviour: the
// reason is reported on stderr and the process exits 1 at the end of the
// turn, so work queued for a later turn (a timer here) never runs.
Promise.reject(new Error("network"));
setTimeout(() => console.log("still here"), 100);
console.log("sync done");
