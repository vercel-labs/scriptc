// queueMicrotask taken as a typed function value queues like a direct call.
const schedule: (callback: () => void) => void = queueMicrotask;
const order: string[] = [];

schedule(() => order.push("first"));
Promise.resolve().then(() => order.push("promise"));
schedule(() => order.push("second"));
queueMicrotask(() => order.push("direct"));
order.push("sync");

setTimeout(() => console.log(order.join(" ")), 0);

function later(run: (callback: () => void) => void, label: string): void {
  run(() => console.log("ran", label));
}
later(schedule, "through a parameter");
