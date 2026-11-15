// --stdout-buffering: an uncaught error must publish buffered stdout before
// the error report, so merged (2>&1) output keeps Node's order.
console.log("before-throw");
throw new Error("buffered-throw");
