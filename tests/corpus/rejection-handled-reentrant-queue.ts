// A 'rejectionHandled' listener that handles two more rejections the
// checkpoint already reported queues their events in the same checkpoint
// without disturbing the events still due in this one: one event per
// promise, in report order.
const pending: Promise<unknown>[] = [];
for (let i = 0; i < 4; i++) pending.push(Promise.reject(new Error("r" + i)));

let reported = 0;
let events = 0;
const late: any[] = [];

process.on("unhandledRejection", (_reason: any, promise: any) => {
  reported += 1;
  if (reported <= 2) promise.catch(() => {});
  else late.push(promise);
});

process.on("rejectionHandled", (promise: any) => {
  events += 1;
  for (let i = 0; i < pending.length; i++) {
    if (pending[i] === promise) console.log("event for", i);
  }
  if (events === 1) {
    for (const p of late) p.catch(() => {});
  }
});

setTimeout(() => console.log("events", events), 10);
