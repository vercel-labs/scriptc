// The module's mock.timers outside a test: a debounce and a retry loop
// driven by tick and runAll, the order due timers run in, intervals that
// clear themselves, setTime, Node's errors, and real timers made before
// enable() that keep running through the loop.
import { mock } from "node:test";

function debounce(fn: (value: string) => void, ms: number): (value: string) => void {
  let pending: ReturnType<typeof setTimeout> | null = null;
  return (value: string) => {
    if (pending !== null) clearTimeout(pending);
    pending = setTimeout(() => {
      pending = null;
      fn(value);
    }, ms);
  };
}

const real = setTimeout(() => console.log("real timer fired"), 1);

mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
clearTimeout(real); // the mocked clearTimeout leaves the real timer armed

const save = debounce((value) => console.log(`saved ${value}`), 100);
save("a");
mock.timers.tick(50);
save("ab");
mock.timers.tick(99);
console.log("nothing saved yet");
save("abc");
mock.timers.tick(100);

let attempts = 0;
function attempt(delay: number): void {
  attempts++;
  console.log(`attempt ${attempts} after ${delay}ms`);
  if (attempts < 4) setTimeout(() => attempt(delay * 2), delay * 2);
}
setTimeout(() => attempt(10), 10);
mock.timers.runAll();
console.log(`runAll stopped after ${attempts} attempts`);
mock.timers.runAll();
mock.timers.runAll();
mock.timers.runAll();
console.log(`attempts ${attempts}`);

const order: string[] = [];
setTimeout(() => order.push("omitted"));
setTimeout(() => order.push("zero"), 0);
setTimeout(() => order.push("negative"), -1);
setTimeout((tag: string) => order.push(tag), 0, "zero with argument");
mock.timers.tick(0);
console.log(order.join(", "));

let beats = 0;
const heartbeat = setInterval(() => {
  beats++;
  if (beats === 5) clearInterval(heartbeat);
}, 30);
mock.timers.tick(1000);
console.log(`beats ${beats}`);

const handle = setTimeout(() => console.log("refreshed timer fired once"), 20);
console.log(handle.hasRef(), handle.unref().hasRef(), handle.ref().hasRef());
handle.refresh();
mock.timers.tick(20);
mock.timers.tick(20);

mock.timers.setTime(1_000_000);
setTimeout(() => console.log("fires after setTime"), 1);
mock.timers.tick(1);

for (const run of [
  () => mock.timers.enable({ apis: ["setTimeout"] }),
  () => mock.timers.tick(-2),
  () => mock.timers.setTime(-0.5),
]) {
  try {
    run();
  } catch (error) {
    const e = error as { name: string; code: string; message: string };
    console.log(`${e.name} ${e.code}: ${e.message}`);
  }
}

mock.timers.reset();
try {
  mock.timers.runAll();
} catch (error) {
  console.log((error as Error).message);
}
setTimeout(() => console.log("real again after reset"), 30);
