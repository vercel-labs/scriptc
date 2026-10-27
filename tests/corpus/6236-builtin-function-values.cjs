// Builtin timer functions stored as values (bcryptjs's `nextTick` feature
// probe, async libraries' scheduler selection): conditional, logical and
// assigned values are real functions — typeof answers "function", identity
// holds across spellings, and calls schedule with Node's argument contract
// and ordering.
var nextTick =
  typeof setImmediate === "function"
    ? setImmediate
    : typeof queueMicrotask === "function"
      ? queueMicrotask
      : setTimeout;
const pick = process.argv.length > 100;
const later = pick ? setImmediate : process.nextTick;
const timeout = pick ? setImmediate : setTimeout;
const micro = pick || queueMicrotask;
let assigned = setTimeout;
assigned = pick ? assigned : setImmediate;
const { setInterval: every, clearInterval: stop } = globalThis;
console.log(typeof nextTick, typeof later, typeof timeout, typeof micro, typeof assigned, typeof every);
console.log(nextTick === setImmediate, later === process.nextTick, timeout === setTimeout, micro === queueMicrotask, assigned === globalThis.setImmediate, every === setInterval, stop === clearInterval);
console.log(nextTick.name, later.name, timeout.name, setTimeout.length, queueMicrotask.length);

const order = [];
nextTick(function () { order.push("immediate:" + arguments.length); });
later((a, b) => order.push("tick:" + a + b), 1, 2);
// Microtask and nextTick queues order differently in CommonJS and ESM
// entry evaluation, so the microtask reports through its own flag.
let microRan = false;
micro(() => { microRan = true; });
timeout((x) => order.push("timeout:" + x), 60, "x");
assigned(() => order.push("assigned"));
const cancelled = timeout(() => order.push("cancelled"), 1);
(pick ? clearImmediate : clearTimeout)(cancelled);
// The interval counts its runs apart from `order`, and the report waits until
// it has stopped, so slow machines print the same line.
let count = 0;
const handle = every(() => {
  count++;
  if (count === 2) {
    stop(handle);
    timeout(() => console.log(order.join(" "), "interval:" + count, "micro:" + microRan), 120);
  }
}, 20);

for (const bad of [undefined, 1, "fn"]) {
  try {
    later(bad);
  } catch (e) {
    console.log("rejected", typeof bad, e.code, e instanceof TypeError);
  }
}
const log = pick ? console.error : console.log;
log("log", typeof log);
const mx = pick ? Math.min : Math.max;
console.log(mx(1, 3, 2), typeof mx);
