// The launch never reaches this file: the fork's cwd does not exist. It is
// here so `fork(worker)` has a real fork target to compile.
console.log("worker ran");
