// @no-node-shims
// process.nextTick keeps Node's schedule: the call answers undefined and
// queues its callback with the trailing arguments; every tick runs before
// the microtask checkpoint, ticks scheduled from a tick or from a
// microtask join the same drain, and the queue drains to exhaustion.
const order = [];

const returned = process.nextTick((a, b, c, d) => {
  order.push(`args:${a}:${b}:${c}:${d}`);
}, "x", 2, true, null);
order.push(`returned:${returned === undefined}`);

process.nextTick(() => {
  order.push("outer");
  process.nextTick(() => order.push("nested"));
  queueMicrotask(() => order.push("micro-from-tick"));
  Promise.resolve().then(() => order.push("promise-from-tick"));
});

queueMicrotask(() => {
  order.push("micro");
  process.nextTick(() => order.push("tick-from-micro"));
});
Promise.resolve().then(() => order.push("promise"));

setTimeout(() => console.log(order.join(",")), 0);
