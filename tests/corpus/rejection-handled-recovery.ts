// A 'rejectionHandled' listener that throws is an uncaught exception: when
// an uncaughtException handler recovers, the notifications the throw left
// queued are still delivered, in report order, after the handler returns.
const pending: Promise<unknown>[] = [];
for (let i = 0; i < 4; i++) pending.push(Promise.reject(new Error("r" + i)));
let reported = 0;
process.on("unhandledRejection", (_reason: unknown, promise: any) => {
  reported += 1;
  if (reported <= 3) promise.catch(() => {});
});
process.on("rejectionHandled", (promise: any) => {
  let index = -1;
  for (let i = 0; i < pending.length; i++) if (pending[i] === promise) index = i;
  console.log("handled", index);
  if (index === 0) throw new Error("listener throws once");
});
process.on("uncaughtException", (err: unknown) => {
  console.log("uncaught", (err as Error).message);
});
setTimeout(() => console.log("timer"), 20);
