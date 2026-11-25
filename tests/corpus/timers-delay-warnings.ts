// @normalize-pid
// The warnings Node's Timeout constructor emits when it sets a delay to
// 1ms: TimeoutOverflowWarning for each delay past 2^31-1, and
// TimeoutNegativeWarning and TimeoutNaNWarning once per process. They
// arrive on a later tick, so a 'warning' listener added after the timers
// sees them, after the default stderr report. An omitted or undefined
// delay, and delays in range, warn nothing.
const order: string[] = [];

function optional(ms?: number): number | undefined {
  return ms;
}

setTimeout(() => order.push("overflow"), 2 ** 31);
setTimeout(() => order.push("negative"), -5);
setTimeout(() => order.push("negative again"), -0.5);
setTimeout(() => order.push("nan"), Number("x"));
setTimeout(() => order.push("nan again"), NaN);
setTimeout(() => order.push("omitted"));
setTimeout(() => order.push("optional undefined"), optional());
setTimeout(() => order.push("optional overflow"), optional(2 ** 32));
setTimeout(() => order.push("in range"), 1);
setTimeout(() => order.push("zero"), 0);
const interval = setInterval(() => {
  order.push("interval");
  clearInterval(interval);
}, 1e12);

process.on("warning", (warning) => {
  console.log("warning", warning.name, JSON.stringify(warning.message));
});
console.log("registered");

setTimeout(() => console.log(order.join(", ")), 20);
