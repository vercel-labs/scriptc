// Drain registration on the process streams lowers to nothing because a
// synchronous write never asks for a drain; the listener table it would
// fill is not observable, so reading it stays refused.
process.stdout.once("drain", () => {});
console.log(process.stdout.listenerCount("drain"));
