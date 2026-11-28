// `import { nextTick } from "node:process"`: the named import schedules like
// process.nextTick. Callbacks run in registration order with their trailing
// arguments and drain before promise jobs at the loop checkpoint.
import { nextTick } from "node:process";

const order: string[] = [];
nextTick((value: number) => order.push(`named:${value}`), 1);
process.nextTick(() => order.push("member"));
nextTick(() => order.push("named2"));
Promise.resolve().then(() => order.push("promise"));
queueMicrotask(() => order.push("microtask"));

await new Promise<void>((resolve) => setImmediate(resolve));
console.log(order.join(","));
