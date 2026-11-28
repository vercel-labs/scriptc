// Request setup creates a promise, and an async_hooks init callback is
// program code that can release another request on the same name, which
// frees the name's emptied state; the new request must still find the
// current state when it joins it.
import { createHook } from "node:async_hooks";
import { locks } from "node:worker_threads";

let ready = false;
const controller = new AbortController();
const hook = createHook({
  init() {
    if (!ready) return;
    ready = false;
    controller.abort();
  },
});
hook.enable();
const first = locks.request("hooked", { signal: controller.signal }, () => "first");
first.catch(() => {});
ready = true;
const second = locks.request("hooked", () => "second");
console.log("second", await second);
console.log("first rejected", await first.catch((error) => error.name));
await new Promise((resolve) => setTimeout(resolve, 10));
console.log("held", (await locks.query()).held.length);
