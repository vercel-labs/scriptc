// --stdout-buffering: process.exit must publish buffered stdout before the
// process ends, matching Node's exit flush.
console.log("before-exit");
process.exit(0);
