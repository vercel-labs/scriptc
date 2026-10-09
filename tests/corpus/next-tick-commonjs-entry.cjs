// @no-node-shims
// A CommonJS main module runs synchronously, so the first checkpoint after
// it drains process.nextTick callbacks BEFORE the promise reactions its
// body queued (an ES-module main's awaited evaluation runs them first).
// Every later checkpoint keeps the same tick-then-microtask order.
const order = [];
setTimeout(() => order.push("timeout"), 0);
process.nextTick(() => order.push("tick"));
Promise.resolve()
  .then(() => {
    order.push("then1");
    process.nextTick(() => order.push("tick-in-then"));
  })
  .then(() => order.push("then2"));
queueMicrotask(() => order.push("micro"));
(async () => {
  order.push("async-start");
  await null;
  order.push("async-after-await");
})();
process.nextTick(() => {
  order.push("tick2");
  Promise.resolve().then(() => order.push("then-in-tick"));
  process.nextTick(() => order.push("tick-in-tick"));
});
order.push("sync");
setTimeout(() => {
  process.nextTick(() => order.push("tick-in-timer"));
  Promise.resolve().then(() => order.push("then-in-timer"));
  setTimeout(() => console.log(order.join(",")), 2);
}, 5);
