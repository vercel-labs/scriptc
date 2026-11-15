// util.debounce and util.throttle answer functions with the documented
// members: debounce has cancel/flush/ref/unref and pending/pendingCount
// getters; throttle has cancel/hasImmediateCapacity/ref/unref and
// pending/pendingCount/activeCount. ref() and unref() answer the function
// itself; pending is the promise of the call in flight and reads null when
// nothing is queued; flush and cancel settle it. Argument validation throws
// as Node's does.
import * as util from "node:util";

function attempt(label: string, run: () => void): void {
  try {
    run();
    console.log(label, "no throw");
  } catch (e: any) {
    console.log(label, e.name, e.code, e.message);
  }
}

const debounced = util.debounce((x: number) => x * 2, 5);
console.log(
  "debounce members",
  typeof debounced.cancel,
  typeof debounced.flush,
  typeof debounced.ref,
  typeof debounced.unref,
  debounced.pending,
  debounced.pendingCount,
);
console.log("debounce ref identity", debounced.ref() === debounced, debounced.unref() === debounced);
debounced.ref();

const first = debounced(1);
console.log("debounce in flight", typeof debounced.pending, debounced.pendingCount, first instanceof Promise);
debounced(2);
console.log("debounce coalesced", debounced.pendingCount, first === debounced.pending);
console.log("debounce flushed", await first);

console.log("debounce settled", debounced.pending, debounced.pendingCount);
const cancelled = debounced(3);
debounced.cancel();
try {
  await cancelled;
} catch (e: any) {
  console.log("debounce cancel", e.name, e.code, e.message);
}

const throttled = util.throttle((x: number) => x, 1, 5);
console.log(
  "throttle members",
  typeof throttled.cancel,
  typeof throttled.hasImmediateCapacity,
  typeof throttled.ref,
  typeof throttled.unref,
  throttled.pending,
  throttled.pendingCount,
  throttled.activeCount,
);
console.log(
  "throttle ref identity",
  throttled.ref() === throttled,
  throttled.unref() === throttled,
  "capacity",
  typeof throttled.hasImmediateCapacity(),
);
throttled.ref();
const running = throttled(1);
console.log("throttle running", typeof throttled.pending, running instanceof Promise);
console.log("throttle values", await running, throttled.pendingCount, throttled.activeCount);

attempt("debounce non-function", () => {
  util.debounce(5 as unknown as (x: number) => number, 5);
});
attempt("debounce negative wait", () => {
  util.debounce((x: number) => x, -1);
});
attempt("throttle bad options", () => {
  util.throttle((x: number) => x, 1, 5, 5 as unknown as util.ThrottleOptions);
});
